use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    utils::config::BackgroundThrottlingPolicy, AppHandle, Manager, PhysicalPosition, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub(crate) const WINDOW_LABEL: &str = "popout-window";
const COLLAPSED_WINDOW_WIDTH: f64 = 680.0;
const COLLAPSED_WINDOW_HEIGHT: f64 = 640.0;
const COLLAPSED_SURFACE_WIDTH: f64 = 470.0;
const COLLAPSED_SURFACE_HEIGHT: f64 = 112.0;
const EXPANDED_WIDTH: f64 = 470.0;
const EXPANDED_HEIGHT: f64 = 640.0;

pub struct PopoutWindowState {
    registered_shortcut: Mutex<Option<Shortcut>>,
    previous_frontmost_pid: Mutex<Option<i32>>,
    expanded: AtomicBool,
    overlay_active: AtomicBool,
    mouse_events_ignored: AtomicBool,
}

impl Default for PopoutWindowState {
    fn default() -> Self {
        Self {
            registered_shortcut: Mutex::new(None),
            previous_frontmost_pid: Mutex::new(None),
            expanded: AtomicBool::new(false),
            overlay_active: AtomicBool::new(false),
            mouse_events_ignored: AtomicBool::new(false),
        }
    }
}

pub fn setup(app: &AppHandle, shortcut: Option<&str>) {
    if let Err(error) = configure_shortcut(app, shortcut) {
        log::warn!("Failed to register Popout Window shortcut: {error}");
    }
    if let Err(error) = ensure_window(app) {
        log::warn!("Failed to prewarm Popout Window: {error}");
    }
    setup_mouse_passthrough_monitor(app.clone());
}

pub fn configure_shortcut(app: &AppHandle, shortcut: Option<&str>) -> Result<(), String> {
    let normalized = shortcut
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let parsed = normalized
        .as_deref()
        .map(str::parse::<Shortcut>)
        .transpose()
        .map_err(|error| format!("Invalid Popout Window shortcut: {error}"))?;
    let state = app.state::<PopoutWindowState>();
    let mut registered = state
        .registered_shortcut
        .lock()
        .map_err(|_| "Failed to lock Popout Window shortcut state".to_string())?;

    if *registered == parsed {
        return Ok(());
    }
    if let Some(previous) = *registered {
        app.global_shortcut()
            .unregister(previous)
            .map_err(|error| format!("Failed to unregister shortcut {previous}: {error}"))?;
    }
    if let Some(next) = parsed {
        if let Err(error) = app.global_shortcut().register(next) {
            if let Some(previous) = *registered {
                let _ = app.global_shortcut().register(previous);
            }
            return Err(format!(
                "Shortcut {} is unavailable: {error}",
                normalized.as_deref().unwrap_or_default()
            ));
        }
    }
    *registered = parsed;
    Ok(())
}

pub fn matches_shortcut(app: &AppHandle, shortcut: &Shortcut) -> bool {
    app.state::<PopoutWindowState>()
        .registered_shortcut
        .lock()
        .ok()
        .and_then(|registered| *registered)
        .is_some_and(|registered| registered == *shortcut)
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    remember_frontmost_application(app);
    let window = ensure_window(app)?;
    window
        .show()
        .map_err(|error| format!("Failed to show Popout Window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus Popout Window: {error}"))?;
    activate_popout_window(&window)?;
    update_mouse_passthrough(app)
}

