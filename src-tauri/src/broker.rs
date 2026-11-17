use crate::native;
use crate::requests::{self, AccessRequest, Queue};
use argon2::{password_hash::SaltString, Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use chrono::Utc;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub models: Vec<String>,
    pub daily_budget: f64,
    pub duration: Option<String>,
    pub expires: Option<String>,
    pub created_at: String,
    pub key_hash: String,
    #[serde(default = "active")]
    pub status: String,
    #[serde(default)]
    pub spend: f64,
    #[serde(default)]
    pub reasons: Vec<String>,
}
fn active() -> String {
    "active".into()
}
fn reasons_match(existing: &[String], requested: &[String]) -> bool {
    // Omission keeps ordinary reuse frictionless. An explicit edit must reach review.
    requested.is_empty()
        || existing.iter().collect::<BTreeSet<_>>() == requested.iter().collect::<BTreeSet<_>>()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    gateway: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub source: String,
    pub protocol: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    gateway: String,
    connected: bool,
    message: Option<String>,
    platform: String,
    credential_store: String,
    native_auth: bool,
    pin_configured: bool,
    models: Vec<Model>,
    projects: Vec<Project>,
}

pub struct Broker {
    pub(crate) directory: PathBuf,
    settings: Mutex<Settings>,
    mutation: Mutex<()>,
    pin_failures: Mutex<(u8, i64)>,
    client: Client,
    _desktop_lock: Option<fs::File>,
}

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn issuance_body(request: &GrantRequest, models: &[String], identity: &str) -> Value {
    // LiteLLM requires globally unique aliases, including while the old grant is active.
    let mut body = json!({
        "key_alias": format!("zerokey/{}/{}", request.name.trim(), uuid::Uuid::new_v4()),
        "models": models,
        "max_budget": request.daily_budget,
        "budget_duration": "1d",
        "key_type": "llm_api",
        "metadata": { "managed_by": "ZeroKey", "project": identity, "reasons": request.reasons }
    });
    if let Some(duration) = &request.duration {
        body["duration"] = json!(duration);
    }
    body
}

fn gateway_error(code: u16, body: &Value) -> String {
    // Classify only known fields. Gateway messages may contain credentials or request bodies.
    match code {
        400 => match body["error"]["param"].as_str() {
            Some("key_alias") => "网关中已存在同名凭证，请更新 ZeroKey 后重新授权。".into(),
            Some("max_budget") => "网关拒绝了预算设置，请检查 LiteLLM 的预算上限与账户额度。".into(),
            _ => "网关拒绝了请求参数（HTTP 400），请检查模型、预算或有效期配置。".into(),
        },
        401 => "网关拒绝了凭证，请检查连接或重新授权。".into(),
        403 => "当前凭证没有这个模型或操作的权限。".into(),
        402 | 422 => "预算或套餐额度不足，请检查网关与来源账户。".into(),
        _ => format!("网关请求失败（HTTP {code}），请稍后重试。"),
    }
}

fn key_status(info: &Value) -> String {
    if info["blocked"].as_bool() == Some(true) {
        return "blocked".into();
    }
    if let Some(expires) = info["expires"]
        .as_str()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
    {
        if expires <= Utc::now() {
            return "expired".into();
        }
    }
    info["status"].as_str().unwrap_or("active").into()
}

pub(crate) fn safe_write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let data = serde_json::to_vec_pretty(value).map_err(|_| "无法保存配置信息。")?;
    fs::write(&temporary, data).map_err(|_| "无法写入应用配置。")?;
    if let Err(_error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err("无法更新应用配置，现有凭证未改变。".into());
    }
    Ok(())
}

