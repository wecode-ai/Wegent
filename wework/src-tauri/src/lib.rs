mod wecode;

use wecode::local_executor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_executor::detect_wecode_cli,
            local_executor::get_executor_status,
            local_executor::get_local_executor_auth_token,
            local_executor::save_local_executor_auth_token,
            local_executor::get_startup_env,
            local_executor::save_startup_env,
            local_executor::run_executor_command,
            local_executor::open_executor_logs_directory,
            local_executor::get_executor_process_diagnostics,
            local_executor::kill_executor_processes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
