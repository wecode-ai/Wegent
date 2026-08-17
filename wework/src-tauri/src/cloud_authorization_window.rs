#[cfg(target_os = "macos")]
use std::time::Duration;

use tauri::Manager;

use crate::MAIN_WINDOW_LABEL;

const AUTHORIZATION_WINDOW_LABEL: &str = "cloud-authorization";
const AUTHORIZATION_WINDOW_VERTICAL_OFFSET: f64 = 36.0;

fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    value.max(minimum).min(maximum)
}

#[cfg(target_os = "macos")]
fn position_on_macos(
    main_window: &tauri::WebviewWindow,
    authorization_window: &tauri::WebviewWindow,
) -> Result<(), String> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::NSPoint;

    let main_ns_window: &NSWindow = unsafe {
        &*main_window
            .ns_window()
            .map_err(|error| format!("Failed to access the native Wework window: {error}"))?
            .cast()
    };
    let authorization_ns_window: &NSWindow = unsafe {
        &*authorization_window
            .ns_window()
            .map_err(|error| format!("Failed to access the native authorization window: {error}"))?
            .cast()
    };
    let screen = main_ns_window
        .screen()
        .ok_or_else(|| "The Wework window is not on an available macOS screen".to_string())?;
    let visible_frame = screen.visibleFrame();
    let main_frame = main_ns_window.frame();
    let authorization_frame = authorization_ns_window.frame();
    let maximum_x = (visible_frame.origin.x + visible_frame.size.width
        - authorization_frame.size.width)
        .max(visible_frame.origin.x);
    let maximum_y = (visible_frame.origin.y + visible_frame.size.height
        - authorization_frame.size.height)
        .max(visible_frame.origin.y);
    let desired_x =
        main_frame.origin.x + (main_frame.size.width - authorization_frame.size.width) / 2.0;
    let desired_y = main_frame.origin.y
        + (main_frame.size.height - authorization_frame.size.height) / 2.0
        + AUTHORIZATION_WINDOW_VERTICAL_OFFSET;
    // AppKit frames share one logical desktop coordinate space across Retina and non-Retina
    // screens, avoiding Tao's current-window scale conversion during cross-screen moves.
    let target = NSPoint::new(
        clamp(desired_x, visible_frame.origin.x, maximum_x),
        clamp(desired_y, visible_frame.origin.y, maximum_y),
    );
    authorization_ns_window.setFrameOrigin(target);

    let positioned_frame = authorization_ns_window.frame();
    let intersects_visible_frame = positioned_frame.origin.x
        < visible_frame.origin.x + visible_frame.size.width
        && positioned_frame.origin.x + positioned_frame.size.width > visible_frame.origin.x
        && positioned_frame.origin.y < visible_frame.origin.y + visible_frame.size.height
        && positioned_frame.origin.y + positioned_frame.size.height > visible_frame.origin.y;
    if !intersects_visible_frame {
        return Err(
            "The authorization window is outside the visible macOS screen area".to_string(),
        );
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn position_on_other_desktop(
    main_window: &tauri::WebviewWindow,
    authorization_window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let monitor = main_window
        .current_monitor()
        .map_err(|error| format!("Failed to locate the Wework monitor: {error}"))?
        .or_else(|| main_window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor is available for the authorization window".to_string())?;
    let main_position = main_window
        .outer_position()
        .map_err(|error| format!("Failed to read the Wework window position: {error}"))?;
    let main_size = main_window
        .outer_size()
        .map_err(|error| format!("Failed to read the Wework window size: {error}"))?;
    let authorization_size = authorization_window
        .outer_size()
        .map_err(|error| format!("Failed to read the authorization window size: {error}"))?;
    let work_area = monitor.work_area();
    let maximum_x = (work_area.position.x as i64 + work_area.size.width as i64
        - authorization_size.width as i64)
        .max(work_area.position.x as i64);
    let maximum_y = (work_area.position.y as i64 + work_area.size.height as i64
        - authorization_size.height as i64)
        .max(work_area.position.y as i64);
    let desired_x =
        main_position.x as i64 + (main_size.width as i64 - authorization_size.width as i64) / 2;
    let desired_y = main_position.y as i64
        + (main_size.height as i64 - authorization_size.height as i64) / 2
        - (AUTHORIZATION_WINDOW_VERTICAL_OFFSET * monitor.scale_factor()).round() as i64;
    let x = desired_x.max(work_area.position.x as i64).min(maximum_x) as i32;
    let y = desired_y.max(work_area.position.y as i64).min(maximum_y) as i32;
    authorization_window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| format!("Failed to position the authorization window: {error}"))
}

#[tauri::command]
pub async fn position_cloud_authorization_window(app: tauri::AppHandle) -> Result<(), String> {
    let main_window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "The Wework main window is unavailable".to_string())?;
    let authorization_window = app
        .get_webview_window(AUTHORIZATION_WINDOW_LABEL)
        .ok_or_else(|| "The cloud authorization window is unavailable".to_string())?;

    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(position_on_macos(&main_window, &authorization_window));
        })
        .map_err(|error| format!("Failed to schedule authorization window positioning: {error}"))?;
        return tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "Timed out positioning the authorization window".to_string())?
        })
        .await
        .map_err(|error| format!("Failed to join authorization window positioning: {error}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        position_on_other_desktop(&main_window, &authorization_window)
    }
}
