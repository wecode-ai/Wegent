use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use tauri::{AppHandle, Emitter, Manager};

pub const CAPTURED_EVENT: &str = "wework-appshot-captured";
pub const PERMISSION_REQUIRED_EVENT: &str = "wework-appshot-permission-required";
pub const SHORTCUT: &str = "CommandOrControl+Shift+2";
const MAX_ACCESSIBILITY_TEXT_BYTES: usize = 200 * 1024;
const MAX_ACCESSIBILITY_NODES: usize = 5_000;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppshotPayload {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub file_size: u64,
    pub path: String,
    pub text_attachment: Option<AppshotTextPayload>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppshotTextPayload {
    pub filename: String,
    pub file_size: u64,
    pub path: String,
    pub text_length: usize,
    pub text_preview: String,
}

#[derive(Clone, Copy, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppshotPermission {
    ScreenCapture,
    Accessibility,
}

#[derive(Default)]
pub struct AppshotState {
    capturing: AtomicBool,
    pending: Mutex<Vec<AppshotPayload>>,
    permission_required: Mutex<Option<AppshotPermission>>,
    shortcut_registered: AtomicBool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppshotsStatus {
    supported: bool,
    shortcut: &'static str,
    shortcut_registered: bool,
    screen_capture_permission_granted: bool,
    accessibility_permission_granted: bool,
}

pub fn setup(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;

        match app.global_shortcut().register(SHORTCUT) {
            Ok(()) => {
                app.state::<AppshotState>()
                    .shortcut_registered
                    .store(true, Ordering::SeqCst);
                log::info!("Registered Appshots shortcut {SHORTCUT}");
            }
            Err(error) => {
                log::warn!("Failed to register Appshots shortcut {SHORTCUT}: {error}");
            }
        }
    }
}

