// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the `GET /api/knowledge-bases` migration: the rendered
//! SQL against the recorded `example-group`/organization exchanges, the response
//! projection, and the FastAPI query validation.
use std::collections::HashMap;

use super::query::{PermissionContext, Scope, Visibility, build_list_sql, direct_access_predicate};
use super::response::{KbDocument, build_response};
use super::*;
use chrono::NaiveDate;

/// Collapse template line breaks so an expected literal is the recorded SQL.
fn rendered(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The `example-group` case's `build_direct_access_query_context` inputs.
fn group_context() -> PermissionContext {
    let group = |name: &str| name.to_string();
    let mut group_roles = HashMap::new();
    for (name, role) in [
        ("example-group", "Maintainer"),
        ("example-report", "Reporter"),
        ("example-dev", "Maintainer"),
        ("example-dev/core", "Developer"),
        ("example-dev/prod", "Developer"),
        ("example-org/platform", "Developer"),
        ("example-exp", "Developer"),
    ] {
        group_roles.insert(group(name), group(role));
    }
    PermissionContext {
        user_id: 157,
        user_role: "admin".to_string(),
        accessible_groups: [
            "example-group",
            "example-report",
            "example-dev",
            "example-dev/core",
            "example-dev/prod",
            "example-org/platform",
            "example-exp",
        ]
        .iter()
        .map(|name| group(name))
        .collect(),
        organization_names: vec![group("example-org-a"), group("example-org-b")],
        group_role_order: [
            "example-group",
            "example-report",
            "example-dev",
            "example-dev/core",
            "example-dev/prod",
            "example-org/platform",
            "example-exp",
        ]
        .iter()
        .map(|name| group(name))
        .collect(),
        group_roles,
        // Row order of the `_get_accessible_namespace_ids` query (seq 1094).
        accessible_ns_ids: vec![21, 261, 27, 217, 320, 241, 110],
        external_editable_ids: Vec::new(),
        external_kb_ids: Vec::new(),
    }
}

const GROUP_FILTERS: &str = "kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true AND kinds.namespace = 'example-group'";

/// The recorded `1101`/`1102` predicate body (the `example-group` group scope).
const RECORDED_PREDICATE: &str = "(coalesce(json_unquote(json_extract(kinds.json, '$.spec.directAccessRequirement')), '') = '' OR coalesce(json_unquote(json_extract(kinds.json, '$.spec.directAccessRequirement')), '') = 'read' OR coalesce(json_unquote(json_extract(kinds.json, '$.spec.directAccessRequirement')), '') = 'edit' AND (kinds.user_id = 157 OR (EXISTS (SELECT 1 \nFROM resource_members \nWHERE resource_members.resource_type IN ('KnowledgeBase', 'KNOWLEDGE_BASE') AND resource_members.resource_id = kinds.id AND resource_members.status IN ('approved', 'APPROVED') AND resource_members.entity_type = 'user' AND resource_members.entity_id = '157' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer'))) OR (EXISTS (SELECT 1 \nFROM resource_members \nWHERE resource_members.resource_type IN ('KnowledgeBase', 'KNOWLEDGE_BASE') AND resource_members.resource_id = kinds.id AND resource_members.status IN ('approved', 'APPROVED') AND resource_members.entity_type = 'namespace' AND resource_members.entity_id IN ('320', '27', '241', '217', '21', '110', '261') AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer'))) OR kinds.namespace IN ('example-group', 'example-dev', 'example-dev/core', 'example-dev/prod', 'example-org/platform', 'example-exp') OR kinds.namespace IN ('example-org-a', 'example-org-b'))) AND NOT (EXISTS (SELECT 1 \nFROM resource_members \nWHERE resource_members.resource_type IN ('KnowledgeBase', 'KNOWLEDGE_BASE') AND resource_members.resource_id = kinds.id AND resource_members.status IN ('approved', 'APPROVED') AND resource_members.entity_type = 'user' AND resource_members.entity_id = '157' AND resource_members.`role` = 'RestrictedAnalyst'))";

#[test]
fn group_predicate_matches_the_recorded_statements() {
    let predicate = direct_access_predicate(&group_context());
    assert_eq!(rendered(&predicate), rendered(RECORDED_PREDICATE));
}

#[test]
fn group_count_and_select_match_the_recorded_statements() {
    let ctx = group_context();
    let visibility = Visibility {
        join: "",
        filters: GROUP_FILTERS.to_string(),
    };
    let sql = build_list_sql(
        Scope::Group,
        &visibility,
        &direct_access_predicate(&ctx),
        &ctx,
        50,
        0,
    );
    assert_eq!(
        rendered(&sql.count),
        rendered(&format!(
            "SELECT count(*) AS count_1 \nFROM (SELECT kinds.id AS kinds_id, \
             kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, \
             kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
             kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
             kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \n\
             FROM kinds \nWHERE kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true \
             AND kinds.namespace = 'example-group' AND {RECORDED_PREDICATE}) AS anon_1"
        ))
    );
    assert_eq!(
        rendered(&sql.select),
        rendered(&format!(
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \n\
             FROM kinds \nWHERE kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true \
             AND kinds.namespace = 'example-group' AND {RECORDED_PREDICATE} \
             ORDER BY kinds.updated_at DESC, kinds.id DESC \n LIMIT 0, 50"
        ))
    );
    assert!(!sql.count.contains("ORDER BY"));
    assert!(!sql.count.contains("LIMIT"));
}

