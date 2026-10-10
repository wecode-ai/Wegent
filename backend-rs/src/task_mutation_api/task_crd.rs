// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task CRD JSON transforms for `PUT /api/tasks/{task_id}`.
//!
//! `update_task` mutates the validated `Task` model and persists
//! `task_crd.model_dump(mode="json", exclude_none=True)`, which re-serializes
//! every model field in the schema's declaration order and drops null fields.
//! These helpers apply the same update rules to the stored JSON, re-render it
//! in that order, and serialize it with [`python_json_value`] so the persisted
//! document matches the source's `json.dumps` rendering.

use serde_json::Value;

use super::models::TaskUpdateBody;
use crate::crd::CrdDocument;
use crate::json_compat::{JsonNull, OpaqueJson, python_json_value};

/// `TaskStatus` final states that reject a move to a non-final state.
const FINAL_STATES: [&str; 4] = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"];
/// `TaskStatus` non-final states blocked after a final state.
const NON_FINAL_STATES: [&str; 3] = ["PENDING", "RUNNING", "CANCELLING"];

/// Apply `update_task`'s field rules to the stored CRD JSON.
pub(crate) fn apply_update(task_json: &mut Value, update: &TaskUpdateBody, now: &str) {
    if !task_json.is_object() {
        *task_json = empty_object();
    }

    if update.title.is_present() || update.prompt.is_present() {
        let spec = ensure_object(task_json, "spec");
        if let Some(title) = update.title.value() {
            set(spec, "title", Value::String(title.clone()));
        }
        if let Some(prompt) = update.prompt.value() {
            set(spec, "prompt", Value::String(prompt.clone()));
        }
    }

    // `_update_task_status`: status transitions are protected, progress,
    // result, and errorMessage are applied unconditionally. Only reached when
    // the stored CRD carries a status object.
    if task_json.get("status").is_some_and(Value::is_object) {
        let status = ensure_object(task_json, "status");
        if let Some(new_status) = update.status.value() {
            let current = status
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let allowed = if current == "CANCELLING" {
                matches!(new_status.as_str(), "CANCELLED" | "FAILED")
            } else if FINAL_STATES.contains(&current) {
                !NON_FINAL_STATES.contains(&new_status.as_str())
            } else {
                true
            };
            if allowed {
                set(status, "status", Value::String(new_status.clone()));
            }
        }
        if let Some(progress) = update.progress.value() {
            set(status, "progress", Value::from(*progress));
        }
        if let Some(result) = update.result.value() {
            set(status, "result", result.to_value());
        }
        if let Some(error_message) = update.error_message.value() {
            set(status, "errorMessage", Value::String(error_message.clone()));
        }

        // `task_crd.status.updatedAt = datetime.now()`, and the requested
        // terminal states also refresh `completedAt`.
        set(status, "updatedAt", Value::String(now.to_owned()));
        if let Some(new_status) = update.status.value()
            && matches!(new_status.as_str(), "COMPLETED" | "FAILED" | "CANCELLED")
        {
            set(status, "completedAt", Value::String(now.to_owned()));
        }
    }
}

/// `_update_workspace_if_needed`: apply the git overrides to the workspace
/// CRD's repository block.
pub(crate) fn apply_workspace_update(workspace_json: &mut Value, update: &TaskUpdateBody) {
    if !workspace_json.is_object() {
        return;
    }
    let spec = ensure_object(workspace_json, "spec");
    let repository = ensure_object(spec, "repository");
    if let Some(value) = update.git_url.value() {
        set(repository, "gitUrl", Value::String(value.clone()));
    }
    if let Some(value) = update.git_repo_id.value() {
        set(repository, "gitRepoId", Value::from(*value));
    }
}

/// `Task.model_dump(mode="json", exclude_none=True)` serialized the way the
/// source's `json.dumps` renders it.
pub(crate) fn dump(task_json: &Value) -> String {
    python_json_value(&render_task(task_json))
}

/// `null` as the source's JSON null (used for fields the model leaves unset).
pub(crate) fn json_null() -> OpaqueJson {
    OpaqueJson::from_serializable(JsonNull)
}

fn render_task(task_json: &Value) -> Value {
    let document = CrdDocument::project(task_json);
    let Some(source) = task_json.as_object() else {
        return empty_object();
    };
    let mut out = empty_object();
    set(
        &mut out,
        "apiVersion",
        string_or_default(source.get("apiVersion"), "agent.wecode.io/v1"),
    );
    set(
        &mut out,
        "kind",
        string_or_default(source.get("kind"), "Task"),
    );
    if let Some(metadata) = document.metadata.as_ref() {
        set(
            &mut out,
            "metadata",
            render_metadata(metadata, source.get("metadata")),
        );
    }
    if let Some(spec) = document.spec.as_ref() {
        set(&mut out, "spec", render_spec(spec, source.get("spec")));
    }
    if let Some(status) = document.status.as_ref() {
        set(
            &mut out,
            "status",
            render_status(status, source.get("status")),
        );
    }
    out
}