pub fn handle_shortcut(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<AppshotState>();
        if state.capturing.swap(true, Ordering::SeqCst) {
            return;
        }

        if !screen_capture_permission_granted() {
            request_screen_capture_permission();
            state.capturing.store(false, Ordering::SeqCst);
            show_permission_required(app, AppshotPermission::ScreenCapture);
            return;
        }

        if !accessibility_permission_granted() {
            request_accessibility_permission();
            state.capturing.store(false, Ordering::SeqCst);
            show_permission_required(app, AppshotPermission::Accessibility);
            return;
        }

        let target = match frontmost_window() {
            Ok(target) => target,
            Err(error) => {
                state.capturing.store(false, Ordering::SeqCst);
                log::warn!("Failed to select the frontmost window for Appshots: {error}");
                return;
            }
        };
        let play_sound = super::read_app_preferences_impl(app).appshots_play_sound;
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = capture_window(&app, target, play_sound);
            app.state::<AppshotState>()
                .capturing
                .store(false, Ordering::SeqCst);

            match result {
                Ok(payload) => deliver(app, payload),
                Err(error) => log::warn!("Failed to capture Appshot: {error}"),
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

fn deliver(app: AppHandle, payload: AppshotPayload) {
    if let Ok(mut pending) = app.state::<AppshotState>().pending.lock() {
        pending.push(payload.clone());
    }

    if let Err(error) = super::ensure_main_window(&app, None) {
        log::warn!("Failed to show Wework for Appshot: {error}");
        return;
    }
    if let Err(error) = app.emit(CAPTURED_EVENT, payload) {
        log::warn!("Failed to emit Appshot event: {error}");
    }
}

#[tauri::command]
pub fn get_appshots_status(state: tauri::State<'_, AppshotState>) -> AppshotsStatus {
    AppshotsStatus {
        supported: cfg!(target_os = "macos"),
        shortcut: SHORTCUT,
        shortcut_registered: state.shortcut_registered.load(Ordering::SeqCst),
        screen_capture_permission_granted: screen_capture_permission_granted(),
        accessibility_permission_granted: accessibility_permission_granted(),
    }
}

#[tauri::command]
pub fn open_appshots_permission_settings(permission: AppshotPermission) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = match permission {
            AppshotPermission::ScreenCapture => "Privacy_ScreenCapture",
            AppshotPermission::Accessibility => "Privacy_Accessibility",
        };
        std::process::Command::new("/usr/bin/open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{pane}"
            ))
            .status()
            .map_err(|error| format!("Failed to open Screen Recording settings: {error}"))?
            .success()
            .then_some(())
            .ok_or_else(|| "macOS could not open Screen Recording settings".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    Err("Appshots is only supported on macOS".to_string())
}

fn show_permission_required(app: &AppHandle, permission: AppshotPermission) {
    if let Ok(mut pending) = app.state::<AppshotState>().permission_required.lock() {
        *pending = Some(permission);
    }
    if let Err(error) = super::ensure_main_window(app, None) {
        log::warn!("Failed to show Wework for Appshots permission: {error}");
        return;
    }
    if let Err(error) = app.emit(PERMISSION_REQUIRED_EVENT, permission) {
        log::warn!("Failed to emit Appshots permission event: {error}");
    }
}

#[cfg(target_os = "macos")]
fn screen_capture_permission_granted() -> bool {
    core_graphics::access::ScreenCaptureAccess.preflight()
}

#[cfg(not(target_os = "macos"))]
fn screen_capture_permission_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn request_screen_capture_permission() {
    let _ = core_graphics::access::ScreenCaptureAccess.request();
}

#[cfg(target_os = "macos")]
fn accessibility_permission_granted() -> bool {
    macos_accessibility::is_trusted()
}

#[cfg(not(target_os = "macos"))]
fn accessibility_permission_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn request_accessibility_permission() {
    macos_accessibility::request_access()
}

#[tauri::command]
pub fn take_pending_appshots(state: tauri::State<'_, AppshotState>) -> Vec<AppshotPayload> {
    state
        .pending
        .lock()
        .map(|pending| pending.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub fn acknowledge_appshot(state: tauri::State<'_, AppshotState>, id: String) {
    if let Ok(mut pending) = state.pending.lock() {
        pending.retain(|payload| payload.id != id);
    }
}

#[tauri::command]
pub fn take_pending_appshots_permission(
    state: tauri::State<'_, AppshotState>,
) -> Option<AppshotPermission> {
    state
        .permission_required
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct TargetWindow {
    id: u32,
    owner_pid: i32,
}

#[cfg(target_os = "macos")]
fn frontmost_window() -> Result<TargetWindow, String> {
    use core_foundation::{
        base::{CFType, TCFType, TCFTypeRef},
        dictionary::{CFDictionary, CFDictionaryRef},
        number::CFNumber,
        string::CFString,
    };
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly, kCGWindowNumber, kCGWindowOwnerPID,
    };
    use objc2_app_kit::NSWorkspace;

    let frontmost_pid = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .ok_or_else(|| "No frontmost application is available".to_string())?
        .processIdentifier();
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let windows = copy_window_info(options, kCGNullWindowID)
        .ok_or_else(|| "CoreGraphics returned no window list".to_string())?;

    for raw_window in windows.iter() {
        let dictionary = unsafe {
            CFDictionary::<CFString, CFType>::wrap_under_get_rule(CFDictionaryRef::from_void_ptr(
                *raw_window,
            ))
        };
        let owner_pid = dictionary_number(&dictionary, unsafe { kCGWindowOwnerPID });
        let layer = dictionary_number(&dictionary, unsafe { kCGWindowLayer });
        if owner_pid == Some(frontmost_pid) && layer == Some(0) {
            if let Some(window_id) = dictionary_number(&dictionary, unsafe { kCGWindowNumber }) {
                return Ok(TargetWindow {
                    id: u32::try_from(window_id)
                        .map_err(|_| "The frontmost window ID is invalid".to_string())?,
                    owner_pid: frontmost_pid,
                });
            }
        }
    }

    fn dictionary_number(
        dictionary: &CFDictionary<CFString, CFType>,
        key: core_foundation::string::CFStringRef,
    ) -> Option<i32> {
        let key = unsafe { CFString::wrap_under_get_rule(key) };
        dictionary
            .find(&key)
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_i32())
    }

    Err("The frontmost application has no capturable window".to_string())
}

#[cfg(target_os = "macos")]
fn capture_window(
    app: &AppHandle,
    target: TargetWindow,
    play_sound: bool,
) -> Result<AppshotPayload, String> {
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("System clock is before UNIX epoch: {error}"))?
        .as_millis()
        .to_string();
    let root = super::local_attachment_root(app)?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create attachment directory: {error}"))?;
    let directory = super::unique_attachment_directory(&root)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create Appshot directory: {error}"))?;
    let filename = format!("appshot-{id}.png");
    let path = directory.join(&filename);

    let mut command = std::process::Command::new("/usr/sbin/screencapture");
    command.args(["-l", &target.id.to_string(), "-o", "-t", "png"]);
    if !play_sound {
        command.arg("-x");
    }
    command.arg(&path);

    let status = command
        .status()
        .map_err(|error| format!("Failed to start macOS screencapture: {error}"))?;
    if !status.success() {
        return Err(format!("macOS screencapture exited with {status}"));
    }
    let file_size = std::fs::metadata(&path)
        .map_err(|error| format!("Failed to inspect captured Appshot: {error}"))?
        .len();
    if file_size == 0 {
        return Err("macOS screencapture produced an empty file".to_string());
    }

    let text_attachment = match macos_accessibility::extract_window_text(target.owner_pid) {
        Ok(text) if !text.is_empty() => {
            let text_filename = format!("appshot-context-{id}.txt");
            let text_path = directory.join(&text_filename);
            std::fs::write(&text_path, text.as_bytes())
                .map_err(|error| format!("Failed to write Appshot text context: {error}"))?;
            Some(AppshotTextPayload {
                filename: text_filename,
                file_size: text.len() as u64,
                path: text_path.to_string_lossy().into_owned(),
                text_length: text.chars().count(),
                text_preview: text.chars().take(500).collect(),
            })
        }
        Ok(_) => None,
        Err(error) => {
            log::warn!("Failed to extract Appshot accessibility text: {error}");
            None
        }
    };

    Ok(AppshotPayload {
        id,
        filename,
        mime_type: "image/png".to_string(),
        file_size,
        path: path.to_string_lossy().into_owned(),
        text_attachment,
    })
}

#[cfg(target_os = "macos")]
mod macos_accessibility {
    use std::collections::HashSet;
    use std::ffi::c_void;

    use core_foundation::{
        array::{CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex},
        base::{CFGetTypeID, CFType, CFTypeRef, TCFType},
        boolean::CFBoolean,
        dictionary::{CFDictionary, CFDictionaryRef},
        string::{CFString, CFStringRef},
    };

    use super::{MAX_ACCESSIBILITY_NODES, MAX_ACCESSIBILITY_TEXT_BYTES};

    type AXUIElementRef = *const c_void;
    type AXError = i32;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        fn AXUIElementCreateApplication(pid: libc::pid_t) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
    }

    pub fn is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn request_access() {
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        unsafe {
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
        }
    }

    pub fn extract_window_text(pid: i32) -> Result<String, String> {
        let application = unsafe { AXUIElementCreateApplication(pid) };
        if application.is_null() {
            return Err("AXUIElementCreateApplication returned null".to_string());
        }
        let application_owner = unsafe { CFType::wrap_under_create_rule(application.cast()) };
        let focused_window = copy_attribute(application, "AXFocusedWindow");
        let root = focused_window
            .as_ref()
            .map(|value| value.as_CFTypeRef().cast())
            .unwrap_or(application);
        let mut collector = TextCollector::default();
        collector.visit(root, 0);
        drop(focused_window);
        drop(application_owner);
        Ok(collector.finish())
    }

    #[derive(Default)]
    struct TextCollector {
        nodes: usize,
        bytes: usize,
        seen_elements: HashSet<usize>,
        seen_text: HashSet<String>,
        text: Vec<String>,
    }

    impl TextCollector {
        fn visit(&mut self, element: AXUIElementRef, depth: usize) {
            if element.is_null()
                || depth > 64
                || self.nodes >= MAX_ACCESSIBILITY_NODES
                || self.bytes >= MAX_ACCESSIBILITY_TEXT_BYTES
                || !self.seen_elements.insert(element as usize)
            {
                return;
            }
            self.nodes += 1;

            for attribute in ["AXTitle", "AXDescription", "AXHelp", "AXValue"] {
                if let Some(value) = copy_attribute(element, attribute) {
                    if let Some(string) = value.downcast::<CFString>() {
                        self.push_text(string.to_string());
                    }
                }
            }

            let Some(children) = copy_attribute(element, "AXChildren") else {
                return;
            };
            let children_ref = children.as_CFTypeRef();
            if unsafe { CFGetTypeID(children_ref) } != unsafe { CFArrayGetTypeID() } {
                return;
            }
            let count = unsafe { CFArrayGetCount(children_ref.cast()) };
            for index in 0..count {
                let child = unsafe { CFArrayGetValueAtIndex(children_ref.cast(), index) };
                self.visit(child, depth + 1);
                if self.nodes >= MAX_ACCESSIBILITY_NODES
                    || self.bytes >= MAX_ACCESSIBILITY_TEXT_BYTES
                {
                    break;
                }
            }
        }

        fn push_text(&mut self, value: String) {
            let normalized = value
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if normalized.is_empty() || !self.seen_text.insert(normalized.clone()) {
                return;
            }
            let remaining = MAX_ACCESSIBILITY_TEXT_BYTES.saturating_sub(self.bytes);
            let truncated = truncate_to_boundary(&normalized, remaining);
            if truncated.is_empty() {
                return;
            }
            self.bytes += truncated.len() + 1;
            self.text.push(truncated.to_string());
        }

        fn finish(self) -> String {
            self.text.join("\n")
        }
    }

    fn copy_attribute(element: AXUIElementRef, attribute: &str) -> Option<CFType> {
        let attribute = CFString::new(attribute);
        let mut value: CFTypeRef = std::ptr::null();
        let error = unsafe {
            AXUIElementCopyAttributeValue(element, attribute.as_concrete_TypeRef(), &mut value)
        };
        if error != 0 || value.is_null() {
            return None;
        }
        Some(unsafe { CFType::wrap_under_create_rule(value) })
    }

    fn truncate_to_boundary(value: &str, max_bytes: usize) -> &str {
        if value.len() <= max_bytes {
            return value;
        }
        let mut end = max_bytes;
        while end > 0 && !value.is_char_boundary(end) {
            end -= 1;
        }
        &value[..end]
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn collector_deduplicates_and_normalizes_accessibility_text() {
            let mut collector = TextCollector::default();
            collector.push_text("  Window title \n\n Body text  ".to_string());
            collector.push_text("Window title\nBody text".to_string());

            assert_eq!(collector.finish(), "Window title\nBody text");
        }

        #[test]
        fn truncation_preserves_utf8_boundaries() {
            assert_eq!(truncate_to_boundary("窗口文本", 7), "窗口");
        }
    }
}