fn validate_gateway(value: &str) -> Result<String, String> {
    let url = Url::parse(value.trim()).map_err(|_| "请输入有效的网关地址。")?;
    let local = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if !(url.scheme() == "https" || (local && url.scheme() == "http"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("网关使用 HTTPS；仅本机地址允许 HTTP。请填写不含密钥或路径的根地址。".into());
    }
    Ok(value.trim().trim_end_matches('/').into())
}

impl Broker {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let directory = app.path().app_data_dir()?;
        let mut broker = Self::at(directory)?;
        broker._desktop_lock = Some(requests::try_lock(&broker.directory, "desktop.lock")?);
        Ok(broker)
    }

    fn at(directory: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        fs::create_dir_all(&directory)?;
        let settings_path = directory.join("settings.json");
        let settings: Settings = match fs::read(&settings_path) {
            Ok(data) => serde_json::from_slice(&data)
                .map_err(|_| "CONFIG_INVALID: 网关配置格式不正确，请打开设置重新连接。")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings {
                gateway: "http://127.0.0.1:4000".into(),
            },
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(
                    "CONFIG_ACCESS_DENIED: 当前进程无法读取配置，请在正常桌面会话中运行 ZeroKey。"
                        .into(),
                )
            }
            Err(_) => {
                return Err("CONFIG_READ_FAILED: 无法读取配置，请打开设置检查本机数据目录。".into())
            }
        };
        // Existing development gateway configuration is imported only in the trusted Rust process.
        // Packaged users connect through Settings; upstream secrets are never sent to the webview.
        if cfg!(debug_assertions)
            && native::read_secret("gateway-master")
                .ok()
                .flatten()
                .is_none()
        {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join(".env");
            if let Ok(text) = fs::read_to_string(path) {
                if let Some(master) = text
                    .lines()
                    .find_map(|line| line.strip_prefix("LITELLM_MASTER_KEY="))
                {
                    let _ = native::write_secret("gateway-master", master.trim());
                }
            }
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        Ok(Self {
            directory,
            settings: Mutex::new(settings),
            mutation: Mutex::new(()),
            pin_failures: Mutex::new((0, 0)),
            client,
            _desktop_lock: None,
        })
    }

    pub fn tray_summary(&self) -> Result<(bool, usize, usize, f64), String> {
        let connected = self.models().is_ok();
        let projects = self.projects()?;
        let mut active = 0;
        let mut spend = 0.0;
        if connected {
            for project in &projects {
                if let Ok(info) =
                    self.api(Method::GET, &format!("/key/info?key={}", project.key_hash))
                {
                    if key_status(&info["info"]) == "active" {
                        active += 1;
                    }
                    spend += info["info"]["spend"].as_f64().unwrap_or(0.0);
                }
            }
        }
        Ok((connected, projects.len(), active, spend))
    }

    fn base(&self) -> Result<String, String> {
        self.settings
            .lock()
            .map(|settings| settings.gateway.clone())
            .map_err(|_| "配置正忙，请重试。".into())
    }
    fn projects(&self) -> Result<Vec<Project>, String> {
        let path = self.directory.join("projects.json");
        match fs::read(path) {
            Ok(data) => serde_json::from_slice(&data)
                .map_err(|_| "项目记录损坏，请保留文件并检查配置。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(_) => Err("无法读取项目记录。".into()),
        }
    }
    fn save_projects(&self, projects: &[Project]) -> Result<(), String> {
        safe_write(&self.directory.join("projects.json"), &projects)
    }
    fn revoke_project(&self, id: &str) -> Result<(), String> {
        let _lock = self
            .mutation
            .try_lock()
            .map_err(|_| "另一个授权操作正在进行。")?;
        let _process_lock = requests::try_lock(&self.directory, "mutation.lock")?;
        let mut projects = self.projects()?;
        let project = projects
            .iter()
            .find(|project| project.id == id)
            .ok_or("找不到项目授权。")?;
        self.api_body(
            Method::POST,
            "/key/delete",
            Some(json!({"keys":[project.key_hash]})),
            None,
        )?;
        native::delete_secret(&format!("project/{id}"))?;
        projects.retain(|project| project.id != id);
        self.save_projects(&projects)
    }
    fn api(&self, method: Method, path: &str) -> Result<Value, String> {
        self.api_body(method, path, None, None)
    }
    fn api_body(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: Option<&str>,
    ) -> Result<Value, String> {
        let token = match token {
            Some(value) => value.to_owned(),
            None => native::read_secret("gateway-master")?
                .ok_or("CREDENTIAL_MISSING: 请在设置中连接 LiteLLM 网关。")?,
        };
        tauri::async_runtime::block_on(async {
            let mut request = self
                .client
                .request(method, self.base()? + path)
                .bearer_auth(&token)
                .header("User-Agent", "ZeroKey-Desktop/0.1");
            if path.starts_with("/v1/") {
                request = request.header(
                    "x-litellm-session-id",
                    format!("ses_zerokey_{}", uuid::Uuid::new_v4()),
                );
            }
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = request
                .send()
                .await
                .map_err(|_| "GATEWAY_UNAVAILABLE: 无法连接网关，请检查地址和服务是否运行。")?;
            let code = response.status();
            if !code.is_success() {
                let detail = response.json::<Value>().await.unwrap_or(Value::Null);
                return Err(gateway_error(code.as_u16(), &detail));
            }
            response
                .json()
                .await
                .map_err(|_| "网关返回了无法识别的数据。".into())
        })
    }
    fn models(&self) -> Result<Vec<Model>, String> {
        let info = self.api(Method::GET, "/model/info")?;
        let mut models = Vec::new();
        for row in info["data"].as_array().into_iter().flatten() {
            let Some(id) = row["model_name"].as_str() else {
                continue;
            };
            let source = row["model_info"]["source"]
                .as_str()
                .or_else(|| id.split_once('/').map(|(source, _)| source))
                .unwrap_or("gateway")
                .to_string();
            let protocol = if id.contains("gpt-image") {
                "images"
            } else {
                row["model_info"]["api_family"]
                    .as_str()
                    .or_else(|| row["model_info"]["mode"].as_str())
                    .unwrap_or("chat-completions")
            }
            .to_string();
            models.push(Model {
                id: id.to_string(),
                source,
                protocol,
            });
        }
        models.sort_by(|a, b| a.id.cmp(&b.id));
        models.dedup_by(|a, b| a.id == b.id);
        Ok(models)
    }
    fn authorize(&self, message: &str, pin: Option<&str>, owner: isize) -> Result<(), String> {
        if native::hello_available() {
            return native::verify_native(message, owner);
        }
        let mut failures = self.pin_failures.lock().map_err(|_| "授权正忙。")?;
        let now = Utc::now().timestamp();
        if failures.0 >= 5 && now - failures.1 < 300 {
            return Err("PIN 错误次数过多，请五分钟后重试。".into());
        }
        let encoded = native::read_secret("authorization-pin")?
            .ok_or("请先在设置中配置本机 ZeroKey 授权 PIN。")?;
        let parsed =
            PasswordHash::new(&encoded).map_err(|_| "授权 PIN 配置不可用，请重新设置。")?;
        if Argon2::default()
            .verify_password(pin.unwrap_or("").as_bytes(), &parsed)
            .is_err()
        {
            if now - failures.1 >= 300 {
                failures.0 = 0;
            }
            failures.0 += 1;
            failures.1 = now;
            return Err("授权 PIN 不正确；没有签发凭证。".into());
        }
        *failures = (0, 0);
        Ok(())
    }
}

#[tauri::command]
pub async fn snapshot(state: State<'_, Arc<Broker>>) -> Result<Snapshot, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let model_result = state.models();
        let connected = model_result.is_ok();
        let message = model_result.as_ref().err().cloned();
        let mut projects = state.projects()?;
        if connected {
            for project in &mut projects {
                if let Ok(info) =
                    state.api(Method::GET, &format!("/key/info?key={}", project.key_hash))
                {
                    project.status = key_status(&info["info"]);
                    project.spend = info["info"]["spend"].as_f64().unwrap_or(0.0);
                    project.expires = info["info"]["expires"].as_str().map(String::from);
                } else {
                    project.status = "unknown".into();
                }
            }
        }
        Ok(Snapshot {
            gateway: state.base()?,
            connected,
            message,
            platform: std::env::consts::OS.into(),
            credential_store: native::credential_store_name().into(),
            native_auth: native::hello_available(),
            pin_configured: native::read_secret("authorization-pin")?.is_some(),
            models: model_result.unwrap_or_default(),
            projects,
        })
    })
    .await
    .map_err(|_| "无法读取桌面状态。".to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    name: String,
    path: String,
    models: Vec<String>,
    daily_budget: f64,
    duration: Option<String>,
    pin: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    reasons: Vec<String>,
}

