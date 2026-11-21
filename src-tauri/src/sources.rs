//! Source administration stays in the trusted native process. Upstream keys stay in LiteLLM.
use crate::{
    broker::{safe_write, Broker},
    requests,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tauri::{Emitter, Manager, State};

const INTERVAL: i64 = 6 * 60 * 60;

struct Spec {
    id: &'static str,
    catalog: &'static str,
    base: &'static str,
    env: &'static str,
}
fn spec(id: &str) -> Result<Spec, String> {
    match id {
        "bbai" => Ok(Spec {
            id: "bbai",
            catalog: "https://api.sharesai.xyz/v1/models",
            base: "https://api.sharesai.xyz/v1",
            env: "BBAI_API_KEY",
        }),
        "openlux" => Ok(Spec {
            id: "openlux",
            catalog: "https://api.openlux.ai/v1/models",
            base: "https://api.openlux.ai/v1",
            env: "OPENLUX_API_KEY",
        }),
        "opencode-go" => Ok(Spec {
            id: "opencode-go",
            catalog: "https://opencode.ai/inference/go/v1/models",
            base: "",
            env: "OPENCODE_API_KEY",
        }),
        "opencode-payg" => Ok(Spec {
            id: "opencode-payg",
            catalog: "https://opencode.ai/inference/v1/models",
            base: "https://opencode.ai/inference/openai/v1",
            env: "OPENCODE_API_KEY",
        }),
        _ => Err("此来源尚未配置目录同步，请在管理来源中维护模型。".into()),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub protocol: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Record {
    auto_add: bool,
    checked_at: Option<String>,
    synced_at: Option<String>,
    next_check_at: i64,
    requested_at: i64,
    catalog: Vec<Candidate>,
    pending: Vec<Candidate>,
    missing: Vec<String>,
    last_added: Vec<String>,
    error: Option<String>,
    history: Vec<SyncEvent>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    at: String,
    action: String,
    added: usize,
    pending: usize,
    missing: usize,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    id: String,
    registered: usize,
    supported: bool,
    auto_add: bool,
    checked_at: Option<String>,
    synced_at: Option<String>,
    pending: Vec<Candidate>,
    missing: Vec<String>,
    last_added: Vec<String>,
    error: Option<String>,
    history: Vec<SyncEvent>,
}

trait Gateway {
    fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, String>;
}
impl Gateway for Broker {
    fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        self.api_body(method, path, body, None)
    }
}

type Records = BTreeMap<String, Record>;
fn store_path(broker: &Broker) -> Result<PathBuf, String> {
    let gateway = broker.base()?;
    Ok(broker.directory.join(format!(
        "source-sync-{:x}.json",
        Sha256::digest(gateway.as_bytes())
    )))
}
fn read_records(broker: &Broker) -> Result<Records, String> {
    match fs::read(store_path(broker)?) {
        Ok(data) => serde_json::from_slice(&data)
            .map_err(|_| "同步记录无法读取，请检查本机数据目录。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Records::new()),
        Err(_) => Err("无法读取来源同步设置。".into()),
    }
}
fn rows(gateway: &impl Gateway) -> Result<Vec<Value>, String> {
    let data = gateway.call(Method::GET, "/model/info", None)?;
    data["data"]
        .as_array()
        .cloned()
        .ok_or("网关模型目录格式不正确。".into())
}
fn source_of(row: &Value) -> Option<&str> {
    row["model_info"]["source"].as_str().or_else(|| {
        row["model_name"]
            .as_str()?
            .split_once('/')
            .map(|(source, _)| source)
    })
}
fn registered(rows: &[Value], source: &str) -> BTreeSet<String> {
    rows.iter()
        .filter(|row| source_of(row) == Some(source))
        .filter_map(|row| row["model_name"].as_str().map(String::from))
        .collect()
}
fn view(id: &str, rows: &[Value], record: &Record) -> SourceView {
    let existing = registered(rows, id);
    SourceView {
        id: id.into(),
        registered: existing.len(),
        supported: spec(id).is_ok(),
        auto_add: record.auto_add,
        checked_at: record.checked_at.clone(),
        synced_at: record.synced_at.clone(),
        pending: record
            .pending
            .iter()
            .filter(|model| !existing.contains(&model.id))
            .cloned()
            .collect(),
        missing: record
            .missing
            .iter()
            .filter(|model| existing.contains(*model))
            .cloned()
            .collect(),
        last_added: record.last_added.clone(),
        error: record.error.clone(),
        history: record.history.clone(),
    }
}
pub fn status(broker: &Broker) -> Result<Vec<SourceView>, String> {
    let models = rows(broker)?;
    let records = read_records(broker)?;
    let ids: BTreeSet<&str> = models
        .iter()
        .filter_map(source_of)
        .chain(records.keys().map(String::as_str))
        .collect();
    Ok(ids
        .into_iter()
        .map(|id| view(id, &models, records.get(id).unwrap_or(&Record::default())))
        .collect())
}

fn catalog_route(spec: &Spec) -> String {
    format!("/zerokey/catalog/{}", spec.id)
}
fn ensure_catalog(gateway: &impl Gateway, spec: &Spec) -> Result<(), String> {
    let route = catalog_route(spec);
    let existing = gateway.call(Method::GET, "/config/pass_through_endpoint", None)?;
    if let Some(endpoint) = existing["endpoints"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|endpoint| endpoint["path"] == route)
    {
        let methods = endpoint["methods"].as_array();
        if endpoint["target"] != spec.catalog
            || endpoint["auth"] != true
            || endpoint["include_subpath"] == true
            || endpoint["forward_headers"] == true
            || methods.is_none_or(|m| m.len() != 1 || m[0] != "GET")
        {
            return Err("目录同步路由与来源配置不一致，请在网关检查该来源的透传设置。".into());
        }
        return Ok(());
    }
    gateway.call(Method::POST, "/config/pass_through_endpoint", Some(json!({
        "id":format!("zerokey-catalog-{}",spec.id), "path":route, "target":spec.catalog,
        "auth":true, "methods":["GET"], "include_subpath":false, "forward_headers":false,
        "timeout":30, "headers":{"Authorization":format!("Bearer os.environ/{}",spec.env),"accept":"application/json"}
    })))?;
    Ok(())
}

fn valid_model(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 250
        && !id.contains('*')
        && !id.chars().any(|c| c.is_control() || c.is_whitespace())
}
fn text_model(id: &str) -> bool {
    let id = id.to_lowercase();
    let excluded = [
        "image",
        "imagen",
        "dall-e",
        "sora",
        "veo",
        "video",
        "kling",
        "wan-",
        "seedance",
        "music",
        "suno",
        "udio",
        "tts",
        "whisper",
        "audio",
        "speech",
        "embedding",
        "rerank",
        "recraft",
        "flux",
        "stable-diffusion",
        "midjourney",
    ];
    !excluded.iter().any(|s| id.contains(s))
        && [
            "gpt-",
            "chatgpt-",
            "o1",
            "o3",
            "o4",
            "claude-",
            "gemini-",
            "deepseek-",
            "qwen",
            "glm-",
            "kimi-",
            "llama",
            "mistral",
            "magistral",
            "codestral",
            "gemma",
            "grok-",
            "doubao-",
            "step-",
        ]
        .iter()
        .any(|s| id.starts_with(s))
}
fn catalog_models(spec: &Spec, catalog: &Value) -> Result<BTreeMap<String, Candidate>, String> {
    let data = catalog["data"]
        .as_array()
        .filter(|data| !data.is_empty() && data.len() <= 20_000)
        .ok_or("上游目录为空或格式异常，本次保留已有路由和检查记录。")?;
    let mut models = BTreeMap::new();
    for row in data {
        let id = row["id"]
            .as_str()
            .filter(|id| valid_model(id))
            .ok_or("上游目录包含无效型号，本次没有修改已有路由。")?;
        if spec.id == "openlux" && !text_model(id) {
            continue;
        }
        let api = row["api"].as_object();
        let protocol = if !spec.id.starts_with("opencode-") && id.contains("gpt-image") {
            "images"
        } else if spec.id.starts_with("opencode-") {
            if api.is_some_and(|api| api.contains_key("responses")) {
                "responses"
            } else if api.is_some_and(|api| api.contains_key("messages")) {
                "messages"
            } else if api.is_some_and(|api| api.contains_key("generate-content")) {
                "generate-content"
            } else {
                "chat-completions"
            }
        } else {
            "chat-completions"
        };
        let name = format!("{}/{id}", spec.id);
        models.insert(
            name.clone(),
            Candidate {
                id: name,
                protocol: protocol.into(),
            },
        );
    }
    if models.is_empty() {
        return Err("上游没有可接入的文字型号，本次保留已有路由。".into());
    }
    Ok(models)
}
fn deployment(spec: &Spec, model: &Candidate) -> Value {
    let id = model.id.strip_prefix(&format!("{}/", spec.id)).unwrap();
    let (provider, base) = match (spec.id, model.protocol.as_str()) {
        ("opencode-go", _) => ("opencode_go", ""),
        ("opencode-payg", "messages") => {
            ("anthropic", "https://opencode.ai/inference/anthropic/v1")
        }
        ("opencode-payg", "generate-content") => {
            ("gemini", "https://opencode.ai/inference/google/v1beta")
        }
        _ => ("openai", spec.base),
    };
    let mut params =
        json!({"model":format!("{provider}/{id}"),"api_key":format!("os.environ/{}",spec.env)});
    if !base.is_empty() {
        params["api_base"] = json!(base);
    }
    json!({"model_name":model.id, "litellm_params":params, "model_info":{
        "id":format!("{}:{id}",spec.id),"source":spec.id,"source_model":id,"api_family":model.protocol,
        "source_models_url":spec.catalog,"validation":"catalog-only"
    }})
}

fn inspect(
    gateway: &impl Gateway,
    spec: &Spec,
    existing: &[Value],
    record: &mut Record,
) -> Result<BTreeMap<String, Candidate>, String> {
    let now = chrono::Utc::now().timestamp();
    if now - record.requested_at < 30 {
        return Err("目录请求过于频繁，请 30 秒后重新同步。".into());
    }
    record.requested_at = now;
    ensure_catalog(gateway, spec)?;
    let catalog = gateway.call(Method::GET, &catalog_route(spec), None)?;
    let models = catalog_models(spec, &catalog)?;
    let registered = registered(existing, spec.id);
    record.pending = models
        .values()
        .filter(|model| !registered.contains(&model.id))
        .cloned()
        .collect();
    record.missing = registered
        .into_iter()
        .filter(|id| !models.contains_key(id))
        .collect();
    record.checked_at = Some(chrono::Utc::now().to_rfc3339());
    record.catalog = models.values().cloned().collect();
    record.error = None;
    Ok(models)
}
fn cached_catalog(record: &Record, max_age: i64) -> Option<BTreeMap<String, Candidate>> {
    let checked = record
        .checked_at
        .as_ref()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())?;
    let age = chrono::Utc::now().timestamp() - checked.timestamp();
    if !(0..max_age).contains(&age) || record.catalog.is_empty() {
        return None;
    }
    Some(
        record
            .catalog
            .iter()
            .map(|model| (model.id.clone(), model.clone()))
            .collect(),
    )
}
fn add_selected(
    gateway: &impl Gateway,
    spec: &Spec,
    catalog: &BTreeMap<String, Candidate>,
    selected: &[String],
    record: &mut Record,
) -> Result<(), String> {
    let selected: BTreeSet<&str> = selected.iter().map(String::as_str).collect();
    if selected.is_empty()
        || selected.len() > 100
        || !selected.iter().all(|id| catalog.contains_key(*id))
    {
        return Err("请选择本次上游目录中的 1–100 个型号；目录变化后请重新预览。".into());
    }
    let mut existing = registered(&rows(gateway)?, spec.id);
    record.last_added.clear();
    for id in selected {
        if existing.contains(id) {
            continue;
        }
        let model = &catalog[id];
        if gateway
            .call(Method::POST, "/model/new", Some(deployment(spec, model)))
            .is_err()
        {
            // Another administrator may have added this route after the preview.
            if !registered(&rows(gateway)?, spec.id).contains(id) {
                return Err(format!(
                    "部分型号未能添加；本次已添加 {} 个，请检查来源配置后重试。",
                    record.last_added.len()
                ));
            }
        } else {
            record.last_added.push(id.into());
        }
        existing.insert(id.into());
        record.pending.retain(|model| model.id != id);
    }
    record.synced_at = Some(chrono::Utc::now().to_rfc3339());
    Ok(())
}
fn log(record: &mut Record, action: &str) {
    record.history.insert(
        0,
        SyncEvent {
            at: chrono::Utc::now().to_rfc3339(),
            action: action.into(),
            added: record.last_added.len(),
            pending: record.pending.len(),
            missing: record.missing.len(),
            error: record.error.clone(),
        },
    );
    record.history.truncate(10);
}
fn sync(
    broker: &Broker,
    source: &str,
    selected: Option<Vec<String>>,
    auto: bool,
) -> Result<SourceView, String> {
    let spec = spec(source)?;
    let _lock = requests::try_lock(&broker.directory, "source-sync.lock")
        .map_err(|_| "来源正在同步，请稍后重试。")?;
    let mut records = read_records(broker)?;
    let record = records.entry(source.into()).or_default();
    if auto && !record.auto_add {
        return Err("自动添加已关闭。".into());
    }
    let existing = rows(broker)?;
    if registered(&existing, source).is_empty() {
        return Err("请先在管理来源中添加该来源的首个模型与凭据。".into());
    }
    record.last_added.clear();
    let applying = selected.is_some();
    let result = (|| {
        // Confirm the reviewed snapshot without hitting a rate-limited catalog twice.
        let catalog = if applying {
            cached_catalog(record, 600).ok_or("同步预览已过期，请重新同步后再选择型号。")?
        } else if let Some(catalog) = cached_catalog(record, 30) {
            catalog
        } else {
            inspect(broker, &spec, &existing, record)?
        };
        let selected = if auto {
            Some(
                record
                    .pending
                    .iter()
                    .take(100)
                    .map(|model| model.id.clone())
                    .collect(),
            )
        } else {
            selected
        };
        if let Some(selected) = selected {
            if !selected.is_empty() {
                add_selected(broker, &spec, &catalog, &selected, record)?;
            }
        }
        Ok::<_, String>(())
    })();
    record.next_check_at = chrono::Utc::now().timestamp()
        + if auto && result.is_ok() && !record.pending.is_empty() {
            30
        } else {
            INTERVAL
        };
    record.error = result.err();
    log(
        record,
        if auto {
            "auto"
        } else if applying {
            "add"
        } else {
            "check"
        },
    );
    let current = rows(broker).unwrap_or(existing);
    let output = view(source, &current, record);
    safe_write(&store_path(broker)?, &records)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        models: RefCell<Vec<Value>>,
        requests: RefCell<Vec<(Method, String, Option<Value>)>>,
        endpoint: RefCell<Option<Value>>,
        failure: RefCell<Option<String>>,
        catalog: Value,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                models: RefCell::new(vec![
                    json!({"model_name":"bbai/old","model_info":{"source":"bbai"}}),
                ]),
                requests: RefCell::new(vec![]),
                endpoint: RefCell::new(None),
                failure: RefCell::new(None),
                catalog: json!({"data":[{"id":"gpt-6.2-sol","key":"sk-synthetic-private"},{"id":"gpt-6.2-astra"},{"id":"gpt-6.2-sol"}]}),
            }
        }
        fn additions(&self) -> Vec<Value> {
            self.requests
                .borrow()
                .iter()
                .filter(|(_, path, _)| path == "/model/new")
                .map(|(_, _, body)| body.clone().unwrap())
                .collect()
        }
    }
    impl Gateway for Fake {
        fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
            self.requests
                .borrow_mut()
                .push((method.clone(), path.into(), body.clone()));
            match (method, path) {
                (Method::GET, "/model/info") => Ok(json!({"data":self.models.borrow().clone()})),
                (Method::GET, "/config/pass_through_endpoint") => Ok(
                    json!({"endpoints":self.endpoint.borrow().iter().cloned().collect::<Vec<_>>()}),
                ),
                (Method::POST, "/config/pass_through_endpoint") => {
                    *self.endpoint.borrow_mut() = body;
                    Ok(json!({}))
                }
                (Method::POST, "/model/new") => {
                    let body = body.unwrap();
                    if self.failure.borrow().as_deref() == body["model_name"].as_str() {
                        return Err("HTTP 500".into());
                    }
                    self.models.borrow_mut().push(body);
                    Ok(json!({}))
                }
                (Method::GET, "/zerokey/catalog/bbai") => Ok(self.catalog.clone()),
                _ => panic!("Unexpected gateway operation: {path}"),
            }
        }
    }
    #[test]
    fn preview_is_additive_deduplicates_and_never_persists_upstream_secrets() {
        let gateway = Fake::new();
        let mut record = Record::default();
        let catalog = inspect(
            &gateway,
            &spec("bbai").unwrap(),
            &gateway.models.borrow(),
            &mut record,
        )
        .unwrap();
        assert_eq!(catalog.len(), 2);
        assert_eq!(record.pending.len(), 2);
        assert_eq!(record.missing, vec!["bbai/old"]);
        assert!(gateway.additions().is_empty());
        assert!(!serde_json::to_string(&record)
            .unwrap()
            .contains("sk-synthetic-private"));
        ensure_catalog(&gateway, &spec("bbai").unwrap()).unwrap();
        assert_eq!(
            gateway
                .requests
                .borrow()
                .iter()
                .filter(|(method, path, _)| method == Method::POST
                    && path == "/config/pass_through_endpoint")
                .count(),
            1
        );
        let endpoint = gateway.endpoint.borrow();
        let endpoint = endpoint.as_ref().unwrap();
        assert_eq!(endpoint["auth"], true);
        assert_eq!(endpoint["methods"], json!(["GET"]));
        assert_eq!(endpoint["forward_headers"], false);
        assert_eq!(endpoint["include_subpath"], false);
    }
    #[test]
    fn selected_additions_are_idempotent_and_partial_failure_can_resume() {
        let gateway = Fake::new();
        let source = spec("bbai").unwrap();
        let catalog = catalog_models(&source, &gateway.catalog).unwrap();
        let mut record = Record {
            pending: catalog.values().cloned().collect(),
            ..Record::default()
        };
        let selected: Vec<String> = catalog.keys().cloned().collect();
        *gateway.failure.borrow_mut() = Some("bbai/gpt-6.2-sol".into());
        assert!(add_selected(&gateway, &source, &catalog, &selected, &mut record).is_err());
        assert_eq!(record.last_added, vec!["bbai/gpt-6.2-astra"]);
        *gateway.failure.borrow_mut() = None;
        add_selected(&gateway, &source, &catalog, &selected, &mut record).unwrap();
        assert_eq!(record.last_added, vec!["bbai/gpt-6.2-sol"]);
        assert!(record.pending.is_empty());
        let count = gateway.additions().len();
        add_selected(&gateway, &source, &catalog, &selected, &mut record).unwrap();
        assert_eq!(gateway.additions().len(), count);
        assert!(registered(&gateway.models.borrow(), "bbai").contains("bbai/old"));
        assert!(gateway
            .requests
            .borrow()
            .iter()
            .all(|(method, _, _)| *method != Method::DELETE));
    }
    #[test]
    fn rejects_changed_or_invalid_catalogs_without_adding_unreviewed_models() {
        let gateway = Fake::new();
        let source = spec("bbai").unwrap();
        let catalog = catalog_models(&source, &gateway.catalog).unwrap();
        assert!(add_selected(
            &gateway,
            &source,
            &catalog,
            &["other/gpt-6.2-sol".into()],
            &mut Record::default()
        )
        .is_err());
        assert!(gateway.additions().is_empty());
        for bad in [
            json!({"data":[]}),
            json!({"data":[{"id":"*"}]}),
            json!({"error":"private"}),
            json!({"data":[{"id":"a\nb"}]}),
        ] {
            assert!(catalog_models(&source, &bad).is_err());
        }
        *gateway.endpoint.borrow_mut() = Some(
            json!({"path":"/zerokey/catalog/bbai","target":"https://other.invalid/models","auth":false}),
        );
        assert!(ensure_catalog(&gateway, &source).is_err());
    }
    #[test]
    fn keeps_go_payg_protocols_separate_and_filters_openlux_media() {
        for (source, protocol, provider, base) in [
            ("opencode-go", "responses", "opencode_go", None),
            ("opencode-go", "messages", "opencode_go", None),
            (
                "opencode-payg",
                "messages",
                "anthropic",
                Some("https://opencode.ai/inference/anthropic/v1"),
            ),
            (
                "opencode-payg",
                "generate-content",
                "gemini",
                Some("https://opencode.ai/inference/google/v1beta"),
            ),
        ] {
            let candidate = Candidate {
                id: format!("{source}/test-model"),
                protocol: protocol.into(),
            };
            let body = deployment(&spec(source).unwrap(), &candidate);
            assert_eq!(
                body["litellm_params"]["model"],
                format!("{provider}/test-model")
            );
            assert_eq!(body["litellm_params"]["api_base"].as_str(), base);
            assert_eq!(
                body["litellm_params"]["api_key"],
                "os.environ/OPENCODE_API_KEY"
            );
        }
        let catalog =
            json!({"data":[{"id":"gpt-6.2-sol"},{"id":"gpt-image-2"},{"id":"unknown-media"}]});
        assert_eq!(
            catalog_models(&spec("openlux").unwrap(), &catalog)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            catalog_models(&spec("bbai").unwrap(), &catalog).unwrap()["bbai/gpt-image-2"].protocol,
            "images"
        );
        let catalog = json!({"data":[{"id":"test","api":{"messages":{},"responses":{}}}]});
        assert_eq!(
            catalog_models(&spec("opencode-go").unwrap(), &catalog).unwrap()["opencode-go/test"]
                .protocol,
            "responses"
        );
    }
    #[test]
    fn reviewed_catalog_cache_expires_and_never_requeries_on_confirmation() {
        let gateway = Fake::new();
        let mut record = Record::default();
        inspect(
            &gateway,
            &spec("bbai").unwrap(),
            &gateway.models.borrow(),
            &mut record,
        )
        .unwrap();
        let cached = cached_catalog(&record, 600).unwrap();
        add_selected(
            &gateway,
            &spec("bbai").unwrap(),
            &cached,
            &["bbai/gpt-6.2-sol".into()],
            &mut record,
        )
        .unwrap();
        assert_eq!(
            gateway
                .requests
                .borrow()
                .iter()
                .filter(|(_, path, _)| path == "/zerokey/catalog/bbai")
                .count(),
            1
        );
        record.checked_at = Some((chrono::Utc::now() - chrono::Duration::minutes(11)).to_rfc3339());
        assert!(cached_catalog(&record, 600).is_none());
        assert!(inspect(
            &gateway,
            &spec("bbai").unwrap(),
            &gateway.models.borrow(),
            &mut record
        )
        .is_err());
    }
}
fn set_auto(broker: &Broker, source: &str, enabled: bool) -> Result<SourceView, String> {
    spec(source)?;
    let _lock = requests::try_lock(&broker.directory, "source-sync.lock")
        .map_err(|_| "来源正在同步，请稍后修改设置。")?;
    let models = rows(broker)?;
    if registered(&models, source).is_empty() {
        return Err("请先在网关配置这个来源。".into());
    }
    let mut records = read_records(broker)?;
    let record = records.entry(source.into()).or_default();
    record.auto_add = enabled;
    record.next_check_at = 0;
    let output = view(source, &models, record);
    safe_write(&store_path(broker)?, &records)?;
    Ok(output)
}

