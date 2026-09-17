// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::local::plugin_catalog::list_wegent_store_plugins;

impl RuntimeWorkRpcHandler {
    pub(super) async fn read_composer_catalog(&self, payload: Value) -> Result<Value, AppIpcError> {
        let task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let task = self.local_task_link(&task_id).ok_or_else(|| {
            AppIpcError::new(
                "task_not_found",
                "Composer task was not found on this device",
            )
        })?;
        if task.runtime != "codex" {
            return Err(AppIpcError::new(
                "unsupported_runtime",
                "Plugin catalogs require a Codex task",
            ));
        }
        if task.workspace_path.trim().is_empty() {
            return Err(AppIpcError::new(
                "missing_workspace",
                "Composer task has no workspace",
            ));
        }
        let force_refresh = bool_field(&payload, "forceRefresh").unwrap_or(false);
        let started_at = Instant::now();
        let result = read_catalog_snapshot(
            &task,
            force_refresh,
            |method, params| async move {
                self.codex_app_server
                    .request(method, params)
                    .await
                    .map_err(|error| AppIpcError::new("composer_catalog_read_failed", error))
            },
            async {
                let store = tokio::task::spawn_blocking(list_wegent_store_plugins)
                    .await
                    .map_err(|error| {
                        AppIpcError::new("plugin_store_list_task_failed", error.to_string())
                    })?
                    .map_err(|error| AppIpcError::new("plugin_store_list_failed", error))?;
                serde_json::to_value(store)
                    .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()))
            },
        )
        .await;
        log_executor_event(
            "composer catalog read finished",
            &[
                ("task_id", task_id),
                ("success", result.is_ok().to_string()),
                ("duration_ms", started_at.elapsed().as_millis().to_string()),
            ],
        );
        result
    }
}

// Keep this read path independent of marketplace reconciliation and installation.
// A catalog is only published after every required source has succeeded.
async fn read_catalog_snapshot<Request, RequestFuture, StoreFuture>(
    task: &RuntimeTaskLink,
    force_refresh: bool,
    mut request: Request,
    store: StoreFuture,
) -> Result<Value, AppIpcError>
where
    Request: FnMut(&'static str, Value) -> RequestFuture,
    RequestFuture: Future<Output = Result<Value, AppIpcError>>,
    StoreFuture: Future<Output = Result<Value, AppIpcError>>,
{
    let mut apps = Vec::new();
    let mut cursor = Value::Null;
    let mut cursors = HashSet::new();
    loop {
        let response = request(
            "app/list",
            json!({"cursor": cursor, "limit": 100, "forceRefetch": force_refresh}),
        )
        .await?;
        apps.extend(required_array(&response, "data")?.iter().cloned());
        match response.get("nextCursor") {
            None | Some(Value::Null) => break,
            Some(Value::String(next)) if next.is_empty() => break,
            Some(Value::String(next)) if cursors.insert(next.clone()) => {
                cursor = Value::String(next.clone());
            }
            _ => return Err(invalid_catalog("Invalid or repeated app catalog cursor")),
        }
    }
    let installed = request(
        "plugin/installed",
        json!({"cwds": [&task.workspace_path], "installSuggestionPluginNames": null}),
    )
    .await?;
    let marketplaces = required_array(&installed, "marketplaces")?;
    for marketplace in marketplaces {
        required_array(marketplace, "plugins")?;
    }
    let skills = request(
        "skills/list",
        json!({"cwds": [&task.workspace_path], "forceReload": force_refresh}),
    )
    .await?;
    let skill_entries = required_array(&skills, "data")?;
    for entry in skill_entries {
        required_array(entry, "skills")?;
        if entry
            .get("errors")
            .and_then(Value::as_array)
            .is_some_and(|errors| !errors.is_empty())
        {
            return Err(AppIpcError::new(
                "composer_skills_read_failed",
                "The task skill catalog contains read errors",
            ));
        }
    }
    let store = store.await?;
    required_array(&store, "plugins")?;
    Ok(json!({
        "taskId": task.local_task_id,
        "workspacePath": task.workspace_path,
        "projectPluginIds": task.project_plugin_ids,
        "apps": apps,
        "marketplaces": marketplaces,
        "skills": skill_entries,
        "store": store,
    }))
}

fn invalid_catalog(message: &str) -> AppIpcError {
    AppIpcError::new("invalid_composer_catalog", message)
}

fn required_array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, AppIpcError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_catalog(&format!("Catalog field {key} must be an array")))
}

#[cfg(test)]
#[path = "composer_catalog_tests.rs"]
mod tests;