#[test]
fn organization_scope_joins_namespace_before_the_predicate() {
    let ctx = group_context();
    let visibility = Visibility {
        join: " INNER JOIN namespace ON kinds.namespace = namespace.name",
        filters: "kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true \
                  AND namespace.level = 'organization' AND namespace.is_active IS true"
            .to_string(),
    };
    let sql = build_list_sql(
        Scope::Organization,
        &visibility,
        &direct_access_predicate(&ctx),
        &ctx,
        50,
        0,
    );
    assert!(
        rendered(&sql.select).contains(
            "FROM kinds INNER JOIN namespace ON kinds.namespace = namespace.name \
             WHERE kinds.kind = 'KnowledgeBase'"
        ),
        "{}",
        sql.select
    );
}

#[test]
fn restarts_of_the_filter_render_restricted_groups_only_when_present() {
    // `apply_acl_deny_filter` adds the `NOT IN` clause only for a group whose
    // effective role is `RestrictedAnalyst`.
    let mut ctx = group_context();
    ctx.group_roles
        .insert("example-org-b".to_string(), "RestrictedAnalyst".to_string());
    assert!(!direct_access_predicate(&ctx).contains("NOT IN"));

    ctx.group_role_order.push("restricted".to_string());
    ctx.group_roles
        .insert("restricted".to_string(), "RestrictedAnalyst".to_string());
    assert!(direct_access_predicate(&ctx).contains("AND (kinds.namespace NOT IN ('restricted'))"));
}

#[test]
fn scope_parsing_matches_resource_scope() {
    assert_eq!(Scope::parse("personal"), Some(Scope::Personal));
    assert_eq!(Scope::parse("group"), Some(Scope::Group));
    assert_eq!(Scope::parse("organization"), Some(Scope::Organization));
    assert_eq!(Scope::parse("all"), Some(Scope::All));
    assert_eq!(Scope::parse("team"), None);
}

