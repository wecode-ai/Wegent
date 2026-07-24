use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoWorkspaceEntry {
    path: String,
    name: String,
    node_type: &'static str,
    size: u64,
    modified_at_ms: u128,
    absolute_path: String,
}

fn store_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("todo"))
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))
}

fn safe_key(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid TODO storage key".to_string());
    }
    Ok(value)
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("Workspace path must be relative".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Workspace path escapes the TODO directory".to_string());
    }
    Ok(path.to_path_buf())
}

fn workspace_root(app: &tauri::AppHandle, item_id: &str) -> Result<PathBuf, String> {
    Ok(store_root(app)?.join("workspaces").join(safe_key(item_id)?))
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Workspace paths cannot traverse symbolic links".to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to inspect workspace path: {error}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn load_todo_store(app: tauri::AppHandle, scope: String) -> Result<Option<String>, String> {
    let path = store_root(&app)?.join(format!("{}.json", safe_key(&scope)?));
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("Failed to read TODO store: {error}"))
}

#[tauri::command]
pub fn save_todo_store(
    app: tauri::AppHandle,
    scope: String,
    contents: String,
) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&contents)
        .map_err(|error| format!("TODO store must contain valid JSON: {error}"))?;
    let root = store_root(&app)?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create TODO store directory: {error}"))?;
    let target = root.join(format!("{}.json", safe_key(&scope)?));
    let temporary = target.with_extension("json.tmp");
    std::fs::write(&temporary, contents)
        .map_err(|error| format!("Failed to write TODO store: {error}"))?;
    std::fs::rename(temporary, target)
        .map_err(|error| format!("Failed to commit TODO store: {error}"))
}

#[tauri::command]
pub fn ensure_todo_workspace(
    app: tauri::AppHandle,
    item_id: String,
    title: String,
    objective: String,
) -> Result<String, String> {
    let root = workspace_root(&app, &item_id)?;
    std::fs::create_dir_all(root.join("context"))
        .and_then(|_| std::fs::create_dir_all(root.join("work")))
        .map_err(|error| format!("Failed to initialize TODO workspace: {error}"))?;
    let readme = root.join("README.md");
    if !readme.exists() {
        std::fs::write(&readme, format!("# {title}\n\n{objective}\n"))
            .map_err(|error| format!("Failed to create TODO README: {error}"))?;
    }
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn ensure_todo_work_directory(
    app: tauri::AppHandle,
    item_id: String,
    work_type: String,
) -> Result<String, String> {
    let directory = workspace_root(&app, &item_id)?
        .join("work")
        .join(safe_key(&work_type)?);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create work directory: {error}"))?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn write_todo_workspace_file(
    app: tauri::AppHandle,
    item_id: String,
    relative_path: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let root = workspace_root(&app, &item_id)?;
    let relative = safe_relative_path(&relative_path)?;
    reject_symlink_components(&root, &relative)?;
    let target = root.join(relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create workspace directory: {error}"))?;
    }
    std::fs::write(&target, bytes)
        .map_err(|error| format!("Failed to write workspace file: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

fn is_protected_workspace_path(path: &Path) -> bool {
    matches!(
        path.to_string_lossy().as_ref(),
        "README.md" | "context" | "work"
    )
}

#[tauri::command]
pub fn rename_todo_workspace_entry(
    app: tauri::AppHandle,
    item_id: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let root = workspace_root(&app, &item_id)?;
    let from = safe_relative_path(&from_path)?;
    let to = safe_relative_path(&to_path)?;
    reject_symlink_components(&root, &from)?;
    reject_symlink_components(&root, &to)?;
    if is_protected_workspace_path(&from) || is_protected_workspace_path(&to) {
        return Err("Core TODO workspace entries cannot be renamed".to_string());
    }
    let source = root.join(from);
    let target = root.join(to);
    if target.exists() {
        return Err("Workspace destination already exists".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create workspace directory: {error}"))?;
    }
    std::fs::rename(source, target)
        .map_err(|error| format!("Failed to rename workspace entry: {error}"))
}

#[tauri::command]
pub fn delete_todo_workspace_entry(
    app: tauri::AppHandle,
    item_id: String,
    relative_path: String,
) -> Result<(), String> {
    let root = workspace_root(&app, &item_id)?;
    let relative = safe_relative_path(&relative_path)?;
    reject_symlink_components(&root, &relative)?;
    if is_protected_workspace_path(&relative) {
        return Err("Core TODO workspace entries cannot be deleted".to_string());
    }
    let target = root.join(relative);
    if target.is_dir() {
        std::fs::remove_dir_all(target)
            .map_err(|error| format!("Failed to delete workspace directory: {error}"))
    } else {
        std::fs::remove_file(target)
            .map_err(|error| format!("Failed to delete workspace file: {error}"))
    }
}

#[tauri::command]
pub fn get_todo_workspace_path(app: tauri::AppHandle, item_id: String) -> Result<String, String> {
    let root = workspace_root(&app, &item_id)?;
    if !root.exists() {
        return Err("TODO workspace does not exist".to_string());
    }
    Ok(root.to_string_lossy().into_owned())
}

fn collect_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<TodoWorkspaceEntry>,
) -> Result<(), String> {
    for result in std::fs::read_dir(directory)
        .map_err(|error| format!("Failed to read TODO workspace: {error}"))?
    {
        let entry = result.map_err(|error| format!("Failed to read workspace entry: {error}"))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Failed to inspect workspace entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect workspace entry type: {error}"))?;
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("Failed to resolve workspace entry: {error}"))?;
        entries.push(TodoWorkspaceEntry {
            path: relative.to_string_lossy().replace('\\', "/"),
            name: entry.file_name().to_string_lossy().into_owned(),
            node_type: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            },
            size: metadata.len(),
            modified_at_ms: metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |value| value.as_millis()),
            absolute_path: path.to_string_lossy().into_owned(),
        });
        if file_type.is_dir() && !file_type.is_symlink() {
            collect_entries(root, &path, entries)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_todo_workspace(
    app: tauri::AppHandle,
    item_id: String,
) -> Result<Vec<TodoWorkspaceEntry>, String> {
    let root = workspace_root(&app, &item_id)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    collect_entries(&root, &root, &mut entries)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::{is_protected_workspace_path, reject_symlink_components, safe_relative_path};
    use std::path::Path;

    #[test]
    fn workspace_paths_cannot_escape() {
        assert!(safe_relative_path("context/brief.md").is_ok());
        assert!(safe_relative_path("../secret").is_err());
        assert!(safe_relative_path("/tmp/secret").is_err());
    }

    #[test]
    fn core_workspace_entries_are_protected() {
        assert!(is_protected_workspace_path(Path::new("README.md")));
        assert!(is_protected_workspace_path(Path::new("context")));
        assert!(!is_protected_workspace_path(Path::new("context/brief.md")));
    }

    #[cfg(unix)]
    #[test]
    fn workspace_paths_cannot_traverse_symbolic_links() {
        let root = std::env::temp_dir().join(format!("wework-todo-{}", std::process::id()));
        let outside = root.with_extension("outside");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();

        assert!(reject_symlink_components(&root, Path::new("linked/secret.txt")).is_err());

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }
}
