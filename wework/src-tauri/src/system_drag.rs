use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const PANEL_LABEL: &str = "system-drag-panel";
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
        .inner_size(440.0, 72.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()
        .map_err(|error| format!("Failed to create system drag panel: {error}"))
}

fn show_panel(app: &AppHandle, cursor: tauri::PhysicalPosition<f64>) {
    let Ok(window) = ensure_panel(app) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        position_panel_at_screen_top(&window, cursor);
        let _ = window.show();
    }
}

fn position_panel_at_screen_top(
    window: &tauri::WebviewWindow,
    cursor: tauri::PhysicalPosition<f64>,
) {
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Some(monitor) = monitors.into_iter().find(|monitor| {
        let area = monitor.work_area();
        cursor.x >= area.position.x as f64
            && cursor.x < (area.position.x + area.size.width as i32) as f64
            && cursor.y >= area.position.y as f64
            && cursor.y < (area.position.y + area.size.height as i32) as f64
    }) else {
        return;
    };
    let Ok(panel_size) = window.outer_size() else {
        return;
    };
    let work_area = monitor.work_area();
    let x =
        work_area.position.x + ((work_area.size.width as i32 - panel_size.width as i32) / 2).max(0);
    let y = work_area.position.y + (8.0 * monitor.scale_factor()).round() as i32;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
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
fn handle_drag_event(
    app: &AppHandle,
    last_change_count: &std::sync::atomic::AtomicIsize,
    event_type: objc2_app_kit::NSEventType,
) {
    use objc2_app_kit::{NSEventType, NSPasteboard, NSPasteboardNameDrag};
    use std::sync::atomic::Ordering;

    if event_type == NSEventType::LeftMouseUp {
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
            if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
                let _ = panel.hide();
            }
            return;
        }
        if let Ok(cursor) = app.cursor_position() {
            show_panel(app, cursor);
        }
    }
}

#[cfg(target_os = "macos")]
pub fn setup(app: AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSPasteboard, NSPasteboardNameDrag};
    use std::sync::{atomic::AtomicIsize, Arc};

    if let Err(error) = ensure_panel(&app) {
        log::warn!("Failed to prepare system drag panel: {error}");
    }
    let drag_pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
    let last_change_count = Arc::new(AtomicIsize::new(drag_pasteboard.changeCount()));

    let global_app = app.clone();
    let global_change_count = last_change_count.clone();
    let global_handler = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
        handle_drag_event(
            &global_app,
            &global_change_count,
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
    let local_handler = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
        handle_drag_event(
            &app,
            &local_change_count,
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