#[cfg(target_os = "macos")]
fn activate_popout_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWindow};

    let main_thread_window = window.clone();
    window
        .run_on_main_thread(move || {
            let application = NSRunningApplication::currentApplication();
            if !application.activateWithOptions(NSApplicationActivationOptions::empty()) {
                log::warn!("Failed to activate Wework before focusing Popout Window");
            }
            let Ok(ns_window) = main_thread_window.ns_window() else {
                log::warn!("Failed to access native Popout Window");
                return;
            };
            let ns_window = unsafe { &*(ns_window as *const NSWindow) };
            ns_window.makeKeyAndOrderFront(None);
        })
        .map_err(|error| format!("Failed to activate Popout Window: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn activate_popout_window(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

fn ensure_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("/popout".into()))
        .title("Wework")
        .inner_size(COLLAPSED_WINDOW_WIDTH, COLLAPSED_WINDOW_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .visible(false)
        // The hidden WebView must finish bootstrapping at application startup so the first
        // shortcut invocation only needs to reveal and focus the already initialized window.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
        .map_err(|error| format!("Failed to create Popout Window: {error}"))?;
    center_collapsed_surface_on_monitor(&window)?;
    Ok(window)
}

fn remember_frontmost_application(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;

        let Some(application) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
            return;
        };
        let frontmost_pid = application.processIdentifier();
        let current_pid = std::process::id() as i32;
        let popout_is_focused = app
            .get_webview_window(WINDOW_LABEL)
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false);
        let state = app.state::<PopoutWindowState>();
        let Ok(mut previous_pid) = state.previous_frontmost_pid.lock() else {
            return;
        };

        if frontmost_pid != current_pid || !popout_is_focused {
            *previous_pid = Some(frontmost_pid);
            log::debug!(
                "Remembered Popout Window foreground application: pid={frontmost_pid}, current_pid={current_pid}"
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
fn activate_application(process_id: i32) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    NSRunningApplication::runningApplicationWithProcessIdentifier(process_id).is_some_and(
        |application| application.activateWithOptions(NSApplicationActivationOptions::empty()),
    )
}

fn restore_previous_frontmost_application(app: &AppHandle, process_id: Option<i32>) {
    #[cfg(target_os = "macos")]
    {
        let Some(process_id) = process_id else {
            return;
        };
        if process_id == std::process::id() as i32 {
            log::debug!("Popout Window was opened from Wework; keeping Wework active");
            return;
        }

        log::debug!("Restoring Popout Window foreground application: pid={process_id}");
        let activated_immediately = activate_application(process_id);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let _ = app.run_on_main_thread(move || {
                if !activate_application(process_id) {
                    log::debug!(
                        "The application that preceded Popout Window is no longer available"
                    );
                } else if !activated_immediately {
                    log::debug!(
                        "Restored Popout Window foreground application on the second attempt"
                    );
                }
            });
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = process_id;
    }
}

fn center_collapsed_surface_on_monitor(window: &tauri::WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("Failed to locate Popout Window monitor: {error}"))?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor is available for Popout Window".to_string())?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let window_size = window
        .outer_size()
        .map_err(|error| format!("Failed to read Popout Window size: {error}"))?;
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("Failed to read Popout Window scale factor: {error}"))?;
    let surface_height = COLLAPSED_SURFACE_HEIGHT * scale_factor;
    let x =
        monitor_position.x + ((monitor_size.width.saturating_sub(window_size.width)) / 2) as i32;
    let visible_surface_top = (monitor_size.height as f64 - surface_height) / 2.0;
    let y = monitor_position.y
        + (visible_surface_top - (window_size.height as f64 - surface_height)).round() as i32;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("Failed to position Popout Window: {error}"))
}

fn cursor_is_inside_collapsed_surface(window: &tauri::WebviewWindow) -> bool {
    let (Ok(cursor), Ok(position), Ok(size), Ok(scale_factor)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
        window.scale_factor(),
    ) else {
        return false;
    };
    let surface_width = COLLAPSED_SURFACE_WIDTH * scale_factor;
    let surface_height = COLLAPSED_SURFACE_HEIGHT * scale_factor;
    let left = position.x as f64 + (size.width as f64 - surface_width) / 2.0;
    let top = position.y as f64 + size.height as f64 - surface_height;

    cursor.x >= left
        && cursor.x < left + surface_width
        && cursor.y >= top
        && cursor.y < top + surface_height
}

fn visible_surface_center(
    position_x: f64,
    position_y: f64,
    width: f64,
    height: f64,
    expanded: bool,
    scale_factor: f64,
) -> (f64, f64) {
    let center_x = position_x + width / 2.0;
    let center_y = if expanded {
        position_y + height / 2.0
    } else {
        position_y + height - COLLAPSED_SURFACE_HEIGHT * scale_factor / 2.0
    };
    (center_x, center_y)
}

fn window_position_for_surface_center(
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    expanded: bool,
    scale_factor: f64,
) -> (f64, f64) {
    let x = center_x - width / 2.0;
    let y = if expanded {
        center_y - height / 2.0
    } else {
        center_y - height + COLLAPSED_SURFACE_HEIGHT * scale_factor / 2.0
    };
    (x, y)
}

fn update_mouse_passthrough(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(());
    };
    if !window
        .is_visible()
        .map_err(|error| format!("Failed to read Popout Window visibility: {error}"))?
    {
        return Ok(());
    }

    let state = app.state::<PopoutWindowState>();
    let should_ignore = !state.expanded.load(Ordering::Relaxed)
        && !state.overlay_active.load(Ordering::Relaxed)
        && !cursor_is_inside_collapsed_surface(&window);
    if state
        .mouse_events_ignored
        .swap(should_ignore, Ordering::SeqCst)
        == should_ignore
    {
        return Ok(());
    }
    window
        .set_ignore_cursor_events(should_ignore)
        .map_err(|error| format!("Failed to update Popout Window mouse passthrough: {error}"))
}

