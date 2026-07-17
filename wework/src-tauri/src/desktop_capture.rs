const SNAPSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[tauri::command]
pub async fn capture_main_webview(app: tauri::AppHandle) -> Result<String, String> {
    if std::env::var("VITE_WEWORK_E2E").as_deref() != Ok("true") {
        return Err(
            "Main webview snapshots are only available during E2E verification".to_string(),
        );
    }
    capture_main_webview_impl(app).await
}

#[cfg(target_os = "macos")]
async fn capture_main_webview_impl(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "Main webview is unavailable".to_string())?;
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let timeout_sender = sender.clone();

    webview
        .with_webview(move |platform_webview| {
            start_macos_snapshot(platform_webview, sender);
        })
        .map_err(|error| format!("Failed to access main webview: {error}"))?;

    std::thread::spawn(move || {
        std::thread::sleep(SNAPSHOT_TIMEOUT);
        let _ = timeout_sender.try_send(Err("Main webview snapshot timed out".to_string()));
    });

    receiver
        .recv()
        .await
        .ok_or_else(|| "Main webview snapshot was cancelled".to_string())?
}

#[cfg(target_os = "macos")]
fn start_macos_snapshot(
    platform_webview: tauri::webview::PlatformWebview,
    sender: tauri::async_runtime::Sender<Result<String, String>>,
) {
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let result = unsafe { encode_snapshot(image, error) };
        let _ = sender.try_send(result);
    });

    unsafe {
        let webview: &WKWebView = &*platform_webview.inner().cast();
        webview.takeSnapshotWithConfiguration_completionHandler(None, &completion);
    }
}

#[cfg(target_os = "macos")]
unsafe fn encode_snapshot(
    image: *mut objc2_app_kit::NSImage,
    error: *mut objc2_foundation::NSError,
) -> Result<String, String> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    if !error.is_null() {
        return Err((*error).localizedDescription().to_string());
    }
    let image = image
        .as_ref()
        .ok_or_else(|| "WebKit returned an empty snapshot".to_string())?;
    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "Failed to encode WebKit snapshot as TIFF".to_string())?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| "Failed to create bitmap from WebKit snapshot".to_string())?;
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
