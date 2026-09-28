// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unit tests for `GET /api/v1/kinds/skills/unified`
//! (binding extraction, group-permission ranking, and response shaping).
use super::*;
use serde_json::{Value, json};
fn user_skill_item(kind: &KindRow, shared: bool, defaults: &HashSet<i32>) -> Value {
    crate::json_contract_tests::serialized(super::user_skill_item(kind, shared, defaults)).unwrap()
}
fn source_info(spec: &Value) -> Value {
    crate::json_contract_tests::serialized(super::source_info(
        &JsonProjection::<SkillDisplaySpec>::from_json(spec)
            .value
            .unwrap_or_default(),
    ))
    .unwrap()
}
fn extract_skill_id(value: &Value) -> Option<i32> {
    let input = JsonProjection::<SkillDisplayInput>::from(value.clone());
    super::extract_skill_id(input.value.as_ref())
}
fn is_user_default_binding(value: &Value, target_id: &str) -> bool {
    let input = JsonProjection::<SkillDisplayInput>::from(value.clone());
    super::is_user_default_binding(input.value.as_ref(), target_id)
}
fn is_group_binding(value: &Value, namespace: &str) -> bool {
    let input = JsonProjection::<SkillDisplayInput>::from(value.clone());
    super::is_group_binding(input.value.as_ref(), namespace)
}

fn kind_row(id: i32, user_id: i32, name: &str, namespace: &str, json: Value) -> KindRow {
    KindRow {
        kinds_id: id,
        kinds_user_id: user_id,
        kinds_kind: "Skill".to_string(),
        kinds_name: name.to_string(),
        kinds_namespace: namespace.to_string(),
        kinds_json: Some(Json(json.into())),
        kinds_is_active: 1,
        kinds_created_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
        kinds_updated_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
    }
}

#[test]
fn extracts_skill_ids_from_bindings() {
    let binding = json!({
        "spec": {"skillRef": {"skillId": 123, "targetType": "user", "targetId": "user:7"}}
    });
    assert_eq!(extract_skill_id(&binding), Some(123));
    let string_id = json!({"spec": {"skillRef": {"skill_id": "456"}}});
    assert_eq!(extract_skill_id(&string_id), Some(456));
    assert_eq!(extract_skill_id(&json!({})), None);
}

#[test]
fn detects_user_default_and_group_bindings() {
    let binding = json!({"spec": {"targetType": "user", "targetId": "user:7"}});
    assert!(is_user_default_binding(&binding, "user:7"));
    assert!(!is_user_default_binding(&binding, "user:8"));
    let group = json!({"spec": {"targetType": "group", "targetId": "Feed-Monitor"}});
    assert!(is_group_binding(&group, "Feed-Monitor"));
    assert!(!is_group_binding(&group, "other"));
}

#[test]
fn source_info_defaults_type_and_keeps_all_keys() {
    let spec = json!({
        "source": {
            "type": "git", "repo_url": "https://example.com/repo",
            "skill_path": "skills/demo", "imported_at": "2026-07-30T12:12:36Z"
        }
    });
    let source = source_info(&spec);
    assert_eq!(source.get("type"), Some(&json!("git")));
    assert_eq!(
        source.get("repo_url"),
        Some(&json!("https://example.com/repo"))
    );
    assert_eq!(source.get("skill_path"), Some(&json!("skills/demo")));
    assert_eq!(
        source.get("imported_at"),
        Some(&json!("2026-07-30T12:12:36Z"))
    );
    assert!(source.get("provider_key").is_none());
    assert!(source.get("skill_key").is_none());
    assert!(source.get("original_skill_key").is_none());
    assert!(source_info(&json!({})).is_null());
    assert!(source_info(&json!({"source": null})).is_null());
    assert!(source_info(&json!({"source": "text"})).is_null());
}

#[test]
fn source_type_defaults_to_upload() {
    let spec = json!({"source": {"repo_url": "https://example.com"}});
    assert_eq!(
        source_info(&spec).get("type").and_then(Value::as_str),
        Some("upload")
    );
}

#[test]
fn user_skill_item_uses_default_field_order() {
    let kind = kind_row(1, 7, "demo", "default", json!({"spec": {}}));
    let item = user_skill_item(&kind, false, &HashSet::new());
    let keys: Vec<&str> = item
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "id",
            "name",
            "namespace",
            "description",
            "displayName",
            "version",
            "author",
            "tags",
            "bindShells",
            "visible",
            "is_active",
            "is_public",
            "user_id",
            "is_group_shared",
            "publication_status",
            "availability",
            "source",
            "created_at",
            "updated_at"
        ]
    );
    assert_eq!(item.get("description"), Some(&json!("")));
    assert_eq!(item.get("visible"), Some(&json!(true)));
    assert_eq!(item.get("is_group_shared"), Some(&json!(false)));
}

#[test]
fn availability_reflects_default_bindings() {
    let kind = kind_row(9, 7, "demo", "default", json!({"spec": {}}));
    let defaults = HashSet::from([9]);
    let item = user_skill_item(&kind, true, &defaults);
    assert_eq!(item.get("is_group_shared"), Some(&json!(true)));
    assert_eq!(
        item.pointer("/availability/in_my_default"),
        Some(&json!(true))
    );
    assert_eq!(
        item.pointer("/availability/agent_builtin"),
        Some(&json!(false))
    );
}

#[test]
fn highest_role_prefers_most_privileged() {
    let roles = vec!["Reporter".to_string(), "Maintainer".to_string()];
    assert_eq!(highest_role(&roles).as_deref(), Some("Maintainer"));
    assert_eq!(highest_role(&[]), None);
    let unknown = vec!["Reporter".to_string(), "Ghost".to_string()];
    assert_eq!(highest_role(&unknown).as_deref(), Some("Reporter"));
}

#[test]
fn reporter_gate_admits_reporter_and_above() {
    for role in ["Owner", "Maintainer", "Developer", "Reporter"] {
        assert!(reporter_or_above(role));
    }
    assert!(!reporter_or_above("RestrictedAnalyst"));
}

#[test]
fn quotes_literals_with_mysql_rules() {
    assert_eq!(quote_literal("default"), "'default'");
    assert_eq!(quote_literal("a'b"), "'a\\'b'");
    assert_eq!(quote_literal("a\\b"), "'a\\\\b'");
}
