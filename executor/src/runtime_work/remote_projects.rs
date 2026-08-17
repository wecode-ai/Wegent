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
}

pub(crate) struct RemoteProjectItem {
    pub(crate) key: String,
    pub(crate) host_id: String,
    pub(crate) remote_path: String,
    pub(crate) label: Option<String>,
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
