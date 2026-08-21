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
    ($($(#[$host_command_attr:meta])* $host_command:path),* $(,)?) => {
        tauri::generate_handler![
            $crate::wecode::vnc_session::get_vnc_external_bridge_url,
            $crate::wecode::vnc_session::prepare_vnc_session,
            $($(#[$host_command_attr])* $host_command),*
        ]
    };
}

pub(crate) use invoke_handler;
