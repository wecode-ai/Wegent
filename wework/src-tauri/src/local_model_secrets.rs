// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;

const LOCAL_MODEL_SECRET_SERVICE: &str = "com.wecode.wework.local-model";

fn local_model_secret_entry(config_id: &str) -> Result<keyring::Entry, String> {
    let config_id = config_id.trim();
    if config_id.is_empty() {
        return Err("Local model configuration ID is required".to_string());
    }
    keyring::Entry::new(LOCAL_MODEL_SECRET_SERVICE, config_id)
        .map_err(|error| format!("Failed to access local model credentials: {error}"))
}

#[tauri::command]
pub async fn read_local_model_api_keys(
    config_ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut api_keys = HashMap::new();
        for config_id in config_ids {
            let entry = local_model_secret_entry(&config_id)?;
            match entry.get_password() {
                Ok(api_key) => {
                    api_keys.insert(config_id, api_key);
                }
                Err(keyring::Error::NoEntry) => {}
                Err(error) => {
                    return Err(format!("Failed to read local model credentials: {error}"));
                }
            }
        }
        Ok(api_keys)
    })
    .await
    .map_err(|error| format!("Failed to join local model credential read: {error}"))?
}

#[tauri::command]
pub async fn delete_local_model_api_keys(config_ids: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for config_id in config_ids {
            let entry = local_model_secret_entry(&config_id)?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(error) => {
                    return Err(format!("Failed to delete local model credentials: {error}"));
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Failed to join local model credential deletion: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_model_secret_entry_rejects_empty_configuration_ids() {
        assert!(local_model_secret_entry("  ").is_err());
    }
}