fn render_metadata(metadata: &crate::crd::CrdMetadata, source: Option<&Value>) -> Value {
    let source = source.and_then(Value::as_object);
    let mut out = empty_object();
    set(
        &mut out,
        "name",
        source
            .and_then(|source| source.get("name"))
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    set(
        &mut out,
        "namespace",
        string_or_default(source.and_then(|source| source.get("namespace")), "default"),
    );
    if let Some(display_name) = metadata
        .display_name
        .as_ref()
        .filter(|value| !value.is_null())
    {
        set(&mut out, "displayName", display_name.to_value());
    }
    if let Some(labels) = source
        .and_then(|source| source.get("labels"))
        .filter(|value| !value.is_null())
    {
        set(&mut out, "labels", labels.clone());
    }
    out
}

fn render_spec(spec: &crate::crd::CrdSpec, source: Option<&Value>) -> Value {
    let source = source.and_then(Value::as_object);
    let mut out = empty_object();
    opaque(&mut out, "title", spec.title.as_ref());
    opaque(&mut out, "prompt", spec.prompt.as_ref());
    present(&mut out, "teamRef", source.and_then(|s| s.get("teamRef")));
    present(
        &mut out,
        "workspaceRef",
        source.and_then(|s| s.get("workspaceRef")),
    );
    set(
        &mut out,
        "is_group_chat",
        Value::Bool(spec.is_group_chat.unwrap_or(false)),
    );
    present(
        &mut out,
        "knowledgeBaseRefs",
        source.and_then(|s| s.get("knowledgeBaseRefs")),
    );
    present(
        &mut out,
        "knowledgeBaseScopes",
        source.and_then(|s| s.get("knowledgeBaseScopes")),
    );
    set(
        &mut out,
        "externalKnowledgeRefs",
        source
            .and_then(|s| s.get("externalKnowledgeRefs"))
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    if let Some(device_id) = spec.device_id.as_ref().filter(|value| !value.is_null()) {
        set(&mut out, "device_id", device_id.to_value());
    }
    present(
        &mut out,
        "execution",
        source.and_then(|s| s.get("execution")),
    );
    present(&mut out, "fork", source.and_then(|s| s.get("fork")));
    present(
        &mut out,
        "currentStage",
        source.and_then(|s| s.get("currentStage")),
    );
    out
}

fn render_status(status: &crate::crd::CrdStatus, source: Option<&Value>) -> Value {
    let source = source.and_then(Value::as_object);
    let mut out = empty_object();
    set(
        &mut out,
        "state",
        string_or_default(source.and_then(|s| s.get("state")), "Available"),
    );
    present(&mut out, "message", source.and_then(|s| s.get("message")));
    set(
        &mut out,
        "status",
        string_or_default(source.and_then(|s| s.get("status")), "PENDING"),
    );
    set(
        &mut out,
        "progress",
        source
            .and_then(|s| s.get("progress"))
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::from(0)),
    );
    opaque(&mut out, "result", status.result.as_ref());
    opaque(&mut out, "errorMessage", status.error_message.as_ref());
    for key in ["createdAt", "updatedAt", "completedAt"] {
        present(&mut out, key, source.and_then(|s| s.get(key)));
    }
    present(&mut out, "subTasks", source.and_then(|s| s.get("subTasks")));
    present(&mut out, "app", source.and_then(|s| s.get("app")));
    present(&mut out, "archive", source.and_then(|s| s.get("archive")));
    out
}

fn ensure_object<'a>(parent: &'a mut Value, key: &str) -> &'a mut Value {
    if !parent.get(key).is_some_and(Value::is_object) {
        set(parent, key, empty_object());
    }
    parent.get_mut(key).expect("object just written")
}

/// `out[key] = value` on a JSON object.
fn set(object: &mut Value, key: &str, value: Value) {
    if let Some(map) = object.as_object_mut() {
        map.insert(key.to_owned(), value);
    }
}

/// Insert an opaque field, dropping a present `null` (exclude_none semantics).
fn opaque(out: &mut Value, key: &str, value: Option<&OpaqueJson>) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        set(out, key, value.to_value());
    }
}

/// Insert a source field, dropping a present `null`.
fn present(out: &mut Value, key: &str, value: Option<&Value>) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        set(out, key, value.clone());
    }
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

fn string_or_default(value: Option<&Value>, default: &str) -> Value {
    match value {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(other) if !other.is_null() => other.clone(),
        _ => Value::String(default.to_owned()),
    }
}
