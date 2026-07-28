use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const PANEL_LABEL: &str = "system-drag-panel";
const PANEL_WIDTH: f64 = 440.0;
const PANEL_HEIGHT: f64 = 60.0;
const PANEL_TOP_MARGIN: f64 = 8.0;
const DROP_EVENT: &str = "wework-system-drag-drop";
const NATIVE_TEXT_DROP_EVENT: &str = "wework-system-drag-native-text-drop";

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDragDropPayload {
    action: String,
    text: Option<String>,
    paths: Vec<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeTextDropPayload {
    text: String,
    x: f64,
}

#[derive(Default)]
pub struct SystemDragState {
    pending: Mutex<Vec<SystemDragDropPayload>>,
}

fn ensure_panel(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("/system-drag".into()))
        .title("Wework")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|error| format!("Failed to create system drag panel: {error}"))
}

fn show_panel(app: &AppHandle) {
    let Ok(window) = ensure_panel(app) else {
        return;
    };
    if let Err(error) = position_panel_at_mouse_screen(&window) {
        log::warn!("Failed to position system drag panel: {error}");
        return;
    }
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
}

fn panel_top_left_for_visible_frame(
    frame_x: f64,
    frame_y: f64,
    frame_width: f64,
    frame_height: f64,
    panel_width: f64,
) -> (f64, f64) {
    let x = frame_x + ((frame_width - panel_width) / 2.0).max(0.0);
    let y = frame_y + frame_height - PANEL_TOP_MARGIN;
    (x, y)
}

#[cfg(target_os = "macos")]
fn position_panel_at_mouse_screen(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSScreen, NSWindow};
    use objc2_foundation::NSPoint;

    let main_thread = MainThreadMarker::new()
        .ok_or_else(|| "AppKit callback is not on the main thread".to_string())?;
    let cursor = NSEvent::mouseLocation();
    let screens = NSScreen::screens(main_thread);
    let screen = screens
        .iter()
        .find(|screen| {
            let frame = screen.frame();
            cursor.x >= frame.origin.x
                && cursor.x < frame.origin.x + frame.size.width
                && cursor.y >= frame.origin.y
                && cursor.y < frame.origin.y + frame.size.height
        })
        .ok_or_else(|| {
            format!(
                "No NSScreen contains cursor position ({:.1}, {:.1})",
                cursor.x, cursor.y
            )
        })?;
    let ns_window: &NSWindow = unsafe {
        &*window
            .ns_window()
            .map_err(|error| format!("Failed to access native panel window: {error}"))?
            .cast()
    };
    let visible_frame = screen.visibleFrame();
    let panel_frame = ns_window.frame();
    let (x, y) = panel_top_left_for_visible_frame(
        visible_frame.origin.x,
        visible_frame.origin.y,
        visible_frame.size.width,
        visible_frame.size.height,
        panel_frame.size.width,
    );
    ns_window.setFrameTopLeftPoint(NSPoint::new(x, y));
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn position_panel_at_mouse_screen(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

fn cursor_is_inside(window: &tauri::WebviewWindow) -> bool {
    let (Ok(cursor), Ok(position), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    cursor.x >= position.x as f64
        && cursor.x <= (position.x + size.width as i32) as f64
        && cursor.y >= position.y as f64
        && cursor.y <= (position.y + size.height as i32) as f64
}

#[cfg(target_os = "macos")]
fn take_drag_in_progress(drag_in_progress: &std::sync::atomic::AtomicBool) -> bool {
    drag_in_progress.swap(false, std::sync::atomic::Ordering::SeqCst)
}

#[cfg(target_os = "macos")]
fn handle_drag_event(
    app: &AppHandle,
    last_change_count: &std::sync::atomic::AtomicIsize,
    drag_in_progress: &std::sync::atomic::AtomicBool,
    event_type: objc2_app_kit::NSEventType,
) {
    use objc2_app_kit::{NSEventType, NSPasteboard, NSPasteboardNameDrag};
    use std::sync::atomic::Ordering;

    if event_type == NSEventType::LeftMouseUp {
        // The drag pasteboard keeps its previous content after a drag finishes. A plain click
        // must not consume that stale content as a new drop.
        if !take_drag_in_progress(drag_in_progress) {
            return;
        }
        if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
            if cursor_is_inside(&panel) {
                use objc2_app_kit::{NSPasteboardTypeFileURL, NSPasteboardTypeString};
                use objc2_foundation::NSString;

                let pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
                let has_file = pasteboard
                    .stringForType(unsafe { NSPasteboardTypeFileURL })
                    .is_some();
                if !has_file {
                    if let Some(text) = pasteboard.stringForType(unsafe { NSPasteboardTypeString })
                    {
                        if let (Ok(cursor), Ok(position), Ok(scale_factor)) = (
                            panel.cursor_position(),
                            panel.outer_position(),
                            panel.scale_factor(),
                        ) {
                            let mut text = text.to_string();
                            let url_name_type = NSString::from_str("public.url-name");
                            if let Some(title) = pasteboard.stringForType(&url_name_type) {
                                let title = title.to_string();
                                if !title.trim().is_empty() && title.trim() != text.trim() {
                                    text = format!("{}\n{}", title.trim(), text.trim());
                                }
                            }
                            if !text.trim().is_empty() {
                                let _ = panel.emit(
                                    NATIVE_TEXT_DROP_EVENT,
                                    NativeTextDropPayload {
                                        text,
                                        x: (cursor.x - position.x as f64) / scale_factor,
                                    },
                                );
                                return;
                            }
                        }
                    }
                }
            } else {
                let _ = panel.hide();
            }
        }
        return;
    }
    let pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
    let change_count = pasteboard.changeCount();
    let previous = last_change_count.swap(change_count, Ordering::SeqCst);
    if change_count != previous && pasteboard.types().is_some_and(|types| !types.is_empty()) {
        if !crate::read_app_preferences_impl(app).system_drag_enabled {
            drag_in_progress.store(false, Ordering::SeqCst);
            if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
                let _ = panel.hide();
            }
            return;
        }
        drag_in_progress.store(true, Ordering::SeqCst);
    }
    if drag_in_progress.load(Ordering::SeqCst) {
        show_panel(app);
    }
}

