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
fn source_info_defaults_type_and_keeps_schema_keys() {
    let spec = json!({
        "source": {
            "type": "marketplace", "repo_url": "https://example.com/repo",
            "skill_path": "skills/demo", "provider_key": "provider",
            "skill_key": "a/b", "original_skill_key": "b",
            "imported_at": "2026-07-30T12:12:36Z"
        }
    });
    let source = source_info(&spec);
    assert_eq!(source.get("type"), Some(&json!("marketplace")));
    assert_eq!(
        source.get("repo_url"),
        Some(&json!("https://example.com/repo"))
    );
    assert_eq!(source.get("skill_path"), Some(&json!("skills/demo")));
    assert_eq!(
        source.get("imported_at"),
        Some(&json!("2026-07-30T12:12:36Z"))
    );
    // Marketplace-only keys are outside the response schema
    // (`SkillSourceResponse`), so they are not rendered.
    assert_eq!(source.get("provider_key"), None);
    assert_eq!(source.get("skill_key"), None);
    assert_eq!(source.get("original_skill_key"), None);
    // Missing optional keys echo as `null` rather than being dropped, matching
    // the source `source_data.get(...)` projection.
    let git = source_info(&json!({"source": {"type": "git"}}));
    assert_eq!(git.get("repo_url"), Some(&json!(null)));
    assert_eq!(git.get("skill_path"), Some(&json!(null)));
    assert_eq!(git.get("imported_at"), Some(&json!(null)));
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

#[tokio::test]
async fn catalog_keeps_same_named_personal_and_group_skills() {
    let personal = kind_row(11, 7, "same-name", "default", json!({"spec": {}}));
    let group = kind_row(12, 7, "same-name", "engineering", json!({"spec": {}}));
    let shared = HashSet::from([12]);
    let empty = HashSet::new();
    let items = catalog::assemble(
        vec![personal, group],
        catalog::CatalogSelection {
            bound_ids: &empty,
            shared_ids: &shared,
            default_ids: &empty,
            skip: 0,
            limit: 100,
        },
        |sql| async move {
            assert!(sql.contains("kinds.user_id = 0"));
            // Public names remain shadowed, without collapsing namespaces.
            Ok(vec![kind_row(
                90,
                0,
                "same-name",
                "default",
                json!({"spec": {}}),
            )])
        },
    )
    .await
    .unwrap();
    let items = crate::json_contract_tests::serialized(items).unwrap();
    assert_eq!(items.as_array().unwrap().len(), 2);
    assert_eq!(items[0]["id"], json!(11));
    assert_eq!(items[1]["id"], json!(12));
    assert_eq!(items[0]["namespace"], json!("default"));
    assert_eq!(items[1]["namespace"], json!("engineering"));
    assert_eq!(items[0]["is_group_shared"], json!(false));
    assert_eq!(items[1]["is_group_shared"], json!(true));
}

#[tokio::test]
async fn catalog_supplements_bound_only_skills_once_and_removes_unlinked_skills() {
    for installed in [true, false] {
        let bound = if installed {
            HashSet::from([11, 21])
        } else {
            HashSet::from([11])
        };
        let shared = if installed {
            HashSet::from([21])
        } else {
            HashSet::new()
        };
        let defaults = HashSet::from([11]);
        let mut queries = Vec::new();
        let items = catalog::assemble(
            vec![kind_row(11, 7, "personal", "default", json!({"spec": {}}))],
            catalog::CatalogSelection {
                bound_ids: &bound,
                shared_ids: &shared,
                default_ids: &defaults,
                skip: 0,
                limit: 100,
            },
            |sql| {
                queries.push(sql.clone());
                std::future::ready(Ok(if sql.contains("kinds.id IN") {
                    assert!(installed);
                    assert!(sql.contains("kinds.id IN (21)"));
                    // Duplicate bindings must not duplicate the catalog entry.
                    (0..2)
                        .map(|_| kind_row(21, 8, "installed", "other-team", json!({"spec": {}})))
                        .collect()
                } else {
                    assert!(sql.contains("kinds.user_id = 0"));
                    vec![kind_row(91, 0, "public", "default", json!({"spec": {}}))]
                }))
            },
        )
        .await
        .unwrap();
        let items = crate::json_contract_tests::serialized(items).unwrap();
        let ids: Vec<_> = items
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_i64().unwrap())
            .collect();
        assert_eq!(
            ids,
            if installed {
                vec![11, 21, 91]
            } else {
                vec![11, 91]
            }
        );
        assert_eq!(queries.len(), if installed { 2 } else { 1 });
        assert_eq!(items[0]["is_group_shared"], json!(false));
        assert_eq!(items[0]["availability"]["in_my_default"], json!(true));
        if installed {
            assert_eq!(items[1]["namespace"], json!("other-team"));
            assert_eq!(items[1]["is_group_shared"], json!(true));
            assert_eq!(items[1]["availability"]["in_my_default"], json!(false));
        }
        assert_eq!(
            items.as_array().unwrap().last().unwrap()["is_public"],
            json!(true)
        );
    }
}

