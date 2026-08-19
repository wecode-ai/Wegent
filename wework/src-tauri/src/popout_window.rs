use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    utils::config::BackgroundThrottlingPolicy, AppHandle, Manager, PhysicalPosition, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub(crate) const WINDOW_LABEL: &str = "popout-window";
const COLLAPSED_SURFACE_WIDTH: f64 = 470.0;
const COLLAPSED_SURFACE_HEIGHT: f64 = 112.0;
const OVERLAY_WINDOW_WIDTH: f64 = 680.0;
const OVERLAY_WINDOW_HEIGHT: f64 = 640.0;
const EXPANDED_WIDTH: f64 = 470.0;
const EXPANDED_HEIGHT: f64 = 640.0;

pub struct PopoutWindowState {
    registered_shortcut: Mutex<Option<Shortcut>>,
    previous_frontmost_pid: Mutex<Option<i32>>,
    expanded: AtomicBool,
    overlay_active: AtomicBool,
    visible: AtomicBool,
    focus_restore_generation: AtomicU64,
}

impl Default for PopoutWindowState {
    fn default() -> Self {
        Self {
            registered_shortcut: Mutex::new(None),
            previous_frontmost_pid: Mutex::new(None),
            expanded: AtomicBool::new(false),
            overlay_active: AtomicBool::new(false),
            visible: AtomicBool::new(false),
            focus_restore_generation: AtomicU64::new(0),
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
    app.state::<PopoutWindowState>()
        .focus_restore_generation
        .fetch_add(1, Ordering::SeqCst);
    remember_frontmost_application(app);
    let window = ensure_window(app)?;
    window
        .show()
        .map_err(|error| format!("Failed to show Popout Window: {error}"))?;
    app.state::<PopoutWindowState>()
        .visible
        .store(true, Ordering::SeqCst);
    activate_popout_window(&window)?;
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus Popout Window: {error}"))
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

#[cfg(target_os = "linux")]
fn activate_popout_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let visible_window = window.clone();
    window
        .run_on_main_thread(move || {
            use gtk::prelude::*;

            let Ok(gtk_window) = visible_window.gtk_window() else {
                log::warn!("Failed to access native GTK Popout Window");
                return;
            };
            // Tao discards set_focus while its cached visibility is false. Showing and presenting
            // the native GTK window in one main-thread turn makes the first reveal focus reliably.
            gtk_window.show_all();
            gtk_window.set_focus_on_map(true);
            gtk_window.present_with_time(gtk::gdk::ffi::GDK_CURRENT_TIME as u32);
        })
        .map_err(|error| format!("Failed to schedule Popout Window activation: {error}"))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "linux")))]
fn activate_popout_window(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

fn ensure_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("/popout".into()))
        .title("Wework")
        .inner_size(COLLAPSED_SURFACE_WIDTH, COLLAPSED_SURFACE_HEIGHT)
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