pub fn operator_command(broker: &Broker, action: &str, body: Value) -> Result<Value, String> {
    if action == "source-status" {
        return serde_json::to_value(status(broker)?).map_err(|_| "无法读取来源状态。".into());
    }
    let source = body["source"].as_str().ok_or("请指定来源。")?;
    let result = match action {
        "source-check" => sync(broker, source, None, false)?,
        "source-apply" => {
            let models = serde_json::from_value::<Vec<String>>(body["models"].clone())
                .map_err(|_| "请选择型号。")?;
            if models.is_empty() {
                return Err("请至少选择一个型号。".into());
            }
            sync(broker, source, Some(models), false)?
        }
        "source-auto" => set_auto(
            broker,
            source,
            body["enabled"].as_bool().ok_or("请选择自动添加状态。")?,
        )?,
        _ => return Err("未知的来源管理命令。".into()),
    };
    serde_json::to_value(result).map_err(|_| "无法读取同步结果。".into())
}
async fn command(
    app: tauri::AppHandle,
    broker: Arc<Broker>,
    action: &str,
    body: Value,
) -> Result<Value, String> {
    let action = action.to_owned();
    let value =
        tauri::async_runtime::spawn_blocking(move || operator_command(&broker, &action, body))
            .await
            .map_err(|_| "来源同步任务未完成。")??;
    let _ = app.emit("sources-changed", ());
    let _ = app.emit("models-changed", ());
    Ok(value)
}
#[tauri::command]
pub async fn source_status(state: State<'_, Arc<Broker>>) -> Result<Vec<SourceView>, String> {
    let broker = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status(&broker))
        .await
        .map_err(|_| "来源读取未完成。")?
}
#[tauri::command]
pub async fn check_source(
    app: tauri::AppHandle,
    state: State<'_, Arc<Broker>>,
    source: String,
) -> Result<Value, String> {
    command(
        app,
        state.inner().clone(),
        "source-check",
        json!({"source":source}),
    )
    .await
}
#[tauri::command]
pub async fn apply_source_models(
    app: tauri::AppHandle,
    state: State<'_, Arc<Broker>>,
    source: String,
    models: Vec<String>,
) -> Result<Value, String> {
    command(
        app,
        state.inner().clone(),
        "source-apply",
        json!({"source":source,"models":models}),
    )
    .await
}
#[tauri::command]
pub async fn set_source_auto_add(
    app: tauri::AppHandle,
    state: State<'_, Arc<Broker>>,
    source: String,
    enabled: bool,
) -> Result<Value, String> {
    command(
        app,
        state.inner().clone(),
        "source-auto",
        json!({"source":source,"enabled":enabled}),
    )
    .await
}
pub fn setup(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        let mut startup = true;
        loop {
            let broker = app.state::<Arc<Broker>>();
            if !app
                .state::<crate::desktop::Desktop>()
                .authorizing
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                if let Ok(records) = read_records(&broker) {
                    for (source, record) in records {
                        if record.auto_add
                            && (startup || record.next_check_at <= chrono::Utc::now().timestamp())
                        {
                            if sync(&broker, &source, None, true).is_ok() {
                                let _ = app.emit("sources-changed", ());
                                let _ = app.emit("models-changed", ());
                            }
                        }
                    }
                    startup = false;
                }
            }
            std::thread::sleep(Duration::from_secs(30));
        }
    });
}