#[test]
fn hidden_and_published_skill_metadata_survives_catalog_rendering() {
    let kind = kind_row(
        11,
        7,
        "published",
        "default",
        json!({"spec": {
            "visible": false, "displayName": "Hidden public skill",
            "capability": {"publishStatus": "published"}
        }}),
    );
    let item = user_skill_item(&kind, true, &HashSet::new());
    assert_eq!(item["visible"], json!(false));
    assert_eq!(item["displayName"], json!("Hidden public skill"));
    assert_eq!(item["publication_status"], json!("published"));
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

fn pagination(query: Value) -> Result<(usize, usize), FastApiError> {
    serde_json::from_value::<UnifiedParams>(query)
        .unwrap()
        .validated()
}

#[test]
fn pagination_defaults_match_the_source_query_bounds() {
    assert_eq!(pagination(json!({})).unwrap(), (0, 100));
    assert_eq!(
        pagination(json!({"skip": "5", "limit": "100"})).unwrap(),
        (5, 100)
    );
    assert_eq!(
        pagination(json!({"skip": "0", "limit": "1"})).unwrap(),
        (0, 1)
    );
}

#[test]
fn pagination_rejects_values_outside_the_source_bounds() {
    let cases = [
        (
            json!({"skip": "abc"}),
            "skip",
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
        ),
        (
            json!({"skip": "-1"}),
            "skip",
            "greater_than_equal",
            "Input should be greater than or equal to 0",
        ),
        (
            json!({"limit": "0"}),
            "limit",
            "greater_than_equal",
            "Input should be greater than or equal to 1",
        ),
        (
            json!({"limit": "101"}),
            "limit",
            "less_than_equal",
            "Input should be less than or equal to 100",
        ),
    ];
    for (query, field, kind, message) in cases {
        let error = pagination(query.clone()).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(detail[0]["type"], json!(kind), "{query}");
        assert_eq!(detail[0]["loc"], json!(["query", field]), "{query}");
        assert_eq!(detail[0]["msg"], json!(message), "{query}");
    }
}

#[test]
fn numeric_versions_render_as_strings() {
    let kind = kind_row(1, 7, "demo", "default", json!({"spec": {"version": 1.0}}));
    let item = user_skill_item(&kind, false, &HashSet::new());
    assert_eq!(item.get("version"), Some(&json!("1.0")));
    let kind = kind_row(2, 7, "demo", "default", json!({"spec": {"version": 2}}));
    let item = user_skill_item(&kind, false, &HashSet::new());
    assert_eq!(item.get("version"), Some(&json!("2")));
    let kind = kind_row(
        3,
        7,
        "demo",
        "default",
        json!({"spec": {"version": "1.0.1"}}),
    );
    let item = user_skill_item(&kind, false, &HashSet::new());
    assert_eq!(item.get("version"), Some(&json!("1.0.1")));
    let kind = kind_row(4, 7, "demo", "default", json!({"spec": {}}));
    let item = user_skill_item(&kind, false, &HashSet::new());
    assert_eq!(item.get("version"), Some(&json!(null)));
}