fn validate_grant(request: &GrantRequest) -> Result<(), String> {
    if request.reasons.len() > 8
        || request
            .reasons
            .iter()
            .any(|r| r.len() > 500 || r.chars().any(char::is_control))
    {
        return Err("INVALID_INPUT: 授权理由最多八项，每项不超过 500 字节。".into());
    }
    if let Some(id) = &request.request_id {
        uuid::Uuid::parse_str(id).map_err(|_| "无效的 Agent 申请编号。")?;
    }
    if request.name.trim().is_empty()
        || request.name.chars().count() > 100
        || request.name.chars().any(char::is_control)
    {
        return Err("项目名称需要 1–100 个可显示字符。".into());
    }
    if !request.daily_budget.is_finite() || request.daily_budget <= 0.0 {
        return Err("每日预算需为大于 $0 的有效金额。".into());
    }
    if request.models.is_empty()
        || request.models.len() > 100
        || request.models.iter().any(|model| {
            model.trim().is_empty()
                || model.len() > 300
                || model.contains('*')
                || model.chars().any(char::is_control)
        })
    {
        return Err("INVALID_INPUT: 请选择不超过 100 个明确的模型。".into());
    }
    if let Some(duration) = &request.duration {
        let valid_unit = duration.ends_with('d') || duration.ends_with('h');
        let number = duration
            .get(..duration.len().saturating_sub(1))
            .and_then(|value| value.parse::<u32>().ok());
        if !valid_unit || number.unwrap_or(0) == 0 {
            return Err("有效期使用 7d、30d 等格式，或选择长期有效。".into());
        }
    }
    Ok(())
}

