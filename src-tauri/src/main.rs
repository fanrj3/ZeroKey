#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod broker;
mod desktop;
mod integration;
mod native;
mod requests;
mod sources;
mod updates;

fn main() {
    if let Some(code) = broker::run_cli() {
        std::process::exit(code);
    }
    if broker::forward_existing_desktop() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let broker = broker::Broker::new(app.handle())?;
            let broker = std::sync::Arc::new(broker);
            tauri::Manager::manage(app, broker.clone());
            desktop::setup(app.handle(), broker)?;
            updates::setup(app.handle());
            sources::setup(app.handle());
            if std::env::args().any(|arg| arg == "--background") {
                if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                    window.hide()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "approval" {
                    use tauri::Manager;
                    if window
                        .app_handle()
                        .state::<desktop::Desktop>()
                        .authorizing
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        return;
                    }
                    let broker = window
                        .app_handle()
                        .state::<std::sync::Arc<broker::Broker>>();
                    if let Ok(Some(request)) = requests::Queue::new(&broker.directory)
                        .pending(chrono::Utc::now().timestamp())
                    {
                        if requests::Queue::new(&broker.directory)
                            .cancel(&request.request_id, chrono::Utc::now().timestamp())
                            .is_err()
                        {
                            return;
                        }
                    }
                    let _ = desktop::hide_approval(window.app_handle());
                    return;
                }
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            broker::snapshot,
            broker::create_grant,
            broker::revoke_grant,
            broker::test_grant,
            broker::connect_gateway,
            broker::set_app_pin,
            broker::open_dashboard,
            broker::pending_request,
            broker::cancel_request,
            broker::request_status,
            desktop::dismiss_approval,
            integration::agent_integration,
            updates::update_status,
            updates::check_update,
            updates::install_update,
            sources::source_status,
            sources::check_source,
            sources::apply_source_models,
            sources::set_source_auto_add,
        ])
        .run(tauri::generate_context!())
        .expect("Could not start the ZeroKey desktop application");
}
