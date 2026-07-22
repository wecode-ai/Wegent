pub mod local_executor;
pub mod vnc_session;

use tauri::Manager;

pub fn setup(app: &mut tauri::App) {
    app.manage(vnc_session::VncSessionState::default());

    #[cfg(desktop)]
    if let Err(error) = vnc_session::start_vnc_external_bridge(app.handle().clone()) {
        log::warn!("Failed to start VNC external bridge: {error}");
    }
}

macro_rules! invoke_handler {
    ($($host_command:path),* $(,)?) => {
        tauri::generate_handler![
            $crate::wecode::local_executor::detect_wecode_cli,
            $crate::wecode::local_executor::get_executor_process_diagnostics,
            $crate::wecode::local_executor::get_executor_status,
            $crate::wecode::local_executor::get_local_executor_auth_token,
            $crate::wecode::local_executor::get_startup_env,
            $crate::wecode::local_executor::kill_executor_processes,
            $crate::wecode::vnc_session::get_vnc_external_bridge_url,
            $crate::wecode::vnc_session::get_vnc_session_config,
            $crate::wecode::vnc_session::prepare_vnc_session,
            $crate::wecode::local_executor::open_executor_logs_directory,
            $crate::wecode::local_executor::run_executor_command,
            $crate::wecode::local_executor::save_local_executor_auth_token,
            $crate::wecode::local_executor::save_startup_env,
            $($host_command),*
        ]
    };
}

pub(crate) use invoke_handler;