impl Broker {
    fn finish_request(&self, id: Option<&str>, result: Value) -> Result<(), String> {
        let Some(id) = id else { return Ok(()) };
        Queue::new(&self.directory).finish(
            id,
            result["status"].as_str().unwrap_or("failed"),
            result.get("project").map(public_project),
            result["message"].as_str().map(String::from),
            Utc::now().timestamp(),
        )
    }
    fn desktop_running(&self) -> bool {
        // OS-owned lock is released on exit/crash; file presence alone is never evidence.
        let Ok(file) = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.directory.join("desktop.lock"))
        else {
            return false;
        };
        matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock))
    }
    fn submit_request(&self, body: Value) -> Result<Value, String> {
        if body.to_string().len() > 16000 {
            return Err("INVALID_INPUT: 申请内容过大。".into());
        }
        let input: AgentInput = serde_json::from_value(body)
            .map_err(|_| "INVALID_INPUT: 申请只接受项目、模型、预算与期限。")?;
        let request = GrantRequest {
            name: input.name,
            path: input.path,
            models: input.models,
            daily_budget: input.daily_budget,
            duration: input.duration,
            pin: None,
            request_id: None,
            reasons: input.reasons,
        };
        validate_grant(&request)?;
        let (_, identity, id) = project_identity(&request.path)?;
        let _mutation = requests::try_lock(&self.directory, "mutation.lock")?;
        let models: BTreeSet<String> = request.models.iter().cloned().collect();
        let available: BTreeSet<String> =
            self.models()?.into_iter().map(|model| model.id).collect();
        if !models.is_subset(&available) {
            return Err("MODEL_UNAVAILABLE: 所选模型不在当前目录中。".into());
        }
        if let Some(mut project) = self.projects()?.into_iter().find(|p| p.id == id) {
            if project.models.iter().cloned().collect::<BTreeSet<_>>() == models
                && project.daily_budget == request.daily_budget
                && project.duration == request.duration
                && reasons_match(&project.reasons, &request.reasons)
                && native::read_secret(&format!("project/{id}"))?
                    .map(|key| hash(&key) == project.key_hash)
                    .unwrap_or(false)
            {
                let info = self.api(Method::GET, &format!("/key/info?key={}", project.key_hash))?;
                if key_status(&info["info"]) == "active" {
                    project.expires = info["info"]["expires"].as_str().map(String::from);
                    return Ok(
                        json!({"status":"reused","project":public_project(&serde_json::to_value(project).unwrap()),"checkedAt":Utc::now().to_rfc3339()}),
                    );
                }
            }
        }
        if !self.desktop_running() {
            return Err("DESKTOP_NOT_RUNNING: 请先打开 ZeroKey 桌面应用以审核申请。".into());
        }
        let now = Utc::now().timestamp();
        Queue::new(&self.directory)
            .submit(
                AccessRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    project_id: id,
                    path: identity,
                    name: request.name.trim().into(),
                    models: models.into_iter().collect(),
                    daily_budget: request.daily_budget,
                    duration: request.duration,
                    requested_at: now,
                    expires_at: now,
                    updated_at: now,
                    status: "pending".into(),
                    project: None,
                    message: None,
                    reasons: request.reasons,
                },
                now,
            )
            .map(|r| r.view())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentInput {
    name: String,
    path: String,
    models: Vec<String>,
    daily_budget: f64,
    duration: Option<String>,
    #[serde(default)]
    reasons: Vec<String>,
}

fn public_project(project: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for field in [
        "id",
        "name",
        "path",
        "models",
        "dailyBudget",
        "duration",
        "expires",
        "createdAt",
        "status",
        "reasons",
    ] {
        if let Some(value) = project.get(field) {
            result.insert(field.into(), value.clone());
        }
    }
    Value::Object(result)
}
fn project_identity(input: &str) -> Result<(PathBuf, String, String), String> {
    let path = fs::canonicalize(input).map_err(|_| "PROJECT_NOT_FOUND: 项目文件夹不存在。")?;
    if !path.is_dir() {
        return Err("INVALID_INPUT: 项目路径必须是文件夹。".into());
    }
    let identity = path
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();
    let id = hash(&if cfg!(windows) {
        identity.to_lowercase()
    } else {
        identity.clone()
    });
    Ok((path, identity, id))
}

#[tauri::command]
pub fn pending_request(state: State<'_, Arc<Broker>>) -> Result<Option<Value>, String> {
    let request = Queue::new(&state.directory).pending(Utc::now().timestamp())?;
    request
        .map(|request| serde_json::to_value(request).map_err(|_| "无法读取 Agent 申请。".into()))
        .transpose()
}

#[tauri::command]
pub fn cancel_request(state: State<'_, Arc<Broker>>, id: String) -> Result<(), String> {
    Queue::new(&state.directory)
        .cancel(&id, Utc::now().timestamp())
        .map(|_| ())
}

#[tauri::command]
pub fn request_status(state: State<'_, Arc<Broker>>, id: String) -> Result<Value, String> {
    Queue::new(&state.directory).status(&id, Utc::now().timestamp())
}