#[cfg(target_os = "macos")]
pub fn setup(app: AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSPasteboard, NSPasteboardNameDrag};
    use std::sync::{
        atomic::{AtomicBool, AtomicIsize},
        Arc,
    };

    if let Err(error) = ensure_panel(&app) {
        log::warn!("Failed to prepare system drag panel: {error}");
    }
    let drag_pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
    let last_change_count = Arc::new(AtomicIsize::new(drag_pasteboard.changeCount()));
    let drag_in_progress = Arc::new(AtomicBool::new(false));

    let global_app = app.clone();
    let global_change_count = last_change_count.clone();
    let global_drag_in_progress = drag_in_progress.clone();
    let global_handler = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
        handle_drag_event(
            &global_app,
            &global_change_count,
            &global_drag_in_progress,
            unsafe { event.as_ref() }.r#type(),
        );
    });
    // AppKit owns the monitor until process exit; leaking the returned token keeps it active.
    if let Some(monitor) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
        &global_handler,
    ) {
        std::mem::forget(monitor);
    }

    let local_change_count = last_change_count.clone();
    let local_drag_in_progress = drag_in_progress.clone();
    let local_handler = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
        handle_drag_event(
            &app,
            &local_change_count,
            &local_drag_in_progress,
            unsafe { event.as_ref() }.r#type(),
        );
        event.as_ptr()
    });
    if let Some(monitor) = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
            &local_handler,
        )
    } {
        std::mem::forget(monitor);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn setup(_app: AppHandle) {}

#[tauri::command]
pub fn complete_system_drag_drop(
    app: AppHandle,
    state: tauri::State<'_, SystemDragState>,
    payload: SystemDragDropPayload,
) -> Result<(), String> {
    log::info!(
        "system_drag stage=command_received action={} path_count={} has_text={}",
        payload.action,
        payload.paths.len(),
        payload.text.as_deref().is_some_and(|text| !text.is_empty())
    );
    if !matches!(payload.action.as_str(), "new-chat" | "follow-up" | "stash") {
        return Err("Unknown system drag action".to_string());
    }
    if payload
        .text
        .as_deref()
        .is_none_or(|text| text.trim().is_empty())
        && payload.paths.is_empty()
    {
        return Err("The dropped content is empty".to_string());
    }
    deliver_drop(&app, &state, payload)
}

#[tauri::command]
pub fn log_system_drag_debug(
    stage: String,
    action: Option<String>,
    raw_path_count: Option<usize>,
    unique_path_count: Option<usize>,
    duplicate: Option<bool>,
    x: Option<f64>,
    y: Option<f64>,
) {
    log::info!(
        "system_drag stage={} action={} raw_path_count={} unique_path_count={} duplicate={} x={} y={}",
        stage,
        action.as_deref().unwrap_or("none"),
        raw_path_count.unwrap_or(0),
        unique_path_count.unwrap_or(0),
        duplicate.unwrap_or(false),
        x.unwrap_or(-1.0),
        y.unwrap_or(-1.0)
    );
}

fn deliver_drop(
    app: &AppHandle,
    state: &SystemDragState,
    payload: SystemDragDropPayload,
) -> Result<(), String> {
    let main_exists = app.get_webview_window(crate::MAIN_WINDOW_LABEL).is_some();
    if !main_exists {
        state
            .pending
            .lock()
            .map_err(|_| "Failed to lock pending system drops".to_string())?
            .push(payload.clone());
        crate::ensure_main_window(app, None)?;
    } else {
        crate::ensure_main_window(app, None)?;
        app.emit(DROP_EVENT, payload)
            .map_err(|error| format!("Failed to deliver system drop: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn take_pending_system_drag_drops(
    state: tauri::State<'_, SystemDragState>,
) -> Result<Vec<SystemDragDropPayload>, String> {
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "Failed to lock pending system drops".to_string())?;
    Ok(std::mem::take(&mut *pending))
}

#[tauri::command]
pub fn dismiss_system_drag_panel(app: AppHandle) {
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let _ = panel.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::{panel_top_left_for_visible_frame, PANEL_HEIGHT, PANEL_WIDTH};

    #[test]
    fn panel_uses_compact_logical_size() {
        assert_eq!((PANEL_WIDTH, PANEL_HEIGHT), (440.0, 60.0));
    }

    #[test]
    fn panel_position_centers_in_a_primary_visible_frame() {
        let position = panel_top_left_for_visible_frame(0.0, 84.0, 1920.0, 966.0, 440.0);

        assert_eq!(position, (740.0, 1042.0));
    }

    #[test]
    fn panel_position_respects_a_portrait_monitor_origin() {
        let position = panel_top_left_for_visible_frame(-1200.0, -719.0, 1200.0, 1920.0, 440.0);

        assert_eq!(position, (-820.0, 1193.0));
    }

    #[cfg(target_os = "macos")]
    mod macos {
        use super::super::take_drag_in_progress;
        use std::sync::atomic::AtomicBool;

        #[test]
        fn plain_mouse_up_does_not_consume_a_drop() {
            let drag_in_progress = AtomicBool::new(false);

            assert!(!take_drag_in_progress(&drag_in_progress));
        }

        #[test]
        fn mouse_up_consumes_only_the_current_drag() {
            let drag_in_progress = AtomicBool::new(true);

            assert!(take_drag_in_progress(&drag_in_progress));
            assert!(!take_drag_in_progress(&drag_in_progress));
        }
    }
}