fn restore_previous_frontmost_application(
    app: &AppHandle,
    process_id: Option<i32>,
    focus_restore_generation: u64,
) {
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
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let callback_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                let state = callback_app.state::<PopoutWindowState>();
                if !should_restore_previous_application(
                    state.visible.load(Ordering::SeqCst),
                    state.focus_restore_generation.load(Ordering::SeqCst),
                    focus_restore_generation,
                ) {
                    return;
                }
                if !activate_application(process_id) {
                    log::debug!(
                        "The application that preceded Popout Window is no longer available"
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

fn should_restore_previous_application(
    popout_visible: bool,
    current_generation: u64,
    restore_generation: u64,
) -> bool {
    !popout_visible && current_generation == restore_generation
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

#[tauri::command]
pub fn show_popout_window(app: AppHandle) -> Result<(), String> {
    show(&app)
}

#[tauri::command]
pub fn dismiss_popout_window(app: AppHandle) -> Result<(), String> {
    let state = app.state::<PopoutWindowState>();
    let previous_frontmost_pid = state
        .previous_frontmost_pid
        .lock()
        .map_err(|_| "Failed to lock Popout Window focus state".to_string())?
        .take();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .hide()
            .map_err(|error| format!("Failed to hide Popout Window: {error}"))?;
    }
    state.visible.store(false, Ordering::SeqCst);
    let focus_restore_generation = state
        .focus_restore_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    restore_previous_frontmost_application(&app, previous_frontmost_pid, focus_restore_generation);
    Ok(())
}

pub fn hide_for_main_window(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<PopoutWindowState>();
    state
        .previous_frontmost_pid
        .lock()
        .map_err(|_| "Failed to lock Popout Window focus state".to_string())?
        .take();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .hide()
            .map_err(|error| format!("Failed to hide Popout Window: {error}"))?;
    }
    state.visible.store(false, Ordering::SeqCst);
    state
        .focus_restore_generation
        .fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_popout_window_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    let state = app.state::<PopoutWindowState>();
    let was_expanded = state.expanded.load(Ordering::SeqCst);
    let overlay_active = state.overlay_active.load(Ordering::SeqCst);
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "Popout Window is not open".to_string())?;
    resize_window_for_state(&window, was_expanded, expanded, overlay_active)?;
    state.expanded.store(expanded, Ordering::SeqCst);
    Ok(())
}

fn resize_window_for_state(
    window: &tauri::WebviewWindow,
    was_expanded: bool,
    expanded: bool,
    overlay_active: bool,
) -> Result<(), String> {
    let (width, height) = window_size_for_state(expanded, overlay_active);
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
        .map_err(|error| format!("Failed to preserve Popout Window position: {error}"))
}

fn window_size_for_state(expanded: bool, overlay_active: bool) -> (f64, f64) {
    if expanded {
        (EXPANDED_WIDTH, EXPANDED_HEIGHT)
    } else if overlay_active {
        (OVERLAY_WINDOW_WIDTH, OVERLAY_WINDOW_HEIGHT)
    } else {
        (COLLAPSED_SURFACE_WIDTH, COLLAPSED_SURFACE_HEIGHT)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        should_restore_previous_application, visible_surface_center,
        window_position_for_surface_center, window_size_for_state,
    };

    #[test]
    fn cancels_a_delayed_focus_restore_after_the_popout_reopens() {
        assert!(!should_restore_previous_application(true, 3, 2));
        assert!(!should_restore_previous_application(false, 3, 2));
        assert!(should_restore_previous_application(false, 2, 2));
    }

    #[test]
    fn preserves_collapsed_surface_center_when_opening_an_overlay() {
        let center = visible_surface_center(-58.0, 788.0, 940.0, 224.0, false, 2.0);
        assert_eq!(center, (412.0, 900.0));

        let overlay_position =
            window_position_for_surface_center(center.0, center.1, 1360.0, 1280.0, false, 2.0);
        assert_eq!(overlay_position, (-268.0, -268.0));
    }

    #[test]
    fn restores_the_same_surface_center_when_closing_an_overlay() {
        let center = visible_surface_center(-268.0, -268.0, 1360.0, 1280.0, false, 2.0);
        let collapsed_position =
            window_position_for_surface_center(center.0, center.1, 940.0, 224.0, false, 2.0);
        assert_eq!(collapsed_position, (-58.0, 788.0));
    }

    #[test]
    fn only_allocates_the_overlay_canvas_while_a_collapsed_menu_is_open() {
        assert_eq!(window_size_for_state(false, false), (470.0, 112.0));
        assert_eq!(window_size_for_state(false, true), (680.0, 640.0));
        assert_eq!(window_size_for_state(true, false), (470.0, 640.0));
        assert_eq!(window_size_for_state(true, true), (470.0, 640.0));
    }
}

#[tauri::command]
pub fn set_popout_window_overlay_active(app: AppHandle, active: bool) -> Result<(), String> {
    let state = app.state::<PopoutWindowState>();
    let expanded = state.expanded.load(Ordering::SeqCst);
    let was_active = state.overlay_active.load(Ordering::SeqCst);
    if was_active == active {
        return Ok(());
    }
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "Popout Window is not open".to_string())?;
    resize_window_for_state(&window, expanded, expanded, active)?;
    state.overlay_active.store(active, Ordering::SeqCst);
    Ok(())
}
