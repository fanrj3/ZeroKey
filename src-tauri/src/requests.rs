//! Persistent, cross-process approval queue. No credentials are stored here.
use crate::broker::safe_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub const APPROVAL_SECONDS: i64 = 600;
const RETENTION_SECONDS: i64 = 86400;

pub fn try_lock(directory: &Path, name: &str) -> Result<File, String> {
    fs::create_dir_all(directory).map_err(|_| "STORAGE_ERROR: 无法创建本地状态目录。")?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join(name))
        .map_err(|_| "STORAGE_ERROR: 无法打开本地操作锁。")?;
    file.try_lock()
        .map_err(|_| "BROKER_BUSY: 另一个授权操作正在进行，请稍后查询状态。")?;
    Ok(file)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequest {
    pub request_id: String,
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub models: Vec<String>,
    pub daily_budget: f64,
    pub duration: Option<String>,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub requested_at: i64,
    pub expires_at: i64,
    pub updated_at: i64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl AccessRequest {
    pub fn terminal(&self) -> bool {
        !matches!(self.status.as_str(), "pending" | "authorizing")
    }
    pub fn view(&self) -> Value {
        let mut changes = vec![];
        let mut summary = vec![];
        if let Some(project) = &self.project {
            for (field, before) in [
                ("dailyBudget", json!(self.daily_budget)),
                ("models", json!(self.models)),
                ("duration", json!(self.duration)),
                ("path", json!(self.path)),
                ("reasons", json!(self.reasons)),
            ] {
                if let Some(after) = project.get(field) {
                    if before != *after {
                        changes.push(json!({"field":field,"requested":before,"approved":after}));
                        let label = match field {
                            "dailyBudget" => "每日预算",
                            "models" => "授权模型",
                            "duration" => "有效期",
                            "path" => "授权项目",
                            _ => "授权理由",
                        };
                        let format_value = |value: &Value| -> String {
                            if field == "dailyBudget" {
                                return format!("${:.2}", value.as_f64().unwrap_or_default());
                            }
                            if value.is_null() {
                                return "长期有效".into();
                            }
                            if let Some(items) = value.as_array() {
                                return items
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("、");
                            }
                            value.as_str().unwrap_or_default().to_string()
                        };
                        summary.push(format!(
                            "{label}：{} → {}",
                            format_value(&before),
                            format_value(after)
                        ));
                    }
                }
            }
        }
        json!({"requestId": self.request_id, "status": self.status,
            "requestedAt": self.requested_at, "expiresAt": self.expires_at,
            "projectPath": self.path, "project": self.project, "message": self.message, "changes":changes, "changeSummary":summary,
            "requestedScope":{"models":self.models,"dailyBudget":self.daily_budget,"duration":self.duration,"projectPath":self.path,"reasons":self.reasons}})
    }
}

pub struct Queue {
    directory: PathBuf,
}
impl Queue {
    pub fn new(directory: &Path) -> Self {
        Self {
            directory: directory.to_owned(),
        }
    }
    fn lock(&self) -> Result<File, String> {
        // Queue operations are short and never wait for authentication or HTTP.
        fs::create_dir_all(self.directory.join("requests"))
            .map_err(|_| "STORAGE_ERROR: 无法打开申请目录。")?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.directory.join("requests.lock"))
            .map_err(|_| "STORAGE_ERROR: 无法打开申请锁。")?;
        file.lock()
            .map_err(|_| "STORAGE_ERROR: 无法锁定申请状态。")?;
        Ok(file)
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        let id = uuid::Uuid::parse_str(id).map_err(|_| "INVALID_REQUEST_ID: 无效的申请编号。")?;
        Ok(self.directory.join("requests").join(format!("{id}.json")))
    }
    fn save(&self, request: &AccessRequest) -> Result<(), String> {
        safe_write(&self.path(&request.request_id)?, request)
    }
    fn load(&self, id: &str) -> Result<AccessRequest, String> {
        let path = self.path(id)?;
        let meta = fs::metadata(&path)
            .map_err(|_| "REQUEST_NOT_FOUND: 找不到申请，或结果已超过保留期限。")?;
        if meta.len() > 32768 {
            return Err("STORAGE_ERROR: 申请记录过大。".into());
        }
        let data = fs::read(path).map_err(|_| "STORAGE_ERROR: 无法读取申请。")?;
        let request: AccessRequest =
            serde_json::from_slice(&data).map_err(|_| "STORAGE_ERROR: 申请记录损坏。")?;
        if uuid::Uuid::parse_str(&request.request_id).ok() != uuid::Uuid::parse_str(id).ok() {
            return Err("STORAGE_ERROR: 申请编号不匹配。".into());
        }
        Ok(request)
    }
    fn refresh(&self, request: &mut AccessRequest, now: i64) -> Result<(), String> {
        if request.status == "pending" && now >= request.expires_at {
            request.status = "expired".into();
            request.updated_at = now;
            self.save(request)?;
        } else if request.status == "authorizing"
            && try_lock(&self.directory, "mutation.lock").is_ok()
        {
            // A crashed approving process releases the OS lock. Never silently reissue.
            request.status = "failed".into();
            request.updated_at = now;
            request.message = Some("审批进程已中断，请在桌面检查项目状态后再操作。".into());
            self.save(request)?;
        }
        Ok(())
    }
    fn all(&self, now: i64) -> Result<Vec<AccessRequest>, String> {
        let files = fs::read_dir(self.directory.join("requests"))
            .map_err(|_| "STORAGE_ERROR: 无法读取申请列表。")?;
        let mut requests = vec![];
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            if uuid::Uuid::parse_str(id).is_err() {
                continue;
            }
            let mut request = self.load(id)?;
            self.refresh(&mut request, now)?;
            if request.terminal() && now - request.updated_at >= RETENTION_SECONDS {
                fs::remove_file(file.path()).map_err(|_| "STORAGE_ERROR: 无法清理旧申请。")?;
            } else {
                requests.push(request);
            }
        }
        requests.sort_by_key(|r| (r.requested_at, r.request_id.clone()));
        Ok(requests)
    }
    pub fn submit(&self, mut request: AccessRequest, now: i64) -> Result<AccessRequest, String> {
        let _lock = self.lock()?;
        for previous in self.all(now)? {
            if previous.project_id == request.project_id && !previous.terminal() {
                if previous.models == request.models
                    && previous.daily_budget == request.daily_budget
                    && previous.duration == request.duration
                    && previous.reasons == request.reasons
                {
                    return Ok(previous);
                }
                return Err(
                    "REQUEST_CONFLICT: 此项目已有不同范围的申请，请先处理或取消原申请。".into(),
                );
            }
        }
        request.requested_at = now;
        request.updated_at = now;
        request.expires_at = now + APPROVAL_SECONDS;
        self.save(&request)?;
        Ok(request)
    }
    pub fn status(&self, id: &str, now: i64) -> Result<Value, String> {
        let _lock = self.lock()?;
        let mut request = self.load(id)?;
        self.refresh(&mut request, now)?;
        if request.terminal() && now - request.updated_at >= RETENTION_SECONDS {
            return Err("REQUEST_NOT_FOUND: 申请结果已超过保留期限。".into());
        }
        Ok(request.view())
    }
    pub fn pending(&self, now: i64) -> Result<Option<AccessRequest>, String> {
        let _lock = self.lock()?;
        Ok(self.all(now)?.into_iter().find(|r| r.status == "pending"))
    }
    pub fn cancel(&self, id: &str, now: i64) -> Result<Value, String> {
        let _lock = self.lock()?;
        let mut request = self.load(id)?;
        self.refresh(&mut request, now)?;
        if request.status == "pending" {
            request.status = "canceled".into();
            request.updated_at = now;
            self.save(&request)?;
        }
        // authorizing cannot be canceled while a credential may be getting issued.
        Ok(request.view())
    }
    pub fn begin(&self, id: &str, _project_id: &str, now: i64) -> Result<(), String> {
        let _lock = self.lock()?;
        let mut request = self.load(id)?;
        self.refresh(&mut request, now)?;
        if request.status != "pending" {
            return Err("REQUEST_NOT_PENDING: 申请已取消、过期或正在处理，请查询状态。".into());
        }
        // The human may select a different single project in the trusted review window.
        // Keep the original scope immutable; view() reports the approved path as a change.
        request.status = "authorizing".into();
        request.updated_at = now;
        self.save(&request)
    }
    pub fn check_deadline(&self, id: &str, now: i64) -> Result<(), String> {
        let _lock = self.lock()?;
        let request = self.load(id)?;
        if request.status != "authorizing" || now >= request.expires_at {
            return Err("REQUEST_EXPIRED: 审批窗口已结束，没有继续签发凭证。".into());
        }
        Ok(())
    }
    pub fn finish(
        &self,
        id: &str,
        status: &str,
        project: Option<Value>,
        message: Option<String>,
        now: i64,
    ) -> Result<(), String> {
        let _lock = self.lock()?;
        let mut request = self.load(id)?;
        if request.status != "authorizing" {
            return Err("REQUEST_NOT_PENDING: 申请不在审批阶段。".into());
        }
        request.status = status.into();
        request.updated_at = now;
        request.project = project;
        request.message = message;
        self.save(&request)
    }
    pub fn retry(&self, id: &str, now: i64) -> Result<(), String> {
        let _lock = self.lock()?;
        let mut request = self.load(id)?;
        if request.status == "authorizing" {
            request.status = if now >= request.expires_at {
                "expired"
            } else {
                "pending"
            }
            .into();
            request.updated_at = now;
            self.save(&request)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("zerokey-queue-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn queue(&self) -> Queue {
            Queue::new(&self.0)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn request() -> AccessRequest {
        AccessRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: "p".into(),
            name: "demo".into(),
            path: "/demo".into(),
            models: vec!["source/model".into()],
            daily_budget: 1.,
            duration: None,
            reasons: vec![],
            requested_at: 0,
            expires_at: 0,
            updated_at: 0,
            status: "pending".into(),
            project: None,
            message: None,
        }
    }
    #[test]
    fn parallel_submission_deduplicates_and_conflicts() {
        let f = Fixture::new();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let dir = f.0.clone();
                std::thread::spawn(move || {
                    Queue::new(&dir).submit(request(), 100).unwrap().request_id
                })
            })
            .collect();
        let ids: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        let mut different = request();
        different.daily_budget = 2.;
        assert!(f
            .queue()
            .submit(different, 101)
            .unwrap_err()
            .starts_with("REQUEST_CONFLICT"));
    }
    #[test]
    fn cancellation_and_expiry_cannot_be_approved() {
        let f = Fixture::new();
        let q = f.queue();
        let r = q.submit(request(), 100).unwrap();
        assert_eq!(q.cancel(&r.request_id, 101).unwrap()["status"], "canceled");
        let _mutation = try_lock(&f.0, "mutation.lock").unwrap();
        assert!(q.begin(&r.request_id, "p", 102).is_err());
        let next = q.submit(request(), 102).unwrap();
        assert_eq!(
            q.status(&next.request_id, 702).unwrap()["status"],
            "expired"
        );
        assert!(q.begin(&next.request_id, "p", 702).is_err());
    }
    #[test]
    fn authenticating_cannot_claim_cancellation_and_deadline_is_rechecked() {
        let f = Fixture::new();
        let q = f.queue();
        let r = q.submit(request(), 100).unwrap();
        let _mutation = try_lock(&f.0, "mutation.lock").unwrap();
        q.begin(&r.request_id, "p", 101).unwrap();
        assert_eq!(
            q.cancel(&r.request_id, 102).unwrap()["status"],
            "authorizing"
        );
        assert!(q.check_deadline(&r.request_id, 700).is_err());
        q.retry(&r.request_id, 700).unwrap();
        assert_eq!(q.status(&r.request_id, 701).unwrap()["status"], "expired");
    }
    #[test]
    fn final_scope_survives_queries_and_restart() {
        let f = Fixture::new();
        let q = f.queue();
        let r = q.submit(request(), 100).unwrap();
        let _mutation = try_lock(&f.0, "mutation.lock").unwrap();
        q.begin(&r.request_id, "p", 101).unwrap();
        let project = json!({"models":["source/approved-model"],"dailyBudget":0.5});
        q.finish(
            &r.request_id,
            "provisioned",
            Some(project.clone()),
            None,
            102,
        )
        .unwrap();
        for _ in 0..2 {
            let result = f.queue().status(&r.request_id, 103).unwrap();
            assert_eq!(result["requestedScope"]["dailyBudget"], 1.0);
            assert!(result["changes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|change| change["field"] == "dailyBudget"
                    && change["requested"] == 1.0
                    && change["approved"] == 0.5));
            assert_eq!(
                f.queue().status(&r.request_id, 103).unwrap()["project"],
                project
            );
        }
        assert_eq!(
            q.cancel(&r.request_id, 103).unwrap()["status"],
            "provisioned"
        );
        assert!(q.status(&r.request_id, 102 + RETENTION_SECONDS).is_err());
    }
    #[test]
    fn crashed_approval_fails_without_automatic_reissue() {
        let f = Fixture::new();
        let q = f.queue();
        let r = q.submit(request(), 100).unwrap();
        {
            let _mutation = try_lock(&f.0, "mutation.lock").unwrap();
            q.begin(&r.request_id, "p", 101).unwrap();
        }
        assert_eq!(q.status(&r.request_id, 102).unwrap()["status"], "failed");
        assert!(q.pending(103).unwrap().is_none());
    }
    #[test]
    fn independent_processes_share_one_queue() {
        const CHILD: &str = "ZEROKEY_UNIT_QUEUE_CHILD";
        if let Some(directory) = std::env::var_os(CHILD) {
            Queue::new(Path::new(&directory))
                .submit(request(), 100)
                .unwrap();
            return;
        }
        let fixture = Fixture::new();
        let mut children: Vec<_> = (0..4)
            .map(|_| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "requests::tests::independent_processes_share_one_queue",
                    ])
                    .env(CHILD, &fixture.0)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .unwrap()
            })
            .collect();
        for child in &mut children {
            assert!(child.wait().unwrap().success());
        }
        assert_eq!(fixture.queue().all(101).unwrap().len(), 1);
    }
}
