#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::{msg_send, runtime::AnyObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSDictionary, NSError};

#[tauri::command]
pub async fn capture_main_webview(app: tauri::AppHandle) -> Result<String, String> {
    capture_main_webview_impl(app).await
}

#[tauri::command]
pub async fn capture_popout_webview(app: tauri::AppHandle) -> Result<String, String> {
    capture_webview_impl(app, "popout-window", false).await
}

#[cfg(target_os = "macos")]
pub(crate) async fn capture_embedded_webview_png(
    webview: tauri::Webview<tauri::Wry>,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform_webview| {
            let completion = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                let result = unsafe { encode_embedded_webview_snapshot(image) };
                let _ = sender.try_send(result);
            });
            let webview = platform_webview.inner().cast::<AnyObject>();
            unsafe {
                let _: () = msg_send![
                    &*webview,
                    takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(),
                    completionHandler: &*completion
                ];
            }
        })
        .map_err(|error| format!("Failed to request embedded browser snapshot: {error}"))?;
    tokio::time::timeout(timeout, receiver.recv())
        .await
        .map_err(|_| "Timed out capturing embedded browser snapshot".to_string())?
        .ok_or_else(|| "Embedded browser snapshot request was cancelled".to_string())?
}

#[cfg(target_os = "macos")]
unsafe fn encode_embedded_webview_snapshot(image: *mut NSImage) -> Result<Vec<u8>, String> {
    if image.is_null() {
        return Err("WebKit returned no embedded browser snapshot".to_string());
    }
    let image = &*image;
    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "Failed to encode embedded browser snapshot as TIFF".to_string())?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| "Failed to create embedded browser bitmap snapshot".to_string())?;
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::dictionary();
    let png = bitmap
        .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        .ok_or_else(|| "Failed to encode embedded browser snapshot as PNG".to_string())?;
    Ok(png.as_bytes_unchecked().to_vec())
}

#[cfg(target_os = "macos")]
async fn capture_main_webview_impl(app: tauri::AppHandle) -> Result<String, String> {
    capture_webview_impl(app, "main", true).await
}

#[cfg(target_os = "macos")]
async fn capture_webview_impl(
    app: tauri::AppHandle,
    label: &str,
    restore_after_capture: bool,
) -> Result<String, String> {
    use tauri::Manager;

    let webview = app
        .get_webview(label)
        .ok_or_else(|| format!("Webview {label} is unavailable"))?;
    let window = webview.window().clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);

    webview
        .with_webview(move |platform_webview| {
            let result = unsafe { capture_macos_webview(platform_webview) };
            let _ = sender.try_send(result);
        })
        .map_err(|error| format!("Failed to access webview {label}: {error}"))?;

    let snapshot_result = receiver
        .recv()
        .await
        .ok_or_else(|| format!("Webview {label} snapshot was cancelled"))
        .and_then(|result| result);
    if !restore_after_capture {
        return snapshot_result;
    }
    let restore_result = restore_webview(&window, label);

    match (snapshot_result, restore_result) {
        (Ok(snapshot), Ok(())) => Ok(snapshot),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(capture_error), Err(restore_error)) => Err(format!(
            "{capture_error}; failed to restore main webview: {restore_error}"
        )),
    }
}

#[cfg(target_os = "macos")]
fn restore_webview(window: &tauri::Window, label: &str) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(error) = window.show() {
        errors.push(format!("Failed to show webview {label}: {error}"));
    }
    if let Err(error) = window.unminimize() {
        errors.push(format!("Failed to unminimize webview {label}: {error}"));
    }
    if let Err(error) = window.set_focus() {
        errors.push(format!("Failed to focus webview {label}: {error}"));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(target_os = "macos")]
unsafe fn capture_macos_webview(
    platform_webview: tauri::webview::PlatformWebview,
) -> Result<String, String> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSView};
    use objc2_foundation::NSDictionary;

    let webview: &NSView = &*platform_webview.inner().cast();
    let bounds = webview.bounds();
    let bitmap = webview
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .ok_or_else(|| "Failed to create bitmap for main webview".to_string())?;
    webview.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
    let properties: objc2::rc::Retained<
        NSDictionary<objc2_app_kit::NSBitmapImageRepPropertyKey, AnyObject>,
    > = NSDictionary::new();
    let png = bitmap
        .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        .ok_or_else(|| "Failed to encode WebKit snapshot as PNG".to_string())?;
    let bytes = ns_data_bytes(&png);
    Ok(format!(
        "data:image/png;base64,{}",
        crate::encode_base64(&bytes)
    ))
}

#[cfg(target_os = "macos")]
fn ns_data_bytes(data: &objc2_foundation::NSData) -> Vec<u8> {
    let mut bytes = vec![0; data.length()];
    if let Some(buffer) = std::ptr::NonNull::new(bytes.as_mut_ptr().cast()) {
        unsafe { data.getBytes_length(buffer, bytes.len()) };
    }
    bytes
}

#[cfg(not(target_os = "macos"))]
async fn capture_main_webview_impl(_app: tauri::AppHandle) -> Result<String, String> {
    Err("Main webview snapshots are currently supported on macOS only".to_string())
}

#[cfg(not(target_os = "macos"))]
async fn capture_webview_impl(
    _app: tauri::AppHandle,
    _label: &str,
    _restore_after_capture: bool,
) -> Result<String, String> {
    Err("Webview snapshots are currently supported on macOS only".to_string())
}