pub fn run_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--broker") {
        return None;
    }
    let result = (|| -> Result<Value, String> {
        let directory = dirs::data_dir()
            .ok_or("无法找到应用数据目录。")?
            .join("app.zerokey.desktop");
        let state = Broker::at(directory).map_err(|error| {
            let detail = error.to_string();
            if detail.starts_with("CONFIG_") {
                detail
            } else if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
            {
                "CONFIG_ACCESS_DENIED: 当前进程无法访问本机配置，请在正常桌面会话中运行。".into()
            } else {
                "CONFIG_READ_FAILED: 无法打开本机配置，请打开 ZeroKey 设置检查。".into()
            }
        })?;
        let action = args.get(2).map(String::as_str).unwrap_or("status");
        let body: Value = serde_json::from_str(args.get(3).map(String::as_str).unwrap_or("{}"))
            .map_err(|_| "无效的本地 Broker 命令。")?;
        if action == "models" {
            return Ok(json!({"models":state.models()?,"checkedAt":Utc::now().to_rfc3339()}));
        }
        if action == "doctor" {
            let checked = state.models();
            let error = checked
                .as_ref()
                .err()
                .map(|e| e.split(':').next().unwrap_or("GATEWAY_ERROR").to_string());
            let error = if checked.is_err() && !state.directory.join("settings.json").exists() {
                Some("CONFIG_NOT_FOUND".to_string())
            } else {
                error
            };
            return Ok(
                json!({"gateway":state.base()?,"connected":checked.is_ok(),"connectionError":error,"credentialStore":native::credential_store_name(),"nativeAuth":native::hello_available(),"brokerVersion":"0.3.0","desktopRunning":state.desktop_running(),"checkedAt":Utc::now().to_rfc3339()}),
            );
        }
        if action == "mcp-session" {
            return crate::integration::session(&state.directory, body);
        }
        if action == "revoke" {
            let path = body["path"]
                .as_str()
                .ok_or("INVALID_INPUT: 请指定项目路径。")?;
            let (_, identity, id) = project_identity(path)?;
            state.revoke_project(&id)?;
            return Ok(json!({"status":"revoked","projectPath":identity}));
        }
        if action == "request-status" || action == "request-cancel" || action == "request-wait" {
            let id = body["requestId"]
                .as_str()
                .ok_or("INVALID_INPUT: 请指定申请编号。")?;
            let queue = Queue::new(&state.directory);
            if action == "request-wait" {
                let seconds = body["timeoutSeconds"].as_u64().unwrap_or(25).min(30);
                let previous = body["afterStatus"].as_str().unwrap_or("pending");
                let start = std::time::Instant::now();
                loop {
                    let result = queue.status(id, Utc::now().timestamp())?;
                    if result["status"] != previous
                        || !matches!(result["status"].as_str(), Some("pending" | "authorizing"))
                        || start.elapsed().as_secs() >= seconds
                    {
                        return Ok(result);
                    }
                    std::thread::sleep(Duration::from_millis(350));
                }
            }
            return if action == "request-status" {
                queue.status(id, Utc::now().timestamp())
            } else {
                queue.cancel(id, Utc::now().timestamp())
            };
        }
        let input_path = body["path"]
            .as_str()
            .ok_or("INVALID_INPUT: 请指定项目文件夹。")?;
        let (path, identity, id) = project_identity(input_path)?;
        let project = state
            .projects()?
            .into_iter()
            .find(|project| project.id == id);
        if action == "status" {
            return match project {
                Some(mut project) => {
                    let info =
                        state.api(Method::GET, &format!("/key/info?key={}", project.key_hash))?;
                    project.status = key_status(&info["info"]);
                    project.expires = info["info"]["expires"].as_str().map(String::from);
                    let credential_present = native::read_secret(&format!("project/{id}"))?
                        .map(|key| hash(&key) == project.key_hash)
                        .unwrap_or(false);
                    Ok(
                        json!({"status":project.status,"project":public_project(&serde_json::to_value(&project).unwrap()),"credentialPresent":credential_present,"checkedAt":Utc::now().to_rfc3339()}),
                    )
                }
                None => Ok(
                    json!({"status":"not_configured","path":identity,"checkedAt":Utc::now().to_rfc3339()}),
                ),
            };
        }
        if action == "request" || action == "provision" {
            let submitted = state.submit_request(body)?;
            if action == "request" || submitted["status"] == "reused" {
                return Ok(submitted);
            }
            let request_id = submitted["requestId"]
                .as_str()
                .ok_or("无法读取申请编号。")?;
            eprintln!("ZeroKey: 请在桌面应用中审核申请并完成本机验证。申请编号 {request_id}");
            loop {
                let result =
                    Queue::new(&state.directory).status(request_id, Utc::now().timestamp())?;
                if !matches!(result["status"].as_str(), Some("pending" | "authorizing")) {
                    return Ok(result);
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        let project = project.ok_or("项目尚未授权。请先运行 provision。")?;
        if action == "run" {
            let key = native::read_secret(&format!("project/{id}"))?
                .ok_or("系统凭据库中没有项目 Key。")?;
            if hash(&key) != project.key_hash {
                return Err("项目凭据不匹配，请重新授权。".into());
            }
            let program = body["program"].as_array().ok_or("请在 -- 后指定程序。")?;
            let name = program
                .first()
                .and_then(Value::as_str)
                .ok_or("请在 -- 后指定程序。")?;
            let arguments = program
                .iter()
                .skip(1)
                .map(|value| value.as_str().ok_or("无效的程序参数。"))
                .collect::<Result<Vec<_>, _>>()?;
            let mut command = std::process::Command::new(name);
            command.args(arguments).current_dir(path);
            for name in [
                "LITELLM_MASTER_KEY",
                "LITELLM_SALT_KEY",
                "POSTGRES_PASSWORD",
                "BBAI_API_KEY",
                "OPENLUX_API_KEY",
                "OPENCODE_API_KEY",
                "OPENCODE_GO_API_KEY",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "OPENROUTER_API_KEY",
                "AZURE_API_KEY",
            ] {
                command.env_remove(name);
            }
            for name in ["OPENAI_API_KEY", "LLM_API_KEY"] {
                command.env(name, &key);
            }
            let base = state.base()? + "/v1";
            for name in ["OPENAI_BASE_URL", "LLM_BASE_URL"] {
                command.env(name, &base);
            }
            let selected = body["model"].as_str().unwrap_or(&project.models[0]);
            if !project.models.iter().any(|model| model == selected) {
                return Err("MODEL_UNAVAILABLE: 模型不在项目授权范围内。".into());
            }
            let catalog = state.models()?;
            let model = catalog
                .iter()
                .find(|model| model.id == selected)
                .ok_or("MODEL_UNAVAILABLE: 模型不在网关目录中。")?;
            for name in ["OPENAI_MODEL", "LLM_MODEL"] {
                command.env(name, selected);
            }
            command.env("LLM_API_PROTOCOL", &model.protocol);
            let session = body["sessionId"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| format!("ses_zerokey_{}", uuid::Uuid::new_v4()));
            command.env("LITELLM_SESSION_ID", session);
            let status = command
                .status()
                .map_err(|_| "无法启动目标程序，请检查程序名称。")?;
            std::process::exit(status.code().unwrap_or(1));
        }
        Err("不支持的 Broker 操作。".into())
    })();
    match result {
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
            Some(0)
        }
        Err(error) => {
            eprintln!("ZeroKey: {error}");
            Some(1)
        }
    }
}

#[tauri::command]
pub async fn create_grant(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Broker>>,
    request: GrantRequest,
) -> Result<Project, String> {
    validate_grant(&request)?;
    let owner = owner_window(&window)?;
    let state = Arc::clone(state.inner());
    if app
        .state::<crate::desktop::Desktop>()
        .authorizing
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err("另一个本机验证正在进行。".into());
    }
    let review_window = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _lock = state.mutation.try_lock().map_err(|_| "另一个授权操作正在进行，请完成后重试。")?;
        let _process_lock = requests::try_lock(&state.directory, "mutation.lock")?;
        let (_, identity, id) = project_identity(&request.path)?;
        let queue = Queue::new(&state.directory);
        if let Some(request_id) = &request.request_id { queue.begin(request_id, &id, Utc::now().timestamp())?; }
        let mut issuance_started = false;
        let mut saved_project: Option<Project> = None;
        let result = (|| -> Result<Project, String> {
        let target = format!("project/{id}");
        let available: BTreeSet<String> = state.models()?.into_iter().map(|model| model.id).collect();
        let requested: BTreeSet<String> = request.models.iter().cloned().collect();
        if !requested.is_subset(&available) { return Err("所选模型不在当前网关中，请刷新后重试。".into()); }
        let mut projects = state.projects()?;
        let old = projects.iter().find(|project| project.id == id).cloned();
        let old_key = native::read_secret(&target)?;
        if let (Some(old), Some(key)) = (&old, &old_key) {
            if old.models.iter().cloned().collect::<BTreeSet<_>>() == requested &&
                old.daily_budget == request.daily_budget && old.duration == request.duration && reasons_match(&old.reasons, &request.reasons) && hash(key) == old.key_hash {
                let info = state.api(Method::GET, &format!("/key/info?key={}", old.key_hash))?;
                if key_status(&info["info"]) == "active" {
                    state.finish_request(request.request_id.as_deref(), json!({"status":"reused","project":old}))?;
                    return Ok(old.clone());
                }
            }
        }
        if window.label() == "approval" && native::hello_available() { crate::desktop::hide_approval(window.app_handle())?; }
        state.authorize(&format!("ZeroKey: {} | {} | {} | ${}/day", request.name, identity, requested.iter().cloned().collect::<Vec<_>>().join(", "), request.daily_budget), request.pin.as_deref(), owner)?;
        let models: Vec<String> = requested.into_iter().collect();
        let body = issuance_body(&request, &models, &identity);
        if let Some(request_id) = &request.request_id { queue.check_deadline(request_id, Utc::now().timestamp())?; }
        issuance_started = true;
        let issued = state.api_body(Method::POST, "/key/generate", Some(body), None)?;
        let key = issued["key"].as_str().filter(|key| key.starts_with("sk-")).ok_or("网关未签发有效凭证。")?;
        let project = Project { id: id.clone(), name: request.name.trim().into(), path: identity,
            models, daily_budget: request.daily_budget, duration: request.duration.clone(),
            expires: issued["expires"].as_str().map(String::from), created_at: Utc::now().to_rfc3339(),
            key_hash: hash(key), status: "active".into(), spend: 0.0, reasons:request.reasons.clone() };
        projects.retain(|project| project.id != id); projects.push(project.clone());
        let saved = native::write_secret(&target, key).and_then(|_| state.save_projects(&projects));
        if let Err(error) = saved {
            if let Some(old) = &old_key { let _ = native::write_secret(&target, old); }
            else { let _ = native::delete_secret(&target); }
            state.api_body(Method::POST, "/key/delete", Some(json!({"keys":[key]})), None)
                .map_err(|_| "保存失败，且临时 Key 清理失败；请在 LiteLLM 后台撤销该项目 Key。")?;
            return Err(error);
        }
        saved_project = Some(project.clone());
        if let Some(previous) = old_key {
            if state.api_body(Method::POST, "/key/delete", Some(json!({"keys":[previous]})), None).is_err() {
                return Err("新授权已保存，但旧 Key 未能撤销，请在 LiteLLM 后台完成清理。".into());
            }
        }
        state.finish_request(request.request_id.as_deref(), json!({"status":"provisioned","project":project}))?;
        Ok(project)
        })();
        if let Err(error) = &result {
            if let Some(project) = saved_project {
                state.finish_request(request.request_id.as_deref(), json!({"status":"provisioned","project":project,"message":"授权已保存，但后续清理未完成，请在桌面和 LiteLLM 检查旧凭证。"})).ok();
                return Err(error.clone());
            }
            if let Some(id) = &request.request_id {
                if issuance_started { queue.finish(id, "failed", None, Some("签发或保存未完成，请在桌面检查项目与网关状态。".into()), Utc::now().timestamp())?; }
                else { queue.retry(id, Utc::now().timestamp())?; }
            }
        }
        result
    }).await.map_err(|_| "授权任务未完成。".to_string()).and_then(|result| result);
    app.state::<crate::desktop::Desktop>()
        .authorizing
        .store(false, std::sync::atomic::Ordering::SeqCst);
    if review_window.label() == "approval" {
        if result.is_err() {
            let _ = review_window.show();
            let _ = review_window.set_focus();
        } else {
            let _ = crate::desktop::hide_approval(review_window.app_handle());
        }
    }
    use tauri::Emitter;
    let _ = app.emit("projects-changed", ());
    result
}

