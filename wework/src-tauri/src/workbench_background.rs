use std::path::{Path, PathBuf};

use tauri::Manager;

const BACKGROUND_DIRECTORY: &str = "workbench-background";
const SUPPORTED_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

fn normalized_extension(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The selected file has no supported image extension".to_string())?;

    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Only JPEG, PNG, and WebP images are supported".to_string());
    }
    Ok(extension)
}

fn validate_image_contents(path: &Path, extension: &str) -> Result<(), String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open the selected image: {error}"))?;
    let mut header = [0_u8; 12];
    let bytes_read = file
        .read(&mut header)
        .map_err(|error| format!("Failed to read the selected image: {error}"))?;
    let valid = match extension {
        "jpg" | "jpeg" => bytes_read >= 3 && header[..3] == [0xff, 0xd8, 0xff],
        "png" => bytes_read >= 8 && header[..8] == *b"\x89PNG\r\n\x1a\n",
        "webp" => bytes_read >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP",
        _ => false,
    };
    valid
        .then_some(())
        .ok_or_else(|| "The selected file is not a valid supported image".to_string())
}

fn background_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(BACKGROUND_DIRECTORY))
        .map_err(|error| format!("Failed to resolve the app data directory: {error}"))
}

fn import_background(source: &Path, directory: &Path) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err("The selected background image does not exist".to_string());
    }
    let extension = normalized_extension(source)?;
    validate_image_contents(source, &extension)?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create the background directory: {error}"))?;

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("Failed to create a background file name: {error}"))?
        .as_nanos();
    let target = directory.join(format!("background-{nonce}.{extension}"));
    let temporary = directory.join(format!("background-{nonce}.importing"));
    std::fs::copy(source, &temporary)
        .map_err(|error| format!("Failed to copy the background image: {error}"))?;
    std::fs::rename(&temporary, &target)
        .map_err(|error| format!("Failed to save the background image: {error}"))?;

    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("Failed to inspect the background directory: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("Failed to inspect a background file: {error}"))?
            .path();
        if path != target && path.is_file() {
            std::fs::remove_file(path)
                .map_err(|error| format!("Failed to remove the previous background: {error}"))?;
        }
    }
    Ok(target)
}

#[tauri::command]
pub fn import_workbench_background(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    let target = import_background(Path::new(&source_path), &background_directory(&app)?)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn remove_workbench_background(app: tauri::AppHandle) -> Result<(), String> {
    let directory = background_directory(&app)?;
    if !directory.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(directory)
        .map_err(|error| format!("Failed to remove the background image: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_supported_image_and_replaces_previous_background() {
        let root =
            std::env::temp_dir().join(format!("wework-background-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        let directory = root.join("managed");
        std::fs::write(&source, b"\x89PNG\r\n\x1a\nimage-data").unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("background.jpg"), b"old").unwrap();

        let imported = import_background(&source, &directory).unwrap();

        assert_eq!(
            imported.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert_eq!(
            std::fs::read(imported).unwrap(),
            b"\x89PNG\r\n\x1a\nimage-data"
        );
        assert!(!directory.join("background.jpg").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsupported_files_without_removing_previous_background() {
        let root = std::env::temp_dir().join(format!(
            "wework-background-reject-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.gif");
        let directory = root.join("managed");
        std::fs::write(&source, b"image-data").unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        let previous = directory.join("background.png");
        std::fs::write(&previous, b"old").unwrap();

        assert!(import_background(&source, &directory).is_err());
        assert_eq!(std::fs::read(previous).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(root);
    }
}
