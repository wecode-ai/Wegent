// SPDX-License-Identifier: Apache-2.0
//! Reconcile installed account adapters without depending on a renderer window.

use super::{migrate, AuthError, NativeAuthGateway};
use crate::local::backend::LocalBackendTransport;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    id: String,
    installed_plugin_id: u64,
    connector_slug: String,
}

#[derive(Default)]
pub(super) struct Reconciler {
    retries: HashMap<(u64, String), Instant>,
    cursor: usize,
}

impl Reconciler {
    pub async fn reconcile<T: LocalBackendTransport>(
        &mut self,
        transport: T,
        home: &Path,
    ) -> Result<(), AuthError> {
        let ids = installed_ids(home)?;
        // Rotate batches so an unavailable source never starves a later plugin.
        let selected: Vec<_> = ids
            .iter()
            .cycle()
            .skip(self.cursor)
            .take(ids.len().min(16))
            .copied()
            .collect();
        self.cursor = if ids.is_empty() {
            0
        } else {
            (self.cursor + selected.len()) % ids.len()
        };
        self.retries
            .retain(|(id, _), until| ids.contains(id) && *until > Instant::now());
        let response = NativeAuthGateway::new(transport.clone())
            .call(
                "plugin.auth.automatic",
                json!({"installed_plugin_ids": selected}),
            )
            .await?;
        let intents: Vec<Intent> = serde_json::from_value(response["migrations"].clone())
            .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
        if intents.len() > 256 {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        let mut pending = tokio::task::JoinSet::new();
        for intent in intents {
            let key = (intent.installed_plugin_id, intent.connector_slug);
            if !selected.contains(&key.0) || self.retries.contains_key(&key) {
                continue;
            }
            let transport = transport.clone();
            let home = home.to_owned();
            pending.spawn(async move {
                let result = migrate(transport, &home, &intent.id).await;
                (key, result.is_ok())
            });
            if pending.len() >= 4 {
                if let Some(Ok((key, succeeded))) = pending.join_next().await {
                    self.record(key, succeeded);
                }
            }
        }
        while let Some(result) = pending.join_next().await {
            if let Ok((key, succeeded)) = result {
                self.record(key, succeeded);
            }
        }
        Ok(())
    }

    fn record(&mut self, key: (u64, String), _succeeded: bool) {
        // Missing/locked credentials remain local. Retry after login without
        // repeatedly prompting the OS on every scheduler tick.
        self.retries.insert(
            key,
            Instant::now() + Duration::from_secs(60),
        );
    }
}

fn installed_ids(home: &Path) -> Result<Vec<u64>, AuthError> {
    let path = home.join("capabilities/manifest.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(AuthError("plugin_auth_invalid_package")),
    };
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Err(AuthError("plugin_auth_invalid_package"));
    }
    let manifest: Value = serde_json::from_slice(
        &fs::read(path).map_err(|_| AuthError("plugin_auth_invalid_package"))?,
    )
    .map_err(|_| AuthError("plugin_auth_invalid_package"))?;
    let mut ids: Vec<u64> = manifest["plugins"]
        .as_object()
        .ok_or(AuthError("plugin_auth_invalid_package"))?
        .values()
        .filter(|entry| entry["managed"] == true && entry["enabled"] == true)
        .filter_map(|entry| entry["installed_plugin_id"].as_u64().filter(|id| *id > 0))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_only_reports_enabled_managed_installations() {
        let home = tempfile::tempdir().unwrap();
        assert!(installed_ids(home.path()).unwrap().is_empty());
        fs::create_dir(home.path().join("capabilities")).unwrap();
        fs::write(
            home.path().join("capabilities/manifest.json"),
            json!({"plugins": {
                "managed": {"installed_plugin_id": 12, "managed": true, "enabled": true},
                "disabled": {"installed_plugin_id": 13, "managed": true, "enabled": false},
                "personal": {"installed_plugin_id": 14, "managed": false, "enabled": true},
                "duplicate": {"installed_plugin_id": 12, "managed": true, "enabled": true}
            }})
            .to_string(),
        )
        .unwrap();
        assert_eq!(installed_ids(home.path()).unwrap(), vec![12]);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_rejects_symlinked_manifests() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("capabilities")).unwrap();
        fs::write(home.path().join("untrusted.json"), r#"{"plugins":{}}"#).unwrap();
        std::os::unix::fs::symlink(
            home.path().join("untrusted.json"),
            home.path().join("capabilities/manifest.json"),
        )
        .unwrap();
        assert_eq!(
            installed_ids(home.path()),
            Err(AuthError("plugin_auth_invalid_package"))
        );
    }
}