#[tauri::command]
pub async fn revoke_grant(state: State<'_, Arc<Broker>>, id: String) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.revoke_project(&id))
        .await
        .map_err(|_| "撤销未完成。".to_string())?
}

#[tauri::command]
pub async fn test_grant(state: State<'_, Arc<Broker>>, id: String) -> Result<Value, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let project = state.projects()?.into_iter().find(|project| project.id == id).ok_or("找不到项目授权。")?;
        let available = state.models()?;
        let model = project.models.iter().find(|id| available.iter().any(|model| &model.id == *id &&
            matches!(model.protocol.as_str(), "responses" | "chat" | "chat-completions" | "messages" | "generate-content")))
            .ok_or("当前授权中没有可做文字测试的模型，请选择文本模型。")?;
        let protocol = available.iter().find(|entry| &entry.id == model).map(|entry| entry.protocol.as_str()).unwrap_or("chat-completions");
        let key = native::read_secret(&format!("project/{id}"))?.ok_or("项目凭证不存在，请重新授权。")?;
        let responses = protocol == "responses";
        let body = if responses { json!({"model":model,"input":"Reply with exactly: OK","max_output_tokens":32}) }
            else { json!({"model":model,"messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":32}) };
        let response = state.api_body(Method::POST, if responses { "/v1/responses" } else { "/v1/chat/completions" }, Some(body), Some(&key))?;
        let text = if responses {
            response["output"].as_array().into_iter().flatten()
                .flat_map(|item| item["content"].as_array().into_iter().flatten())
                .filter(|part| part["type"] == "output_text")
                .filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("")
        } else { response["choices"][0]["message"]["content"].as_str().unwrap_or("").into() };
        if text.is_empty() { return Err("模型没有返回文字，可能需要使用该模型对应的接口。".into()); }
        Ok(json!({"text":text,"model":model,"tokens":response["usage"]["total_tokens"]}))
    }).await.map_err(|_| "文字测试未完成。".to_string())?
}