#[test]
fn response_projection_matches_the_recorded_item() {
    // The recorded `example-group` item spec.
    let spec = r#"{"kind": "KnowledgeBase", "spec": {"name": "test", "kbType": "classic", "description": "", "document_count": 1, "summaryEnabled": false, "retrievalConfig": {"top_k": 5, "hybrid_weights": {"vector_weight": 0.7, "keyword_weight": 0.3}, "retrieval_mode": "vector", "retriever_name": "elasticsearch", "score_threshold": 0.5, "embedding_config": {"model_name": "Qwen3-Embedding-0.6B-v2", "model_namespace": "default"}, "retriever_namespace": "default"}, "summaryModelRef": null, "exemptCallsBeforeCheck": 5, "maxCallsPerConversation": 10, "directAccessRequirement": "read", "multimodalAnalysisEnabled": false}}"#;
    let document: KbDocument = serde_json::from_str(spec).unwrap();
    let created = NaiveDate::from_ymd_opt(2026, 3, 4)
        .unwrap()
        .and_hms_opt(20, 28, 10)
        .unwrap();
    let updated = NaiveDate::from_ymd_opt(2026, 4, 3)
        .unwrap()
        .and_hms_opt(15, 57, 47)
        .unwrap();
    let response = build_response(
        141640,
        5,
        "example-group",
        true,
        created,
        updated,
        &document.spec,
    );
    let body = serde_json::to_value(&response).unwrap();
    assert_eq!(body["id"], 141640);
    assert_eq!(body["name"], "test");
    assert_eq!(body["description"], serde_json::Value::Null);
    assert_eq!(body["namespace"], "example-group");
    assert_eq!(body["direct_access_requirement"], "read");
    assert_eq!(body["allow_document_download"], serde_json::Value::Null);
    assert_eq!(body["source"], serde_json::Value::Null);
    assert_eq!(body["language"], serde_json::Value::Null);
    assert_eq!(body["show_generation_task"], false);
    assert_eq!(body["generation_strategy"], serde_json::Value::Null);
    assert_eq!(body["kb_type"], "classic");
    assert_eq!(body["document_count"], 1);
    assert_eq!(body["is_active"], true);
    // The list's response model carries `dingtalk_auto_sync_enabled`.
    assert_eq!(body["dingtalk_auto_sync_enabled"], false);
    assert_eq!(body["summary_enabled"], false);
    assert_eq!(body["summary_model_ref"], serde_json::Value::Null);
    assert_eq!(body["max_calls_per_conversation"], 10);
    assert_eq!(body["exempt_calls_before_check"], 5);
    assert_eq!(body["created_at"], "2026-03-04T20:28:10");
    assert_eq!(body["updated_at"], "2026-04-03T15:57:47");
    assert_eq!(body["retrieval_config"]["retriever_name"], "elasticsearch");
    assert_eq!(body["retrieval_config"]["top_k"], 5);
    assert_eq!(
        body["retrieval_config"]["embedding_config"]["model_name"],
        "Qwen3-Embedding-0.6B-v2"
    );
    assert_eq!(body["retrieval_capabilities"]["retrieval_mode"], "vector");
    assert_eq!(body["retrieval_capabilities"]["semantic_query"], false);
}

#[test]
fn document_count_defaults_to_the_spec_value() {
    let document: KbDocument = serde_json::from_str(r#"{"spec":{"name":"n"}}"#).unwrap();
    let response = build_response(
        1,
        1,
        "default",
        true,
        Default::default(),
        Default::default(),
        &document.spec,
    );
    assert_eq!(response_document_count(&response), 0);
    let with_count: KbDocument =
        serde_json::from_str(r#"{"spec":{"name":"n","document_count":7}}"#).unwrap();
    let response = build_response(
        1,
        1,
        "default",
        true,
        Default::default(),
        Default::default(),
        &with_count.spec,
    );
    assert_eq!(response_document_count(&response), 7);
}

/// Read `document_count` back through serialization (the field is private).
fn response_document_count(response: &KnowledgeBaseResponse) -> i64 {
    serde_json::to_value(response).unwrap()["document_count"]
        .as_i64()
        .unwrap()
}

#[test]
fn limit_and_offset_validation_matches_fastapi_bounds() {
    assert_eq!(validated_limit(None).unwrap(), 50);
    assert_eq!(validated_limit(Some("1")).unwrap(), 1);
    assert_eq!(validated_limit(Some("500")).unwrap(), 500);
    assert!(validated_limit(Some("0")).is_err());
    assert!(validated_limit(Some("501")).is_err());
    assert!(validated_limit(Some("x")).is_err());
    assert_eq!(validated_offset(None).unwrap(), 0);
    assert_eq!(validated_offset(Some("10")).unwrap(), 10);
    assert!(validated_offset(Some("-1")).is_err());
}

#[test]
fn invalid_scope_and_missing_group_name_are_400() {
    assert!(validated_scope(Some("team")).is_err());
    assert_eq!(validated_scope(None).unwrap(), Scope::All);
}
