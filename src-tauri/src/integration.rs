use crate::broker::{safe_write, Broker};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::Path,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{Manager, State};

fn runtime_node(resources: &Path) -> Result<std::path::PathBuf, String> {
    use sha2::{Digest, Sha256};
    let manifest: Value = serde_json::from_slice(
        &fs::read(resources.join("runtime/manifest.json"))
            .map_err(|_| "应用运行时缺失，请重新安装。")?,
    )
    .map_err(|_| "应用运行时配置无效。")?;
    let hash = manifest["sha256"]
        .as_str()
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("应用运行时校验值无效。")?;
    let directory = dirs::cache_dir()
        .ok_or("无法找到本机缓存目录。")?
        .join("app.zerokey.desktop/runtime");
    fs::create_dir_all(&directory).map_err(|_| "无法创建运行时缓存。")?;
    let target = directory.join(format!("node-{hash}.exe"));
    let source = resources.join("runtime/node.exe");
    let size = fs::metadata(&source).map_err(|_| "应用运行时缺失。")?.len();
    if fs::metadata(&target).map(|m| m.len()).ok() != Some(size) {
        let bytes = fs::read(source).map_err(|_| "无法读取应用运行时。")?;
        if format!("{:x}", Sha256::digest(&bytes)) != hash {
            return Err("应用运行时校验失败，请重新安装。".into());
        }
        let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, bytes).map_err(|_| "无法保存运行时缓存。")?;
        let renamed = fs::rename(&temporary, &target);
        let _ = fs::remove_file(&temporary);
        if renamed.is_err() && !target.is_file() {
            return Err("无法保存运行时缓存。".into());
        }
    }
    Ok(target)
}

pub fn session(directory: &Path, body: Value) -> Result<Value, String> {
    let pid = body["pid"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= u32::MAX as u64)
        .ok_or("INVALID_INPUT: 无效的连接编号。")?;
    let client = body["client"].as_str().unwrap_or("unknown");
    let client: String = client
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect();
    let folder = directory.join("connections");
    fs::create_dir_all(&folder).map_err(|_| "CONFIG_ACCESS_DENIED: 无法保存本机连接状态。")?;
    let path = folder.join(format!("{pid}.json"));
    if body["closed"] == true {
        let _ = fs::remove_file(path);
    } else {
        safe_write(
            &path,
            &json!({"pid":pid,"client":client,"toolsAvailable":body["toolsAvailable"] == true,"updatedAt":chrono::Utc::now().timestamp()}),
        )?;
    }
    Ok(json!({"recorded":true}))
}

#[tauri::command]
pub async fn agent_integration(
    app: tauri::AppHandle,
    state: State<'_, Arc<Broker>>,
    client: String,
    install: bool,
) -> Result<Value, String> {
    if !matches!(client.as_str(), "codex" | "claude" | "opencode") {
        return Err("请选择支持的 Agent 客户端。".into());
    }
    let directory = state.directory.clone();
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "无法找到应用资源目录。")?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let bundled = resources.join("runtime/node.exe");
        let (node, entry) = if bundled.is_file() {
            (
                runtime_node(&resources)?,
                resources.join("agent/integration.mjs"),
            )
        } else if cfg!(debug_assertions) {
            ("node".into(), root.join("scripts/integration.ts"))
        } else {
            return Err("应用运行时缺失，请重新安装 ZeroKey。".into());
        };
        let mut command = std::process::Command::new(node);
        command
            .arg(entry)
            .arg(&client)
            .arg(if install { "install" } else { "status" })
            .arg(directory)
            .env_remove("NODE_OPTIONS")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动 Node.js；请安装 Node 22.18 或更新版本。")?;
        let pipe = child.stdout.take().ok_or("无法读取客户端接入状态。")?;
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.take(32769).read_to_end(&mut bytes).map(|_| bytes)
        });
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if start.elapsed() < Duration::from_secs(10) => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("客户端接入检查超时，请重试或使用配置片段。".into());
                }
            }
        };
        let output = reader
            .join()
            .map_err(|_| "接入检查未完成。")?
            .map_err(|_| "无法读取客户端接入状态。")?;
        if !status.success() || output.len() > 32768 {
            return Err("无法读取客户端配置，请检查文件权限或使用配置片段接入。".into());
        }
        serde_json::from_slice(&output).map_err(|_| "客户端配置检查返回无效数据。".into())
    })
    .await
    .map_err(|_| "接入检查未完成。".to_string())?
}