#[tauri::command]
pub async fn connect_gateway(
    state: State<'_, Arc<Broker>>,
    gateway: String,
    master: String,
) -> Result<(), String> {
    let gateway = validate_gateway(&gateway)?;
    if gateway != state.base()? && !state.projects()?.is_empty() {
        return Err("当前已有项目绑定这个网关。请先撤销项目，或继续使用原网关地址。".into());
    }
    if master.trim().is_empty() {
        return Err("请输入网关管理 Key。".into());
    }
    let response = state
        .client
        .get(format!("{gateway}/v1/models"))
        .bearer_auth(master.trim())
        .send()
        .await
        .map_err(|_| "无法连接这个网关。")?;
    if !response.status().is_success() {
        return Err("网关拒绝了管理 Key，请检查后重试。".into());
    }
    let _lock = state
        .mutation
        .try_lock()
        .map_err(|_| "另一个配置操作正在进行。")?;
    let _process_lock = requests::try_lock(&state.directory, "mutation.lock")?;
    let settings = Settings { gateway };
    let old = native::read_secret("gateway-master")?;
    native::write_secret("gateway-master", master.trim())?;
    if let Err(error) = safe_write(&state.directory.join("settings.json"), &settings) {
        if let Some(old) = old {
            let _ = native::write_secret("gateway-master", &old);
        }
        return Err(error);
    }
    *state.settings.lock().map_err(|_| "配置正忙。")? = settings;
    Ok(())
}

#[tauri::command]
pub async fn set_app_pin(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Broker>>,
    pin: String,
    previous: Option<String>,
) -> Result<(), String> {
    if pin.len() < 6 || pin.len() > 32 || !pin.chars().all(|value| value.is_ascii_digit()) {
        return Err("ZeroKey 授权 PIN 使用 6–32 位数字，与系统登录 PIN 独立。".into());
    }
    let owner = owner_window(&window)?;
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = state
            .mutation
            .try_lock()
            .map_err(|_| "另一个授权操作正在进行。")?;
        if native::read_secret("authorization-pin")?.is_some() {
            state.authorize(
                "ZeroKey: change local authorization PIN",
                previous.as_deref(),
                owner,
            )?;
        }
        let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
            .map_err(|_| "无法初始化 PIN 盐值。")?;
        let encoded = Argon2::default()
            .hash_password(pin.as_bytes(), &salt)
            .map_err(|_| "无法保存授权 PIN。")?
            .to_string();
        native::write_secret("authorization-pin", &encoded)
    })
    .await
    .map_err(|_| "PIN 设置未完成。".to_string())?
}

