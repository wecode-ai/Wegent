// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// An immutable catalog remains available until its native process has exited.
pub struct ProcessCatalog {
    path: PathBuf,
}

impl ProcessCatalog {
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn write(path: PathBuf, catalog: &Value) -> Result<Self, String> {
        write_json(&path, catalog)?;
        Ok(Self { path })
    }
}

impl Drop for ProcessCatalog {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub async fn prepare_process_catalog(
    binary: &str,
    home: &Path,
) -> Result<Option<ProcessCatalog>, String> {
    let config_path = home.join("config.toml");
    let config = match fs::read_to_string(&config_path) {
        Ok(source) => source
            .parse::<DocumentMut>()
            .map_err(|_| format!("Invalid native catalog configuration: {config_path:?}"))?,
        Err(error) if error.kind() == ErrorKind::NotFound => DocumentMut::new(),
        Err(error) => {
            return Err(format!(
                "Read native catalog configuration {config_path:?}: {error}"
            ))
        }
    };
    let profile_catalog = config
        .get("profile")
        .and_then(|profile| profile.as_str())
        .and_then(|profile| {
            config
                .get("profiles")?
                .get(profile)?
                .get("model_catalog_json")
        });
    if config.get("model_catalog_json").is_some() || profile_catalog.is_some() {
        return Ok(None);
    }
    let native = export_bundled_catalog(binary, home).await?;
    let mut catalog = load_baseline_catalog_with_native(None, Some(&native)).await?;
    apply_catalog_overrides(&mut catalog, &read_catalog_overrides());
    append_catalog_vision_sidecars(&mut catalog);
    let path = home.join(format!("wework-model-catalog-{}.json", uuid::Uuid::new_v4()));
    let snapshot = ProcessCatalog::write(path, &catalog)?;
    log_executor_event(
        "codex router model catalog prepared",
        &[
            (
                "model_count",
                catalog["models"].as_array().map_or(0, Vec::len).to_string(),
            ),
            (
                "catalog_bytes",
                fs::metadata(snapshot.path())
                    .map_err(|error| {
                        format!("Inspect native catalog {:?}: {error}", snapshot.path())
                    })?
                    .len()
                    .to_string(),
            ),
        ],
    );
    Ok(Some(snapshot))
}

pub(super) fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "model catalog path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Create catalog directory {parent:?}: {error}"))?;
    let temporary = parent.join(format!(".catalog-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes)
            .map_err(|error| format!("Write catalog file {temporary:?}: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Publish catalog file {path:?}: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_catalog_keeps_complete_metadata_until_its_owner_drops() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("catalog.json");
        let catalog = json!({"models":[{"slug":"native", "base_instructions":"legacy", "model_messages":{"instructions_template":"完整原生指令\n".repeat(100_000),"permissions":{"read_only":"keep policy"}}}]});
        let snapshot = ProcessCatalog::write(path.clone(), &catalog).unwrap();
        assert!(fs::metadata(snapshot.path()).unwrap().len() > 1_048_576);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(snapshot.path()).unwrap()).unwrap(),
            catalog
        );
        drop(snapshot);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn explicit_native_catalogs_do_not_spawn_an_exporter_or_get_replaced() {
        for source in [
            "model_catalog_json='user-models.json'",
            "profile='custom'\n[profiles.custom]\nmodel_catalog_json='user-models.json'",
        ] {
            let root = tempfile::tempdir().unwrap();
            fs::write(root.path().join("config.toml"), source).unwrap();
            assert!(prepare_process_catalog("must-not-spawn", root.path())
                .await
                .unwrap()
                .is_none());
            assert_eq!(
                fs::read_to_string(root.path().join("config.toml")).unwrap(),
                source
            );
        }
    }

    #[tokio::test]
    async fn invalid_native_configuration_fails_before_startup() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("config.toml"), "invalid = [").unwrap();
        assert!(prepare_process_catalog("must-not-spawn", root.path())
            .await
            .is_err());
    }
}
