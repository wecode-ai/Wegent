use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    thread,
    time::Duration,
    time::SystemTime,
};

const MAX_TEXT_FILE_BYTES: usize = 256 * 1024;
const MAX_BINARY_CHUNK_BYTES: usize = 1024 * 1024;
const E2E_READ_DELAY_MS_ENV: &str = "WEWORK_E2E_LOCAL_FILE_READ_DELAY_MS";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkspaceTextFile {
    path: String,
    name: String,
    content: String,
    editable: bool,
    revision: String,
    truncated: bool,
    size: u64,
    modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkspaceFileEntry {
    name: String,
    path: String,
    is_directory: bool,
    size: u64,
    modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkspaceTree {
    path: String,
    entries: Vec<LocalWorkspaceFileEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkspaceFileChunk {
    path: String,
    name: String,
    content_base64: String,
    offset: u64,
    eof: bool,
    size: u64,
    modified_at: Option<String>,
}

fn resolve_workspace_file(workspace_root: &str, file_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Invalid workspace path: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace path is not a directory".to_owned());
    }

    let target = fs::canonicalize(file_path)
        .map_err(|error| format!("Failed to resolve workspace file: {error}"))?;
    if !target.starts_with(&root) {
        return Err("File path is outside workspace".to_owned());
    }
    if !fs::metadata(&target)
        .map_err(|error| format!("Failed to read file metadata: {error}"))?
        .is_file()
    {
        return Err("File does not exist".to_owned());
    }
    Ok(target)
}

fn resolve_workspace_directory(
    workspace_root: &str,
    directory_path: &str,
) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Invalid workspace path: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace path is not a directory".to_owned());
    }

    let target = fs::canonicalize(directory_path)
        .map_err(|error| format!("Failed to resolve workspace directory: {error}"))?;
    if !target.starts_with(&root) {
        return Err("Directory path is outside workspace".to_owned());
    }
    if !target.is_dir() {
        return Err("Directory does not exist".to_owned());
    }
    Ok(target)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_owned()
}

fn modified_at(time: Option<SystemTime>) -> Option<String> {
    time.map(|time| DateTime::<Utc>::from(time).to_rfc3339())
}

fn apply_e2e_read_delay() {
    if std::env::var("VITE_WEWORK_E2E").as_deref() != Ok("true") {
        return;
    }
    let Ok(delay_ms) = std::env::var(E2E_READ_DELAY_MS_ENV) else {
        return;
    };
    let Ok(delay_ms) = delay_ms.parse::<u64>() else {
        return;
    };
    if delay_ms > 0 {
        thread::sleep(Duration::from_millis(delay_ms));
    }
}

fn list_entries_blocking(
    workspace_root: &str,
    directory_path: &str,
) -> Result<LocalWorkspaceTree, String> {
    let target = resolve_workspace_directory(workspace_root, directory_path)?;
    let requested_directory = Path::new(directory_path);
    let mut entries = Vec::new();

    for child in
        fs::read_dir(&target).map_err(|error| format!("Failed to list workspace: {error}"))?
    {
        let child = match child {
            Ok(child) => child,
            Err(_) => continue,
        };
        let metadata = match fs::symlink_metadata(child.path()) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let is_directory = metadata.file_type().is_dir();
        let name = child.file_name().to_string_lossy().into_owned();
        entries.push(LocalWorkspaceFileEntry {
            path: requested_directory
                .join(&name)
                .to_string_lossy()
                .into_owned(),
            name,
            is_directory,
            size: if is_directory { 0 } else { metadata.len() },
            modified_at: modified_at(metadata.modified().ok()),
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(LocalWorkspaceTree {
        path: directory_path.to_owned(),
        entries,
    })
}

#[tauri::command]
pub async fn list_local_workspace_entries(
    workspace_root: String,
    directory_path: String,
) -> Result<LocalWorkspaceTree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_entries_blocking(&workspace_root, &directory_path)
    })
    .await
    .map_err(|error| format!("Workspace file operation failed: {error}"))?
}