#[tauri::command]
pub fn open_dashboard(state: State<'_, Arc<Broker>>) -> Result<(), String> {
    let url = validate_gateway(&state.base()?)? + "/ui";
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result
        .map(|_| ())
        .map_err(|_| "无法打开默认浏览器。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changing_a_project_budget_issues_a_unique_alias_with_the_reviewed_scope() {
        let mut grant = GrantRequest {
            name: "ScienceBoard-GIS".into(),
            path: "test-project".into(),
            models: vec!["test/text-model".into()],
            daily_budget: 1.,
            duration: None,
            pin: None,
            request_id: None,
            reasons: vec!["代码辅助".into()],
        };
        let first = issuance_body(&grant, &grant.models, "test-project");
        grant.daily_budget = 100.;
        let replacement = issuance_body(&grant, &grant.models, "test-project");
        assert_ne!(first["key_alias"], replacement["key_alias"]);
        assert!(replacement["key_alias"].as_str().unwrap().starts_with("zerokey/ScienceBoard-GIS/"));
        assert_eq!(replacement["max_budget"], 100.);
        assert_eq!(replacement["budget_duration"], "1d");
        assert_eq!(replacement["models"], json!(["test/text-model"]));
        assert_eq!(replacement["metadata"]["project"], "test-project");
        assert_eq!(replacement["metadata"]["reasons"], json!(["代码辅助"]));
        assert!(replacement.get("duration").is_none());
        grant.duration = Some("7d".into());
        assert_eq!(issuance_body(&grant, &grant.models, "test-project")["duration"], "7d");
    }

    #[test]
    fn gateway_errors_classify_bad_parameters_without_echoing_sensitive_details() {
        for (param, expected) in [
            ("key_alias", "同名凭证"),
            ("max_budget", "预算设置"),
            ("unknown", "请求参数"),
        ] {
            let detail = json!({"error":{"param":param,"message":"sk-synthetic-secret", "key":"sk-synthetic-secret"}});
            let error = gateway_error(400, &detail);
            assert!(error.contains(expected));
            assert!(!error.contains("sk-synthetic-secret"));
        }
        for code in [400, 401, 402, 403, 422, 500] {
            let error = gateway_error(code, &json!({"error":"sk-synthetic-secret"}));
            assert!(!error.contains("sk-synthetic-secret"));
            assert!(!error.is_empty());
        }
        assert!(gateway_error(400, &Value::Null).contains("请求参数"));
    }

    #[test]
    fn gateway_rejects_insecure_remote_and_embedded_secrets() {
        assert!(validate_gateway("http://127.0.0.1:4000").is_ok());
        assert!(validate_gateway("https://gateway.example.com").is_ok());
        for url in [
            "http://example.com",
            "https://key@example.com",
            "https://example.com?key=secret",
            "https://example.com/v1",
        ] {
            assert!(validate_gateway(url).is_err());
        }
    }
    #[test]
    fn grant_accepts_positive_finite_budgets_and_rejects_wildcards() {
        let mut grant = GrantRequest {
            name: "demo".into(),
            path: ".".into(),
            models: vec!["opencode-go/gpt-6-luna".into()],
            daily_budget: 1.,
            duration: None,
            pin: None,
            request_id: None,
            reasons: vec![],
        };
        for budget in [0.01, 1., 11., 100., 10000.] {
            grant.daily_budget = budget;
            assert!(validate_grant(&grant).is_ok());
        }
        for budget in [0., -1., f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            grant.daily_budget = budget;
            assert!(validate_grant(&grant).is_err());
        }
        grant.daily_budget = 1.;
        grant.models = vec!["*".into()];
        assert!(validate_grant(&grant).is_err());
    }
    #[test]
    fn key_status_honors_blocking_and_expiration() {
        assert_eq!(
            key_status(&json!({"blocked":false,"expires":null})),
            "active"
        );
        assert_eq!(
            key_status(&json!({"blocked":true,"status":"active"})),
            "blocked"
        );
        assert_eq!(
            key_status(&json!({"expires":"2020-01-01T00:00:00Z","status":"active"})),
            "expired"
        );
        assert_eq!(
            key_status(&json!({"expires":"2099-01-01T00:00:00Z"})),
            "active"
        );
    }
    #[test]
    fn explicit_reason_edits_require_review_but_omission_preserves_reuse() {
        let original = vec!["文字生成".to_string(), "自动化测试".to_string()];
        assert!(reasons_match(&original, &[]));
        assert!(reasons_match(
            &original,
            &["自动化测试".into(), "文字生成".into()]
        ));
        assert!(!reasons_match(&original, &["代码辅助".into()]));
    }
}

#[cfg(target_os = "windows")]
fn owner_window(window: &tauri::WebviewWindow) -> Result<isize, String> {
    window
        .hwnd()
        .map(|handle| handle.0 as isize)
        .map_err(|_| "无法读取 ZeroKey 授权窗口。".into())
}
#[cfg(not(target_os = "windows"))]
fn owner_window(_: &tauri::WebviewWindow) -> Result<isize, String> {
    Ok(0)
}

pub fn forward_existing_desktop() -> bool {
    let Some(directory) = dirs::data_dir().map(|path| path.join("app.zerokey.desktop")) else {
        return false;
    };
    if let Ok(file) = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("desktop.lock"))
    {
        if matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)) {
            if !std::env::args().any(|arg| arg == "--background") {
                let _ = safe_write(&directory.join("desktop-command.json"), &"projects");
            }
            return true;
        }
    }
    false
}
