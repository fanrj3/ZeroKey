//! Only the official GitHub endpoint and embedded signing key are used; no arbitrary URL IPC.
use crate::{broker::Broker, desktop::Desktop, requests};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    current_version: String,
    status: String,
    version: Option<String>,
    notes: Option<String>,
    checked_at: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
}
struct Inner {
    view: UpdateView,
    update: Option<Update>,
}
pub struct Updates {
    inner: Mutex<Inner>,
    busy: AtomicBool,
}

impl Updates {
    fn new(version: String) -> Self {
        Self {
            inner: Mutex::new(Inner {
                view: UpdateView {
                    current_version: version,
                    status: "idle".into(),
                    version: None,
                    notes: None,
                    checked_at: None,
                    downloaded: 0,
                    total: None,
                    error: None,
                },
                update: None,
            }),
            busy: AtomicBool::new(false),
        }
    }
}

fn publish(app: &tauri::AppHandle, edit: impl FnOnce(&mut Inner)) -> UpdateView {
    let state = app.state::<Updates>();
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    edit(&mut inner);
    let view = inner.view.clone();
    let _ = app.emit("update-status", &view);
    view
}

fn safe_error(error: &tauri_plugin_updater::Error, installing: bool) -> String {
    use tauri_plugin_updater::Error::*;
    match error {
        Minisign(_)
        | Base64(_)
        | SignatureUtf8(_)
        | SignedVersionMismatch { .. }
        | MissingSignedVersion => {
            "更新签名校验失败，已停止安装。请重新检查更新或从官方 Release 下载安装包。".into()
        }
        TargetNotFound(_) | TargetsNotFound(_) => "此版本尚未提供当前平台的更新包。".into(),
        Reqwest(_) | Network(_) | ReleaseNotFound => {
            "无法连接 GitHub 更新服务，请检查网络后重试。".into()
        }
        _ if installing => {
            "更新未能安装，当前版本仍可使用。请重试或从官方 Release 手动安装。".into()
        }
        _ => "更新信息无效，请稍后重试或查看官方 Release。".into(),
    }
}

pub async fn check(app: &tauri::AppHandle) -> UpdateView {
    let state = app.state::<Updates>();
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return update_status(app.clone());
    }
    publish(app, |inner| {
        inner.view.status = "checking".into();
        inner.view.error = None;
    });
    let result = match app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let view = publish(app, |inner| {
        inner.view.checked_at = Some(chrono::Utc::now().to_rfc3339());
        match result {
            Ok(update) => {
                inner.view.status = if update.is_some() {
                    "available"
                } else {
                    "latest"
                }
                .into();
                inner.view.version = update.as_ref().map(|u| u.version.clone());
                inner.view.notes = update.as_ref().and_then(|u| u.body.clone());
                inner.view.downloaded = 0;
                inner.view.total = None;
                inner.update = update;
            }
            Err(error) => {
                inner.view.status = "error".into();
                inner.view.error = Some(safe_error(&error, false));
            }
        }
    });
    state.busy.store(false, Ordering::SeqCst);
    view
}

pub fn setup(app: &tauri::AppHandle) {
    app.manage(Updates::new(app.package_info().version.to_string()));
    let handle = app.clone();
    // Rust owns the schedule, including when all application windows are hidden.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        loop {
            tauri::async_runtime::block_on(check(&handle));
            std::thread::sleep(Duration::from_secs(6 * 60 * 60));
        }
    });
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> UpdateView {
    app.state::<Updates>()
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .view
        .clone()
}
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> UpdateView {
    check(&app).await
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在主窗口的设置中安装更新。".into());
    }
    let state = app.state::<Updates>();
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("更新操作正在进行，请稍候。".into());
    }
    let update = state
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .update
        .clone();
    let result = async {
        let update = update.ok_or("请先检查更新。")?;
        // The manifest never gets to point a downloader at a local or plaintext URL.
        if update.download_url.scheme() != "https"
            || update.download_url.host_str() != Some("github.com")
            || !update
                .download_url
                .path()
                .starts_with("/fanrj3/ZeroKey/releases/download/")
        {
            return Err("更新包地址无效，已停止下载。".into());
        }
        publish(&app, |inner| {
            inner.view.status = "downloading".into();
            inner.view.error = None;
            inner.view.downloaded = 0;
            inner.view.total = None;
        });
        let mut downloaded = 0_u64;
        let mut last = std::time::Instant::now();
        let bytes = update
            .download(
                |size, total| {
                    downloaded += size as u64;
                    if last.elapsed() >= Duration::from_millis(100) {
                        publish(&app, |inner| {
                            inner.view.downloaded = downloaded;
                            inner.view.total = total;
                        });
                        last = std::time::Instant::now();
                    }
                },
                || {},
            )
            .await
            .map_err(|error| safe_error(&error, true))?;
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // Prevent native approval and cross-process issuance/revocation during replacement.
            let desktop = handle.state::<Desktop>();
            if desktop
                .authorizing
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Err("正在完成本机授权，请完成后重新安装更新。".into());
            }
            let result: Result<(), String> = (|| {
                let broker = handle.state::<Arc<Broker>>();
                let _lock = requests::try_lock(&broker.directory, "mutation.lock")
                    .map_err(|_| "另一个凭证操作正在进行，请稍后重新安装更新。")?;
                publish(&handle, |inner| {
                    inner.view.status = "installing".into();
                    inner.view.downloaded = bytes.len() as u64;
                });
                update
                    .install(&bytes)
                    .map_err(|error| safe_error(&error, true))?;
                #[cfg(not(windows))]
                handle.restart();
                #[cfg(windows)]
                Ok(())
            })();
            desktop.authorizing.store(false, Ordering::SeqCst);
            result
        })
        .await
        .map_err(|_| "更新任务未能完成，请重试。".to_string())?
    }
    .await;
    if let Err(error) = &result {
        publish(&app, |inner| {
            inner.view.status = "error".into();
            inner.view.error = Some(error.clone());
        });
    }
    state.busy.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_and_network_failures_have_distinct_recovery() {
        assert!(
            safe_error(&tauri_plugin_updater::Error::MissingSignedVersion, true).contains("签名")
        );
        assert!(safe_error(&tauri_plugin_updater::Error::ReleaseNotFound, false).contains("网络"));
    }
}
