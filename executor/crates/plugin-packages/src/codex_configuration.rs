//! Atomic Codex configuration publication and structural diagnostics.
use std::{fs, io::Write, path::Path};

#[track_caller]
pub fn replace_config(config_path: &Path, content: String) -> Result<(), String> {
    let caller = std::panic::Location::caller();
    crate::logging::log_executor_event(
        "codex config replacement requested",
        &[
            ("caller", format!("{}:{}", caller.file(), caller.line())),
            ("config_path", config_path.display().to_string()),
        ],
    );
    log_config_state("codex config replacement content", config_path, &content);
    let parent = config_path
        .parent()
        .ok_or_else(|| format!("Codex config has no parent: {}", config_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create Codex config directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create Codex config temp file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("failed to write Codex config temp file: {error}"))?;
    if let Ok(metadata) = fs::metadata(config_path) {
        fs::set_permissions(temporary.path(), metadata.permissions()).map_err(|error| {
            format!(
                "failed to preserve Codex config permissions {}: {error}",
                temporary.path().display()
            )
        })?;
    }
    #[cfg(unix)]
    if !config_path.exists() {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "failed to secure Codex config permissions {}: {error}",
                    temporary.path().display()
                )
            },
        )?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync Codex config temp file: {error}"))?;
    temporary.persist(config_path).map_err(|error| {
        format!(
            "failed to replace Codex config {}: {}",
            config_path.display(),
            error.error
        )
    })?;
    sync_parent_directory(parent)
        .map_err(|error| format!("failed to sync Codex config directory: {error}"))?;
    Ok(())
}

pub fn log_config_state(event: &str, path: &Path, content: &str) {
    let document = content.parse::<toml_edit::DocumentMut>().ok();
    crate::logging::log_executor_event(
        event,
        &[
            ("config_path", path.display().to_string()),
            ("bytes", content.len().to_string()),
            (
                "model_present",
                document
                    .as_ref()
                    .is_some_and(|doc| doc.contains_key("model"))
                    .to_string(),
            ),
            (
                "openai_base_url_present",
                document
                    .as_ref()
                    .is_some_and(|doc| doc.contains_key("openai_base_url"))
                    .to_string(),
            ),
        ],
    );
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}
