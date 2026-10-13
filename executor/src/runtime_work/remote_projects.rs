// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::util::normalize_workspace_path;

const REMOTE_PROJECTS_KEY: &str = "remote-projects";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexGlobalRemoteProject {
    pub(crate) id: String,
    pub(crate) host_id: String,
    pub(crate) remote_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) project_key: Option<String>,
    #[serde(default)]
    pub(crate) roots: Vec<String>,
    #[serde(default)]
    pub(crate) default_project_space: Option<Value>,
    #[serde(default)]
    pub(crate) ai_settings: Option<Value>,
}

pub(crate) struct RemoteProjectItem {
    pub(crate) key: String,
    pub(crate) host_id: String,
    pub(crate) remote_path: String,
    pub(crate) label: Option<String>,
    pub(crate) project_key: Option<String>,
    pub(crate) roots: Vec<String>,
    pub(crate) default_project_space: Option<Value>,
    pub(crate) ai_settings: Option<Value>,
}

pub(crate) fn remote_project_items(value: Option<&Value>) -> Vec<RemoteProjectItem> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let key = clean_string(item.get("id")?)?;
            let host_id = clean_string(item.get("hostId").or_else(|| item.get("host_id"))?)?;
            let remote_path = normalize_workspace_path(&clean_string(
                item.get("remotePath").or_else(|| item.get("remote_path"))?,
            )?);
            if remote_path.is_empty() {
                return None;
            }
            Some(RemoteProjectItem {
                key,
                host_id,
                project_key: item.get("projectKey").and_then(clean_string),
                roots: remote_project_roots(item, &remote_path),
                default_project_space: item
                    .get("defaultProjectSpace")
                    .filter(|value| !value.is_null())
                    .cloned(),
                ai_settings: item
                    .get("aiSettings")
                    .filter(|value| !value.is_null())
                    .cloned(),
                remote_path,
                label: item
                    .get("label")
                    .or_else(|| item.get("name"))
                    .and_then(clean_string),
            })
        })
        .collect()
}

pub(crate) fn upsert_remote_project_payload(
    payload: &mut Map<String, Value>,
    project: &CodexGlobalRemoteProject,
) {
    let projects = payload
        .entry(REMOTE_PROJECTS_KEY.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !projects.is_array() {
        *projects = Value::Array(Vec::new());
    }
    let projects = projects
        .as_array_mut()
        .expect("remote projects is an array");
    let index = projects.iter().position(|item| {
        item.get("id").and_then(clean_string).as_deref() == Some(project.id.as_str())
    });
    let existing = index
        .and_then(|index| projects.get_mut(index))
        .and_then(Value::as_object_mut);
    let mut item = existing.cloned().unwrap_or_default();
    item.insert("id".to_owned(), Value::String(project.id.clone()));
    item.insert("hostId".to_owned(), Value::String(project.host_id.clone()));
    item.insert(
        "remotePath".to_owned(),
        Value::String(project.remote_path.clone()),
    );
    if let Some(label) = project.label.as_deref().and_then(clean_text) {
        item.insert("label".to_owned(), Value::String(label));
    }
    item.insert(
        "projectKey".to_owned(),
        serde_json::json!(project.project_key),
    );
    item.insert("roots".to_owned(), serde_json::json!(project.roots));
    item.insert(
        "defaultProjectSpace".to_owned(),
        serde_json::json!(project.default_project_space),
    );
    item.insert(
        "aiSettings".to_owned(),
        serde_json::json!(project.ai_settings),
    );
    let item = Value::Object(item);
    if let Some(index) = index {
        projects[index] = item;
    } else {
        projects.push(item);
    }
}

fn clean_string(value: &Value) -> Option<String> {
    value.as_str().and_then(clean_text)
}

fn clean_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn remote_project_roots(item: &Value, remote_path: &str) -> Vec<String> {
    let mut roots = item
        .get("roots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(clean_string)
        .map(|path| normalize_workspace_path(&path))
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    if roots.is_empty() {
        roots.push(remote_path.to_owned());
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remote_metadata_round_trip_preserves_owner_roots_and_settings() {
        let project = CodexGlobalRemoteProject {
            id: "sidebar-stable".to_owned(),
            host_id: "remote".to_owned(),
            remote_path: "/new".to_owned(),
            label: Some("Project".to_owned()),
            project_key: Some("owner-stable".to_owned()),
            roots: vec!["/new".to_owned(), "/extra".to_owned()],
            default_project_space: Some(json!({"projectStore": "backend", "projectId": "space"})),
            ai_settings: Some(
                json!({"instructions": "New", "plugins": [{"id": "quality@team"}], "quickPhrases": [{"id": "review"}]}),
            ),
        };
        let mut payload = Map::new();
        upsert_remote_project_payload(&mut payload, &project);
        let items = remote_project_items(payload.get(REMOTE_PROJECTS_KEY));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key, "sidebar-stable");
        assert_eq!(items[0].project_key, project.project_key);
        assert_eq!(
            items[0].roots,
            project
                .roots
                .iter()
                .map(|path| normalize_workspace_path(path))
                .collect::<Vec<_>>()
        );
        assert_eq!(items[0].ai_settings, project.ai_settings);
        assert_eq!(
            items[0].default_project_space,
            project.default_project_space
        );
        let cleared = CodexGlobalRemoteProject {
            ai_settings: None,
            default_project_space: None,
            ..project
        };
        upsert_remote_project_payload(&mut payload, &cleared);
        let items = remote_project_items(payload.get(REMOTE_PROJECTS_KEY));
        assert_eq!(items[0].ai_settings, None);
        assert_eq!(items[0].default_project_space, None);
    }

    #[test]
    fn legacy_remote_project_retains_its_single_directory() {
        let value = json!([{"id": "legacy", "hostId": "remote", "remotePath": "/legacy", "label": "Legacy"}]);
        let items = remote_project_items(Some(&value));
        assert_eq!(items[0].roots, vec![normalize_workspace_path("/legacy")]);
        assert_eq!(items[0].project_key, None);
    }
}
