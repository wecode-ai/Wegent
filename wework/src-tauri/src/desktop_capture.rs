#[tauri::command]
pub async fn capture_main_webview(app: tauri::AppHandle) -> Result<String, String> {
    capture_main_webview_impl(app).await
}

#[cfg(target_os = "macos")]
async fn capture_main_webview_impl(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "Main webview is unavailable".to_string())?;
    let (sender, mut receiver) = tauri::async_runtime::channel(1);

    webview
        .with_webview(move |platform_webview| {
            let result = unsafe { capture_macos_webview(platform_webview) };
            let _ = sender.try_send(result);
        })
        .map_err(|error| format!("Failed to access main webview: {error}"))?;

    receiver
        .recv()
        .await
        .ok_or_else(|| "Main webview snapshot was cancelled".to_string())?
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
