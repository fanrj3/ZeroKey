//! Desktop lifetime and review notifications live in Rust, including while all webviews are hidden.
use crate::{broker::Broker, requests::Queue};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    image::Image,
    menu::{IconMenuItem, Menu, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager,
};

pub struct Desktop {
    pub authorizing: AtomicBool,
}

// Official Lucide assets, rasterized once at build time; no image-decoding dependency.
fn menu_item(
    app: &tauri::AppHandle,
    id: &str,
    text: &str,
    enabled: bool,
    rgba: &'static [u8; 16 * 16 * 4],
) -> tauri::Result<IconMenuItem<tauri::Wry>> {
    IconMenuItem::with_id(
        app,
        id,
        text,
        enabled,
        Some(Image::new(rgba, 16, 16)),
        None::<&str>,
    )
}

pub fn show_main(app: &tauri::AppHandle, page: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("navigate", page);
    }
}

pub fn show_approval(app: &tauri::AppHandle) {
    if app.state::<Desktop>().authorizing.load(Ordering::SeqCst) {
        return;
    }
    let broker = app.state::<Arc<Broker>>();
    if !matches!(
        Queue::new(&broker.directory).pending(chrono::Utc::now().timestamp()),
        Ok(Some(_))
    ) {
        return;
    }
    if let Some(window) = app.get_webview_window("approval") {
        let _ = window.set_always_on_top(true);
        let _ = window.emit("approval-request", ());
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup(
    app: &tauri::AppHandle,
    broker: Arc<Broker>,
) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Desktop {
        authorizing: AtomicBool::new(false),
    });
    let gateway = menu_item(
        app,
        "gateway-status",
        "网关 · 正在检查",
        false,
        include_bytes!("../icons/menu/gateway.rgba"),
    )?;
    let projects = menu_item(
        app,
        "project-stats",
        "项目 · 正在读取",
        false,
        include_bytes!("../icons/menu/projects.rgba"),
    )?;
    let usage = menu_item(
        app,
        "usage-stats",
        "当前预算周期用量 · 等待检查",
        false,
        include_bytes!("../icons/menu/usage.rgba"),
    )?;
    let checked = menu_item(
        app,
        "checked",
        "尚未完成检查",
        false,
        include_bytes!("../icons/menu/checked.rgba"),
    )?;
    let review = menu_item(
        app,
        "review",
        "暂无待审核申请",
        false,
        include_bytes!("../icons/menu/review.rgba"),
    )?;
    let open = menu_item(
        app,
        "open",
        "打开 ZeroKey",
        true,
        include_bytes!("../icons/menu/open.rgba"),
    )?;
    let settings = menu_item(
        app,
        "settings",
        "设置与 Agent 接入",
        true,
        include_bytes!("../icons/menu/settings.rgba"),
    )?;
    let refresh = menu_item(
        app,
        "refresh",
        "刷新统计",
        true,
        include_bytes!("../icons/menu/refresh.rgba"),
    )?;
    let updates = menu_item(
        app,
        "updates",
        "检查更新",
        true,
        include_bytes!("../icons/menu/refresh.rgba"),
    )?;
    let updates_menu = updates.clone();
    app.listen("update-status", move |event| {
        if let Ok(view) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            let text = match view["status"].as_str() {
                Some("available") => format!(
                    "更新可用 · v{}",
                    view["version"].as_str().unwrap_or_default()
                ),
                Some("checking") => "正在检查更新…".into(),
                Some("downloading") => "正在下载更新…".into(),
                _ => "检查更新".into(),
            };
            let _ = updates_menu.set_text(text);
        }
    });
    let quit = menu_item(
        app,
        "quit",
        "退出 ZeroKey",
        true,
        include_bytes!("../icons/menu/quit.rgba"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &gateway,
            &projects,
            &usage,
            &checked,
            &separator,
            &open,
            &review,
            &settings,
            &refresh,
            &updates,
            &separator2,
            &quit,
        ],
    )?;
    let refresh_requested = Arc::new(AtomicBool::new(true));
    let refresh_menu = refresh_requested.clone();
    // Use the bundled application's icon; no external icon/font dependency at runtime.
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("缺少应用图标，无法启动托盘。")?;
    TrayIconBuilder::with_id("zerokey")
        .icon(icon)
        .tooltip("ZeroKey · 后台待命")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app, "projects"),
            "settings" => show_main(app, "settings"),
            "updates" => {
                show_main(app, "settings");
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::updates::check(&app).await;
                });
            }
            "review" => show_approval(app),
            "refresh" => {
                refresh_menu.store(true, Ordering::SeqCst);
            }
            "quit" => {
                if !app.state::<Desktop>().authorizing.load(Ordering::SeqCst) {
                    app.exit(0);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle(), "projects");
            }
        })
        .build(app)?;
    let summary_broker = broker.clone();
    let refresh_summary = refresh_requested.clone();
    let tray_app = app.clone();
    std::thread::spawn(move || {
        let mut tick = 0_u64;
        loop {
            if tick.is_multiple_of(80) || refresh_summary.swap(false, Ordering::SeqCst) {
                match summary_broker.tray_summary() {
                    Ok((connected, count, active, spend)) => {
                        let _ = gateway.set_text(if connected {
                            "网关 · 已连接"
                        } else {
                            "网关 · 未连接（用量待更新）"
                        });
                        let _ = projects.set_text(if connected {
                            format!("项目 · {active} 个已确认有效 / 共 {count} 个")
                        } else {
                            format!("项目 · 共 {count} 个，状态待更新")
                        });
                        let _ = usage.set_text(if connected {
                            format!("当前预算周期估算 · ${spend:.6}")
                        } else {
                            "当前预算周期用量 · 无法读取".into()
                        });
                        let _ = checked.set_text(format!(
                            "上次检查 · {}",
                            chrono::Local::now().format("%H:%M:%S")
                        ));
                        if let Some(tray) = tray_app.tray_by_id("zerokey") {
                            let _ = tray.set_tooltip(Some(format!(
                                "ZeroKey · {count} 个项目 · {}",
                                if connected {
                                    format!("本周期估算 ${spend:.6}")
                                } else {
                                    "网关未连接".into()
                                }
                            )));
                        }
                    }
                    Err(_) => {
                        let _ = gateway.set_text("状态读取失败 · 请打开设置检查");
                        let _ = usage.set_text("用量读取失败 · 请刷新重试");
                    }
                }
            }
            tick += 1;
            std::thread::sleep(std::time::Duration::from_millis(750));
        }
    });
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut shown = String::new();
        loop {
            if let Ok(Some(request)) =
                Queue::new(&broker.directory).pending(chrono::Utc::now().timestamp())
            {
                let _ = review.set_text(format!("审核申请 · {}", request.name));
                let _ = review.set_enabled(true);
                if shown != request.request_id
                    && !handle.state::<Desktop>().authorizing.load(Ordering::SeqCst)
                {
                    shown = request.request_id;
                    show_approval(&handle);
                }
            } else {
                let _ = review.set_text("暂无待审核申请");
                let _ = review.set_enabled(false);
            }
            let command = broker.directory.join("desktop-command.json");
            if let Ok(data) = std::fs::read(&command) {
                let _ = std::fs::remove_file(&command);
                if let Ok(page) = serde_json::from_slice::<String>(&data) {
                    if matches!(page.as_str(), "projects" | "settings") {
                        show_main(&handle, &page);
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(750));
        }
    });
    Ok(())
}

#[tauri::command]
pub fn dismiss_approval(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<Desktop>().authorizing.load(Ordering::SeqCst) {
        return Err("正在完成本机验证，请稍候。".into());
    }
    if let Some(window) = app.get_webview_window("approval") {
        window.hide().map_err(|_| "无法隐藏审核窗口。")?;
    }
    Ok(())
}
