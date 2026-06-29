// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};

use super::util::{normalize_workspace_path, path_is_within, workspace_label};

const CODEX_GLOBAL_STATE_FILENAME: &str = ".codex-global-state.json";
const SAVED_WORKSPACE_ROOTS_KEY: &str = "electron-saved-workspace-roots";
const WORKSPACE_ROOT_LABELS_KEY: &str = "electron-workspace-root-labels";
const PROJECT_ORDER_KEY: &str = "project-order";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexGlobalProject {
    pub workspace_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CodexGlobalProjectIndex {
    projects: Vec<CodexGlobalProject>,
}

impl CodexGlobalProjectIndex {
    pub fn load() -> Self {
        load_codex_global_state()
            .map(|payload| Self {
                projects: projects_from_payload(&payload),
            })
            .unwrap_or_default()
    }

    pub fn projects(&self) -> &[CodexGlobalProject] {
        &self.projects
    }

    pub fn has_projects(&self) -> bool {
        !self.projects.is_empty()
    }

    pub fn project_for_path(&self, workspace_path: &str) -> Option<&CodexGlobalProject> {
        let normalized = normalize_workspace_path(workspace_path);
        self.projects
            .iter()
            .filter(|project| path_is_within(&project.workspace_path, &normalized))
            .max_by_key(|project| project.workspace_path.len())
    }
}

pub(crate) fn ensure_codex_global_project(
    workspace_path: &str,
    label: Option<&str>,
) -> Result<CodexGlobalProject, String> {
    let normalized_workspace = normalize_workspace_path(workspace_path);
    let state_path = codex_global_state_path();
    let mut payload = read_state_payload(&state_path).unwrap_or_default();
    upsert_text_list(
        &mut payload,
        SAVED_WORKSPACE_ROOTS_KEY,
        &normalized_workspace,
    );
    upsert_text_list(&mut payload, PROJECT_ORDER_KEY, &normalized_workspace);
    if let Some(label) = label.map(str::trim).filter(|value| !value.is_empty()) {
        let labels = payload
            .entry(WORKSPACE_ROOT_LABELS_KEY.to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(labels) = labels.as_object_mut() {
            labels.insert(
                normalized_workspace.clone(),
                Value::String(label.to_owned()),
            );
        }
    }
    write_state_payload(&state_path, &payload)?;
    Ok(project_from_path(&normalized_workspace, &payload))
}

pub(crate) fn rename_codex_global_project(
    workspace_path: &str,
    label: &str,
) -> Result<CodexGlobalProject, String> {
    let normalized_label = label.trim();
    if normalized_label.is_empty() {
        return Err("label is required".to_owned());
    }
    let project = ensure_codex_global_project(workspace_path, Some(normalized_label))?;
    Ok(CodexGlobalProject {
        name: normalized_label.to_owned(),
        ..project
    })
}

pub(crate) fn remove_codex_global_project(workspace_path: &str) -> Result<String, String> {
    let normalized_workspace = normalize_workspace_path(workspace_path);
    let state_path = codex_global_state_path();
    let mut payload = read_state_payload(&state_path).unwrap_or_default();
    remove_text_list_item(
        &mut payload,
        SAVED_WORKSPACE_ROOTS_KEY,
        &normalized_workspace,
    );
    remove_text_list_item(&mut payload, PROJECT_ORDER_KEY, &normalized_workspace);
    if let Some(labels) = payload
        .get_mut(WORKSPACE_ROOT_LABELS_KEY)
        .and_then(Value::as_object_mut)
    {
        labels.remove(&normalized_workspace);
    }
    write_state_payload(&state_path, &payload)?;
    Ok(normalized_workspace)
}

fn load_codex_global_state() -> Option<Map<String, Value>> {
    read_state_payload(&codex_global_state_path())
}

fn codex_global_state_path() -> PathBuf {
    codex_home().join(CODEX_GLOBAL_STATE_FILENAME)
}

fn codex_home() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

fn read_state_payload(path: &Path) -> Option<Map<String, Value>> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&content)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn write_state_payload(path: &Path, payload: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create Codex state directory: {error}"))?;
    }
    let content = serde_json::to_vec_pretty(&Value::Object(payload.clone()))
        .map_err(|error| format!("failed to serialize Codex global state: {error}"))?;
    fs::write(path, content).map_err(|error| format!("failed to write Codex global state: {error}"))
}

fn projects_from_payload(payload: &Map<String, Value>) -> Vec<CodexGlobalProject> {
    text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY))
        .into_iter()
        .map(|workspace_path| project_from_path(&workspace_path, payload))
        .collect()
}

fn project_from_path(workspace_path: &str, payload: &Map<String, Value>) -> CodexGlobalProject {
    let label = payload
        .get(WORKSPACE_ROOT_LABELS_KEY)
        .and_then(Value::as_object)
        .and_then(|labels| labels.get(workspace_path))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| workspace_label(workspace_path));
    CodexGlobalProject {
        workspace_path: workspace_path.to_owned(),
        name: label,
    }
}

fn upsert_text_list(payload: &mut Map<String, Value>, key: &str, value: &str) {
    let mut values = text_list(payload.get(key));
    values.retain(|item| item != value);
    values.insert(0, value.to_owned());
    payload.insert(
        key.to_owned(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

fn remove_text_list_item(payload: &mut Map<String, Value>, key: &str, value: &str) {
    let mut values = text_list(payload.get(key));
    values.retain(|item| item != value);
    payload.insert(
        key.to_owned(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

fn text_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(normalize_workspace_path)
        .filter(|value| !value.is_empty())
        .collect()
}
