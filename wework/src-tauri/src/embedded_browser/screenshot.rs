use std::{
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{Webview, Wry};

use super::{
    browser_runtime::script_expression, current_unix_millis, eval_json, get_entry,
    EmbeddedBrowserState, BRIDGE_EVAL_TIMEOUT_MS, EMBEDDED_BROWSER_SCREENSHOT_SEQUENCE,
};

#[cfg(target_os = "macos")]
pub(super) fn screenshot_embedded_browser(
    state: &EmbeddedBrowserState,
    label: &str,
) -> Result<Value, String> {
    let entry = get_entry(state, label)?;
    let webview = entry.ready_webview()?;
    let screenshot_id = format!(
        "wk-screenshot-{}",
        EMBEDDED_BROWSER_SCREENSHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let page = eval_json(
        state,
        label,
        script_expression(
            "({
              url: location.href,
              title: document.title || '',
              readyState: document.readyState,
              viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio || 1,
                scrollX: window.scrollX,
                scrollY: window.scrollY,
                visualViewport: window.visualViewport ? {
                  width: window.visualViewport.width,
                  height: window.visualViewport.height,
                  offsetLeft: window.visualViewport.offsetLeft,
                  offsetTop: window.visualViewport.offsetTop,
                  scale: window.visualViewport.scale
                } : null
              }
            })",
        ),
        BRIDGE_EVAL_TIMEOUT_MS,
    )
    .ok()
    .and_then(|value| value.get("value").cloned())
    .unwrap_or_else(|| json!({}));
    let path = screenshot_path(&screenshot_id)?;

    match capture_webview_to_png_file(&webview, &path) {
        Ok(capture) => Ok(screenshot_result(
            &screenshot_id,
            "wkwebview-nsview-cache",
            &path,
            capture.width,
            capture.height,
            capture.scale_factor,
            None,
            page,
            vec![json!({
                "code": "wk_take_snapshot_not_used",
                "message": "Screenshot uses native NSView cacheDisplay rather than WKWebView takeSnapshot."
            })],
        )),
        Err(error) => Err(format!(
            "Failed to capture embedded browser native view snapshot: {error}"
        )),
    }
}

#[cfg(target_os = "macos")]
struct EmbeddedBrowserScreenshotCapture {
    width: u32,
    height: u32,
    scale_factor: f64,
}

#[cfg(target_os = "macos")]
fn capture_webview_to_png_file(
    webview: &Webview<Wry>,
    path: &Path,
) -> Result<EmbeddedBrowserScreenshotCapture, String> {
    let scale_factor = webview
        .window()
        .scale_factor()
        .map_err(|error| format!("Failed to read Wework window scale factor: {error}"))?
        .max(1.0);
    let (sender, receiver) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe { capture_macos_webview_bytes(platform_webview) };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Failed to access embedded browser webview: {error}"))?;
    let bytes = receiver
        .recv_timeout(Duration::from_millis(BRIDGE_EVAL_TIMEOUT_MS))
        .map_err(|_| "Timed out waiting for native embedded browser snapshot".to_string())??;
    std::fs::write(path, &bytes)
        .map_err(|error| format!("Failed to write embedded browser snapshot: {error}"))?;
    let (width, height) = png_dimensions(path)?;
    Ok(EmbeddedBrowserScreenshotCapture {
        width,
        height,
        scale_factor,
    })
}

#[cfg(target_os = "macos")]
unsafe fn capture_macos_webview_bytes(
    platform_webview: tauri::webview::PlatformWebview,
) -> Result<Vec<u8>, String> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSView};
    use objc2_foundation::NSDictionary;

    let webview: &NSView = &*platform_webview.inner().cast();
    let bounds = webview.bounds();
    let bitmap = webview
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .ok_or_else(|| "Failed to create bitmap for embedded browser".to_string())?;
    webview.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
    let properties: objc2::rc::Retained<
        NSDictionary<objc2_app_kit::NSBitmapImageRepPropertyKey, AnyObject>,
    > = NSDictionary::new();
    let png = bitmap
        .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        .ok_or_else(|| "Failed to encode embedded browser snapshot as PNG".to_string())?;
    Ok(ns_data_bytes(&png))
}

#[cfg(target_os = "macos")]
fn ns_data_bytes(data: &objc2_foundation::NSData) -> Vec<u8> {
    let mut bytes = vec![0; data.length()];
    if let Some(buffer) = std::ptr::NonNull::new(bytes.as_mut_ptr().cast()) {
        unsafe { data.getBytes_length(buffer, bytes.len()) };
    }
    bytes
}

fn screenshot_result(
    screenshot_id: &str,
    backend: &str,
    path: &Path,
    width: u32,
    height: u32,
    scale_factor: f64,
    region: Option<Value>,
    page: Value,
    warnings: Vec<Value>,
) -> Value {
    json!({
        "ok": true,
        "kind": "browser.screenshot",
        "schemaVersion": 1,
        "screenshotId": screenshot_id,
        "backend": backend,
        "format": "png",
        "scope": "viewport",
        "path": path.to_string_lossy(),
        "width": width,
        "height": height,
        "scale": scale_factor,
        "region": region,
        "page": page,
        "capturedAtUnixMs": current_unix_millis(),
        "warnings": warnings,
    })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn screenshot_embedded_browser(
    _state: &EmbeddedBrowserState,
    _label: &str,
) -> Result<Value, String> {
    Err("Embedded browser screenshots are currently supported on macOS only".to_string())
}

#[cfg(target_os = "macos")]
fn screenshot_path(screenshot_id: &str) -> Result<PathBuf, String> {
    let directory = std::env::temp_dir().join("wework-embedded-browser");
    std::fs::create_dir_all(&directory).map_err(|error| {
        format!("Failed to create embedded browser screenshot directory: {error}")
    })?;
    Ok(directory.join(format!("{screenshot_id}.png")))
}

fn png_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read embedded browser screenshot: {error}"))?;
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Embedded browser screenshot is not a PNG file".to_string());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Ok((width, height))
}
