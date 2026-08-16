use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_INLINE_VISUALIZATION_BYTES: usize = 5_000_000;

#[tauri::command]
pub async fn read_inline_visualization_html(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_inline_visualization_html_impl(&path))
        .await
        .map_err(|error| format!("Failed to join visualization read task: {error}"))?
}

fn read_inline_visualization_html_impl(path: &str) -> Result<String, String> {
    let path = validate_visualization_path(path)?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("Failed to inspect visualization file: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Visualization file may not be a symbolic link".to_string());
    }
    if !metadata.is_file() {
        return Err("Visualization path is not a regular file".to_string());
    }
    if metadata.len() > MAX_INLINE_VISUALIZATION_BYTES as u64 {
        return Err("Visualization file exceeds the 5 MB limit".to_string());
    }

    let file = std::fs::File::open(&path)
        .map_err(|error| format!("Failed to open visualization file: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_INLINE_VISUALIZATION_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read visualization file: {error}"))?;
    if bytes.len() > MAX_INLINE_VISUALIZATION_BYTES {
        return Err("Visualization file exceeds the 5 MB limit".to_string());
    }

    String::from_utf8(bytes).map_err(|_| "Visualization file is not valid UTF-8".to_string())
}

fn validate_visualization_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Visualization path is empty".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Visualization path must be absolute".to_string());
    }
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err("Visualization path may not contain parent traversal".to_string());
    }
    if !is_html_path(&path) {
        return Err("Visualization file must be HTML".to_string());
    }
    Ok(path)
}

fn is_html_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html")
                || extension.eq_ignore_ascii_case("htm")
                || extension.eq_ignore_ascii_case("xhtml")
        })
}

#[cfg(test)]
mod tests {
    use super::{read_inline_visualization_html_impl, MAX_INLINE_VISUALIZATION_BYTES};
    use std::io::Write;

    #[test]
    fn reads_absolute_utf8_html_file() {
        let directory = tempfile::tempdir().expect("temp directory should be created");
        let path = directory.path().join("visualization.html");
        std::fs::write(&path, "<main>可视化</main>").expect("visualization should be written");

        assert_eq!(
            read_inline_visualization_html_impl(path.to_str().expect("path should be UTF-8"))
                .expect("visualization should be read"),
            "<main>可视化</main>"
        );
    }

    #[test]
    fn rejects_relative_non_html_and_oversized_files() {
        assert_eq!(
            read_inline_visualization_html_impl("visualization.html").unwrap_err(),
            "Visualization path must be absolute"
        );

        let directory = tempfile::tempdir().expect("temp directory should be created");
        let text_path = directory.path().join("visualization.txt");
        std::fs::write(&text_path, "not html").expect("text file should be written");
        assert_eq!(
            read_inline_visualization_html_impl(text_path.to_str().expect("path should be UTF-8"))
                .unwrap_err(),
            "Visualization file must be HTML"
        );

        let large_path = directory.path().join("large.html");
        let mut file = std::fs::File::create(&large_path).expect("large file should be created");
        file.write_all(&vec![b'x'; MAX_INLINE_VISUALIZATION_BYTES + 1])
            .expect("large file should be written");
        assert_eq!(
            read_inline_visualization_html_impl(large_path.to_str().expect("path should be UTF-8"))
                .unwrap_err(),
            "Visualization file exceeds the 5 MB limit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temp directory should be created");
        let target = directory.path().join("target.html");
        let link = directory.path().join("link.html");
        std::fs::write(&target, "<main>target</main>").expect("target should be written");
        symlink(&target, &link).expect("symbolic link should be created");

        assert_eq!(
            read_inline_visualization_html_impl(link.to_str().expect("path should be UTF-8"))
                .unwrap_err(),
            "Visualization file may not be a symbolic link"
        );
    }
}
