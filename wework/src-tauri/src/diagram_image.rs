use base64::{engine::general_purpose::STANDARD, Engine as _};

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn decode_png(data_base64: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Failed to decode diagram PNG: {error}"))?;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Diagram image is not a valid PNG".to_string());
    }
    Ok(bytes)
}

fn write_png_file(path: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes)
        .map_err(|error| format!("Failed to save diagram PNG to {path}: {error}"))
}

#[cfg(target_os = "macos")]
fn write_png_to_native_clipboard(bytes: &[u8]) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
    use objc2_foundation::NSData;

    let data = unsafe { NSData::dataWithBytes_length(bytes.as_ptr().cast(), bytes.len()) };
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if pasteboard.setData_forType(Some(&data), unsafe { NSPasteboardTypePNG }) {
        Ok(())
    } else {
        Err("Failed to write PNG to the macOS pasteboard".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn write_png_to_native_clipboard(_bytes: &[u8]) -> Result<(), String> {
    Err("Native image clipboard is only available in the macOS app".to_string())
}

#[tauri::command]
pub async fn copy_diagram_png(app: tauri::AppHandle, data_base64: String) -> Result<(), String> {
    let bytes = decode_png(&data_base64)?;

    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(write_png_to_native_clipboard(&bytes));
        })
        .map_err(|error| format!("Failed to access the macOS pasteboard: {error}"))?;
        tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv()
                .map_err(|_| "PNG clipboard copy stopped unexpectedly".to_string())?
        })
        .await
        .map_err(|error| format!("Failed to join PNG clipboard copy: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        write_png_to_native_clipboard(&bytes)
    }
}

#[tauri::command]
pub async fn save_diagram_png(path: String, data_base64: String) -> Result<(), String> {
    let bytes = decode_png(&data_base64)?;
    tauri::async_runtime::spawn_blocking(move || write_png_file(&path, &bytes))
    .await
    .map_err(|error| format!("Failed to join diagram PNG save: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_png_signature() {
        let encoded = STANDARD.encode([PNG_SIGNATURE, b"content"].concat());
        assert!(decode_png(&encoded).is_ok());
    }

    #[test]
    fn rejects_non_png_content() {
        let encoded = STANDARD.encode(b"not a png");
        assert_eq!(
            decode_png(&encoded).unwrap_err(),
            "Diagram image is not a valid PNG"
        );
    }

    #[test]
    fn writes_png_file() {
        let path =
            std::env::temp_dir().join(format!("wework-diagram-image-{}.png", std::process::id()));
        let bytes = [PNG_SIGNATURE, b"content"].concat();

        write_png_file(path.to_str().expect("temporary path should be UTF-8"), &bytes)
            .expect("PNG should be written");

        assert_eq!(std::fs::read(&path).expect("PNG should be readable"), bytes);
        std::fs::remove_file(path).expect("temporary PNG should be removed");
    }
}