fn read_text_file_blocking(
    workspace_root: &str,
    file_path: &str,
) -> Result<LocalWorkspaceTextFile, String> {
    apply_e2e_read_delay();
    let target = resolve_workspace_file(workspace_root, file_path)?;
    let metadata =
        fs::metadata(&target).map_err(|error| format!("Failed to read file metadata: {error}"))?;
    let file = fs::File::open(&target).map_err(|error| format!("Failed to open file: {error}"))?;
    let mut bytes = Vec::with_capacity(MAX_TEXT_FILE_BYTES + 1);
    file.take((MAX_TEXT_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read file: {error}"))?;
    let truncated = bytes.len() > MAX_TEXT_FILE_BYTES;
    bytes.truncate(MAX_TEXT_FILE_BYTES);
    let editable = !truncated && std::str::from_utf8(&bytes).is_ok();

    Ok(LocalWorkspaceTextFile {
        path: target.to_string_lossy().into_owned(),
        name: file_name(&target),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        editable,
        revision: format!("sha256:{:x}", Sha256::digest(&bytes)),
        truncated,
        size: metadata.len(),
        modified_at: modified_at(metadata.modified().ok()),
    })
}

fn read_file_chunk_blocking(
    workspace_root: &str,
    file_path: &str,
    offset: u64,
) -> Result<LocalWorkspaceFileChunk, String> {
    apply_e2e_read_delay();
    let target = resolve_workspace_file(workspace_root, file_path)?;
    let metadata =
        fs::metadata(&target).map_err(|error| format!("Failed to read file metadata: {error}"))?;
    let mut file =
        fs::File::open(&target).map_err(|error| format!("Failed to open file: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek file: {error}"))?;
    let mut bytes = vec![0; MAX_BINARY_CHUNK_BYTES];
    let bytes_read = file
        .read(&mut bytes)
        .map_err(|error| format!("Failed to read file: {error}"))?;
    bytes.truncate(bytes_read);

    Ok(LocalWorkspaceFileChunk {
        path: target.to_string_lossy().into_owned(),
        name: file_name(&target),
        content_base64: STANDARD.encode(bytes),
        offset,
        eof: offset.saturating_add(bytes_read as u64) >= metadata.len(),
        size: metadata.len(),
        modified_at: modified_at(metadata.modified().ok()),
    })
}

#[tauri::command]
pub async fn read_local_workspace_text_file(
    workspace_root: String,
    file_path: String,
) -> Result<LocalWorkspaceTextFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_text_file_blocking(&workspace_root, &file_path)
    })
    .await
    .map_err(|error| format!("Workspace file operation failed: {error}"))?
}

#[tauri::command]
pub async fn read_local_workspace_file_chunk(
    workspace_root: String,
    file_path: String,
    offset: u64,
) -> Result<LocalWorkspaceFileChunk, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_file_chunk_blocking(&workspace_root, &file_path, offset)
    })
    .await
    .map_err(|error| format!("Workspace file operation failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_text_file_inside_workspace() {
        let directory = tempfile::tempdir().expect("create workspace");
        let target = directory.path().join("README.md");
        fs::write(&target, "hello").expect("seed file");

        let result = read_text_file_blocking(
            directory.path().to_str().expect("workspace path"),
            target.to_str().expect("file path"),
        )
        .expect("read file");

        assert_eq!(result.content, "hello");
        assert_eq!(
            result.revision,
            format!("sha256:{:x}", Sha256::digest(b"hello"))
        );
        assert!(result.editable);
        assert!(!result.truncated);
    }

    #[test]
    fn lists_workspace_entries_without_executor() {
        let directory = tempfile::tempdir().expect("create workspace");
        fs::create_dir(directory.path().join("src")).expect("seed directory");
        fs::write(directory.path().join("README.md"), "hello").expect("seed file");

        let result = list_entries_blocking(
            directory.path().to_str().expect("workspace path"),
            directory.path().to_str().expect("directory path"),
        )
        .expect("list entries");

        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].name, "src");
        assert!(result.entries[0].is_directory);
        assert_eq!(result.entries[1].name, "README.md");
    }

    #[test]
    fn rejects_file_outside_workspace() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let outside = tempfile::tempdir().expect("create outside directory");
        let target = outside.path().join("secret.txt");
        fs::write(&target, "secret").expect("seed file");

        let error = read_text_file_blocking(
            workspace.path().to_str().expect("workspace path"),
            target.to_str().expect("file path"),
        )
        .expect_err("reject outside file");

        assert_eq!(error, "File path is outside workspace");
    }

    #[test]
    fn reads_binary_file_in_chunks() {
        let directory = tempfile::tempdir().expect("create workspace");
        let target = directory.path().join("image.bin");
        fs::write(&target, b"image").expect("seed file");

        let result = read_file_chunk_blocking(
            directory.path().to_str().expect("workspace path"),
            target.to_str().expect("file path"),
            0,
        )
        .expect("read chunk");

        assert_eq!(result.content_base64, "aW1hZ2U=");
        assert_eq!(result.size, 5);
        assert!(result.eof);
    }
}
