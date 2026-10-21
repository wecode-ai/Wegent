// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::local::plugin_catalog::list_wegent_store_plugins;

impl RuntimeWorkRpcHandler {
    pub(super) async fn read_composer_catalog(&self, payload: Value) -> Result<Value, AppIpcError> {
        let scope = self.composer_catalog_scope(&payload)?;
        let force_refresh = bool_field(&payload, "forceRefresh").unwrap_or(false);
        let started_at = Instant::now();
        let result = read_catalog_snapshot(
            &scope,
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
                ("task_id", scope.task_id.unwrap_or_default()),
                ("success", result.is_ok().to_string()),
                ("duration_ms", started_at.elapsed().as_millis().to_string()),
            ],
        );
        result
    }

    fn composer_catalog_scope(&self, payload: &Value) -> Result<ComposerCatalogScope, AppIpcError> {
        if payload.get("scope").and_then(Value::as_str) == Some("workspace") {
            return workspace_catalog_scope(payload);
        }
        let task_id = runtime_task_id(payload)
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
        Ok(ComposerCatalogScope {
            task_id: Some(task_id),
            workspace_path: Some(task.workspace_path),
            project_plugin_ids: task.project_plugin_ids,
        })
    }
}

struct ComposerCatalogScope {
    task_id: Option<String>,
    workspace_path: Option<String>,
    project_plugin_ids: Vec<String>,
}

fn workspace_catalog_scope(payload: &Value) -> Result<ComposerCatalogScope, AppIpcError> {
    if runtime_task_id(payload).is_some() {
        return Err(AppIpcError::new(
            "bad_request",
            "Workspace scope cannot include a taskId",
        ));
    }
    let path = match payload.get("workspacePath") {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) if !path.trim().is_empty() && Path::new(path).is_dir() => {
            Some(path.clone())
        }
        _ => {
            return Err(AppIpcError::new(
                "missing_workspace",
                "Composer workspace is unavailable",
            ))
        }
    };
    let index = crate::runtime_work::codex_global_state::CodexGlobalProjectIndex::load();
    let plugins = path
        .as_deref()
        .and_then(|path| index.project_for_path(path))
        .and_then(|project| project.ai_settings.as_ref())
        .and_then(|settings| settings.get("plugins"))
        .and_then(Value::as_array)
        .map(|plugins| {
            plugins
                .iter()
                .filter_map(|plugin| {
                    plugin
                        .get("pluginName")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ComposerCatalogScope {
        task_id: None,
        workspace_path: path,
        project_plugin_ids: plugins,
    })
}

// Keep this read path independent of marketplace reconciliation and installation.
// A catalog is only published after every required source has succeeded.
async fn read_catalog_snapshot<Request, RequestFuture, StoreFuture>(
    scope: &ComposerCatalogScope,
    force_refresh: bool,
    mut request: Request,
    store: StoreFuture,
) -> Result<Value, AppIpcError>
where
    Request: FnMut(&'static str, Value) -> RequestFuture,
    RequestFuture: Future<Output = Result<Value, AppIpcError>>,
    StoreFuture: Future<Output = Result<Value, AppIpcError>>,
{
    let cwds: Vec<&str> = scope.workspace_path.as_deref().into_iter().collect();
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
        json!({"cwds": cwds, "installSuggestionPluginNames": null}),
    )
    .await?;
    let marketplaces = required_array(&installed, "marketplaces")?;
    for marketplace in marketplaces {
        required_array(marketplace, "plugins")?;
    }
    let skills = request(
        "skills/list",
        json!({"cwds": cwds, "forceReload": force_refresh}),
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
        "taskId": scope.task_id,
        "scope": if scope.task_id.is_some() { "task" } else { "workspace" },
        "workspacePath": scope.workspace_path.as_deref().unwrap_or_default(),
        "projectPluginIds": scope.project_plugin_ids,
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
