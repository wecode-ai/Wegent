// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `RuntimeFeatures` wire contract (`app/schemas/device.py`).
//!
//! `DeviceRegisterPayload` and `DeviceHeartbeatPayload` validate the reported
//! feature document through `RuntimeFeatures` before it reaches the
//! `device:online` document. Every nested feature model declares
//! `extra="ignore"`, and the container's `normalize_extensions` before-validator
//! keeps only declared members, so a client field the contract does not declare
//! never appears in the stored document. `model_dump(by_alias=True,
//! exclude_none=True)` then serializes the declared members with their aliases,
//! their defaults, and no `None` values.
//!
//! Top-level members this module does not declare are preserved verbatim. The
//! source keeps them for distribution-registered feature normalizers
//! (`register_runtime_feature_normalizer`, used by the internal `desktop`
//! capability); that registry is not part of this crate, so passing the member
//! through keeps those advertisements intact.

use serde_json::{Map, Value};

/// Normalize one reported feature document, or `None` when the payload carried
/// no document.
///
/// A document whose declared members fail validation falls back to the source's
/// reduced model: the surviving project-editing denials plus the recovered
/// schema version.
pub(crate) fn normalize(value: &Value) -> Option<Value> {
    if value.is_null() {
        return None;
    }
    let object = value.as_object()?;
    match parse(object) {
        Some(document) => Some(Value::Object(document)),
        None => fallback(object),
    }
}

/// The validated `RuntimeFeatures.model_dump(by_alias=True, exclude_none=True)`.
fn parse(object: &Map<String, Value>) -> Option<Map<String, Value>> {
    let schema_version = field(object, "schemaVersion", "schema_version")?.as_i64()?;
    if schema_version < 1 {
        return None;
    }
    let mut document = Map::new();
    document.insert("schemaVersion".to_owned(), Value::from(schema_version));
    if let Some(value) = present(object, "runtimeTaskCreate", "runtime_task_create") {
        document.insert(
            "runtimeTaskCreate".to_owned(),
            Value::Object(task_create(value)?),
        );
    }
    if let Some(value) = present(object, "interactiveSessions", "interactive_sessions") {
        document.insert(
            "interactiveSessions".to_owned(),
            Value::Object(interactive_sessions(value)?),
        );
    }
    if let Some(value) = present(object, "worktrees", "worktrees") {
        document.insert("worktrees".to_owned(), Value::Object(worktrees(value)?));
    }
    // `normalize_project_editing` turns any non-object into an empty model, so
    // an explicit `null` still serializes as `{}`.
    if let Some(value) = field(object, "projectEditing", "project_editing") {
        document.insert(
            "projectEditing".to_owned(),
            Value::Object(project_editing(value)),
        );
    }
    // `normalize_plugin_sync` drops a malformed advertisement instead of
    // erasing unrelated capabilities.
    if let Some(value) = present(object, "pluginSync", "plugin_sync")
        && let Some(sync) = plugin_sync(value)
    {
        document.insert("pluginSync".to_owned(), Value::Object(sync));
    }
    // Members outside the declared contract belong to a distribution extension
    // normalizer, so their reported document is kept as it arrived.
    for (key, value) in object {
        if !DECLARED.contains(&key.as_str()) {
            document.insert(key.clone(), value.clone());
        }
    }
    Some(document)
}

/// Top-level members of `RuntimeFeatures`, by alias and by field name.
const DECLARED: [&str; 11] = [
    "schemaVersion",
    "schema_version",
    "runtimeTaskCreate",
    "runtime_task_create",
    "interactiveSessions",
    "interactive_sessions",
    "worktrees",
    "projectEditing",
    "project_editing",
    "pluginSync",
    "plugin_sync",
];

/// `_normalize_runtime_features`' recovery branch after a validation error.
fn fallback(object: &Map<String, Value>) -> Option<Value> {
    let editing_key = ["projectEditing", "project_editing"]
        .into_iter()
        .find(|key| object.contains_key(*key))?;
    let denied = object
        .get(editing_key)
        .and_then(Value::as_object)
        .map(|editing| {
            editing
                .iter()
                .filter(|(_, flag)| **flag == Value::Bool(false))
                .map(|(key, flag)| (key.clone(), flag.clone()))
                .collect::<Map<String, Value>>()
        })
        .unwrap_or_default();
    let schema_version = field(object, "schemaVersion", "schema_version")
        .and_then(Value::as_i64)
        .filter(|version| *version >= 1)
        .unwrap_or(1);
    let mut document = Map::new();
    document.insert("schemaVersion".to_owned(), Value::from(schema_version));
    document.insert(
        "projectEditing".to_owned(),
        Value::Object(project_editing(&Value::Object(denied))),
    );
    Some(Value::Object(document))
}

/// `RuntimeTaskCreateFeatures`.
fn task_create(value: &Value) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    let versions = match field(object, "schemaVersions", "schema_versions") {
        None => Vec::new(),
        Some(value) => value
            .as_array()?
            .iter()
            .map(|item| item.as_i64().map(Value::from))
            .collect::<Option<Vec<_>>>()?,
    };
    let features = match field(object, "features", "features") {
        None => Map::new(),
        Some(value) => value.as_object()?.clone(),
    };
    let mut document = Map::new();
    document.insert("schemaVersions".to_owned(), Value::Array(versions));
    document.insert("features".to_owned(), Value::Object(features));
    Some(document)
}

/// `RuntimeInteractiveSessionFeatures`: both flags always render.
fn interactive_sessions(value: &Value) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    let mut document = Map::new();
    document.insert(
        "codeServer".to_owned(),
        Value::Bool(flag(object, "codeServer", "code_server", true)?),
    );
    document.insert(
        "terminal".to_owned(),
        Value::Bool(flag(object, "terminal", "terminal", true)?),
    );
    Some(document)
}

