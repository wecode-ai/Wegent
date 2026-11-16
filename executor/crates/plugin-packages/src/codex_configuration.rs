//! Atomic Codex configuration publication and structural diagnostics.
use std::{fs, path::Path};

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
    wegent_filesystem::atomic_file::write_atomic_file(config_path, content.as_bytes()).map_err(
        |error| {
            format!(
                "failed to replace Codex config {}: {}",
                config_path.display(),
                error
            )
        },
    )?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn publishes_config_while_existing_readers_retain_their_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        replace_config(&path, "model = 'before'\n".into()).unwrap();
        let mut reader = fs::File::open(&path).unwrap();

        replace_config(&path, "model = 'after'\n".into()).unwrap();

        let mut original = String::new();
        reader.read_to_string(&mut original).unwrap();
        assert_eq!(original, "model = 'before'\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), "model = 'after'\n");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn creates_private_config_and_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        replace_config(&path, "model = 'first'\n".into()).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        replace_config(&path, "model = 'second'\n".into()).unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