#[cfg(target_os = "macos")]
fn setup_mouse_passthrough_monitor(app: AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};

    let global_app = app.clone();
    let global_handler = RcBlock::new(move |_event: std::ptr::NonNull<NSEvent>| {
        if let Err(error) = update_mouse_passthrough(&global_app) {
            log::debug!("Failed to update Popout Window from global mouse movement: {error}");
        }
    });
    // AppKit owns the monitor until process exit; leaking the returned token keeps it active.
    if let Some(monitor) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::MouseMoved,
        &global_handler,
    ) {
        std::mem::forget(monitor);
    }

    let local_handler = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
        if let Err(error) = update_mouse_passthrough(&app) {
            log::debug!("Failed to update Popout Window from local mouse movement: {error}");
        }
        event.as_ptr()
    });
    if let Some(monitor) = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::MouseMoved,
            &local_handler,
        )
    } {
        std::mem::forget(monitor);
    }
}

#[cfg(not(target_os = "macos"))]
fn setup_mouse_passthrough_monitor(_app: AppHandle) {}

#[tauri::command]
pub fn show_popout_window(app: AppHandle) -> Result<(), String> {
    show(&app)
}

#[tauri::command]
pub fn dismiss_popout_window(app: AppHandle) -> Result<(), String> {
    let previous_frontmost_pid = app
        .state::<PopoutWindowState>()
        .previous_frontmost_pid
        .lock()
        .map_err(|_| "Failed to lock Popout Window focus state".to_string())?
        .take();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .hide()
            .map_err(|error| format!("Failed to hide Popout Window: {error}"))?;
    }
    restore_previous_frontmost_application(&app, previous_frontmost_pid);
    Ok(())
}

pub fn hide_for_main_window(app: &AppHandle) -> Result<(), String> {
    app.state::<PopoutWindowState>()
        .previous_frontmost_pid
        .lock()
        .map_err(|_| "Failed to lock Popout Window focus state".to_string())?
        .take();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .hide()
            .map_err(|error| format!("Failed to hide Popout Window: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_popout_window_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    let was_expanded = app
        .state::<PopoutWindowState>()
        .expanded
        .swap(expanded, Ordering::SeqCst);
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "Popout Window is not open".to_string())?;
    let (width, height) = if expanded {
        (EXPANDED_WIDTH, EXPANDED_HEIGHT)
    } else {
        (COLLAPSED_WINDOW_WIDTH, COLLAPSED_WINDOW_HEIGHT)
    };
    let previous_position = window
        .outer_position()
        .map_err(|error| format!("Failed to read Popout Window position: {error}"))?;
    let previous_size = window
        .outer_size()
        .map_err(|error| format!("Failed to read Popout Window size: {error}"))?;
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("Failed to read Popout Window scale factor: {error}"))?;
    let (surface_center_x, surface_center_y) = visible_surface_center(
        previous_position.x as f64,
        previous_position.y as f64,
        previous_size.width as f64,
        previous_size.height as f64,
        was_expanded,
        scale_factor,
    );
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| format!("Failed to resize Popout Window: {error}"))?;
    let next_size = window
        .outer_size()
        .map_err(|error| format!("Failed to read resized Popout Window size: {error}"))?;
    let (next_x, next_y) = window_position_for_surface_center(
        surface_center_x,
        surface_center_y,
        next_size.width as f64,
        next_size.height as f64,
        expanded,
        scale_factor,
    );
    window
        .set_position(PhysicalPosition::new(
            next_x.round() as i32,
            next_y.round() as i32,
        ))
        .map_err(|error| format!("Failed to preserve Popout Window position: {error}"))?;
    update_mouse_passthrough(&app)
}

#[cfg(test)]
mod tests {
    use super::{visible_surface_center, window_position_for_surface_center};

    #[test]
    fn preserves_collapsed_surface_center_when_expanding_on_retina_displays() {
        let center = visible_surface_center(-268.0, -268.0, 1360.0, 1280.0, false, 2.0);
        assert_eq!(center, (412.0, 900.0));

        let expanded_position =
            window_position_for_surface_center(center.0, center.1, 940.0, 1280.0, true, 2.0);
        assert_eq!(expanded_position, (-58.0, 260.0));
    }

    #[test]
    fn restores_the_same_surface_center_when_collapsing() {
        let center = visible_surface_center(-58.0, 260.0, 940.0, 1280.0, true, 2.0);
        let collapsed_position =
            window_position_for_surface_center(center.0, center.1, 1360.0, 1280.0, false, 2.0);
        assert_eq!(collapsed_position, (-268.0, -268.0));
    }
}

#[tauri::command]
pub fn set_popout_window_overlay_active(app: AppHandle, active: bool) -> Result<(), String> {
    app.state::<PopoutWindowState>()
        .overlay_active
        .store(active, Ordering::SeqCst);
    update_mouse_passthrough(&app)
}