/// `RuntimeWorktreeFeatures`: undeclared members such as a client `reconcile`
/// flag are dropped by `extra="ignore"`.
fn worktrees(value: &Value) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    let version = field(object, "version", "version")?.as_i64()?;
    if version < 1 {
        return None;
    }
    let mut document = Map::new();
    document.insert("version".to_owned(), Value::from(version));
    for (alias, name) in [
        ("managed", "managed"),
        ("deferredPrepare", "deferred_prepare"),
        ("snapshots", "snapshots"),
        ("restore", "restore"),
        ("preflight", "preflight"),
        ("persistentStorageVerified", "persistent_storage_verified"),
    ] {
        document.insert(
            alias.to_owned(),
            Value::Bool(flag(object, alias, name, false)?),
        );
    }
    Some(document)
}

/// `RuntimeProjectEditingFeatures`: `normalize_flag` keeps only real booleans.
fn project_editing(value: &Value) -> Map<String, Value> {
    let mut document = Map::new();
    let Some(object) = value.as_object() else {
        return document;
    };
    for (alias, name) in [
        ("multiRoots", "multi_roots"),
        ("aiSettings", "ai_settings"),
        ("defaultProjectSpace", "default_project_space"),
        ("plugins", "plugins"),
    ] {
        if let Some(Value::Bool(flag)) = field(object, alias, name) {
            document.insert(alias.to_owned(), Value::Bool(*flag));
        }
    }
    document
}

/// `RuntimePluginSyncFeatures`: a malformed advertisement is dropped.
fn plugin_sync(value: &Value) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    let version = field(object, "protocolVersion", "protocol_version")?.as_i64()?;
    if version < 1 {
        return None;
    }
    let mut document = Map::new();
    document.insert("protocolVersion".to_owned(), Value::from(version));
    Some(document)
}

/// Read a member by its alias or its field name (`populate_by_name=True`).
fn field<'a>(object: &'a Map<String, Value>, alias: &str, name: &str) -> Option<&'a Value> {
    object.get(alias).or_else(|| object.get(name))
}

/// A declared optional model: absent and `null` both mean "not reported".
fn present<'a>(object: &'a Map<String, Value>, alias: &str, name: &str) -> Option<&'a Value> {
    field(object, alias, name).filter(|value| !value.is_null())
}

/// A declared boolean with a default; `null` is a validation error.
fn flag(object: &Map<String, Value>, alias: &str, name: &str, default: bool) -> Option<bool> {
    match field(object, alias, name) {
        None => Some(default),
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn undeclared_worktree_members_are_dropped() {
        let reported = json!({
            "schemaVersion": 4,
            "worktrees": {
                "version": 1,
                "managed": true,
                "deferredPrepare": true,
                "snapshots": true,
                "restore": true,
                "preflight": true,
                "persistentStorageVerified": true,
                "reconcile": true
            }
        });
        let normalized = normalize(&reported).expect("features");
        let worktrees = normalized["worktrees"].as_object().expect("worktrees");
        assert!(!worktrees.contains_key("reconcile"));
        assert_eq!(normalized["worktrees"]["persistentStorageVerified"], true);
    }

    #[test]
    fn declared_flags_render_their_defaults_and_aliases() {
        let normalized = normalize(&json!({
            "schema_version": 2,
            "worktrees": {"version": 3},
            "interactive_sessions": {}
        }))
        .expect("features");
        assert_eq!(normalized["schemaVersion"], 2);
        assert_eq!(normalized["worktrees"]["version"], 3);
        assert_eq!(normalized["worktrees"]["managed"], false);
        assert_eq!(normalized["worktrees"]["persistentStorageVerified"], false);
        assert_eq!(normalized["interactiveSessions"]["codeServer"], true);
        assert_eq!(normalized["interactiveSessions"]["terminal"], true);
        assert!(normalized.get("projectEditing").is_none());
        assert!(normalized.get("pluginSync").is_none());
    }

    #[test]
    fn project_editing_keeps_only_boolean_flags() {
        let normalized = normalize(&json!({
            "schemaVersion": 1,
            "projectEditing": {"multiRoots": false, "plugins": "yes"}
        }))
        .expect("features");
        let editing = normalized["projectEditing"].as_object().expect("editing");
        assert_eq!(editing.len(), 1);
        assert_eq!(editing["multiRoots"], false);
        assert!(
            normalize(&json!({"schemaVersion": 1, "projectEditing": null}))
                .expect("features")
                .get("projectEditing")
                .is_some()
        );
    }

    #[test]
    fn undeclared_top_level_members_survive_for_registered_extensions() {
        let normalized = normalize(&json!({
            "schemaVersion": 1,
            "desktop": {"version": 1}
        }))
        .expect("features");
        assert_eq!(normalized["desktop"]["version"], 1);
    }

    #[test]
    fn a_malformed_document_keeps_only_recovered_denials() {
        // `schemaVersion` is missing, so the full model fails to validate.
        let normalized = normalize(&json!({
            "projectEditing": {"multiRoots": false, "aiSettings": true}
        }))
        .expect("recovered features");
        assert_eq!(normalized["schemaVersion"], 1);
        assert_eq!(normalized["projectEditing"]["multiRoots"], false);
        assert!(normalized["projectEditing"].get("aiSettings").is_none());
        assert!(normalize(&json!({"worktrees": {"version": 0}})).is_none());
        assert!(normalize(&Value::Null).is_none());
    }
}
