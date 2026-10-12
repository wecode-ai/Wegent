// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Statement contract of the batched model reads.
//!
//! The recorded source sends these statements in the text protocol while the
//! target sends prepared statements, so Replay compares the target's SQL after
//! binding its parameters against the recorded text. These tests pin the
//! rendered statements to the recorded source text.

use super::*;

fn target(entity_type: &str, entity_id: &str, namespace: &str) -> (String, String, String) {
    (
        entity_type.to_string(),
        entity_id.to_string(),
        namespace.to_string(),
    )
}

/// Compare SQL shapes while ignoring formatting, like the statement matcher.
fn normalized(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Substitute string parameters at their `?` positions.
fn materialized(sql: &str, arguments: &[String]) -> String {
    let mut parts = sql.split('?');
    let mut out = parts.next().unwrap_or_default().to_string();
    for (argument, part) in arguments.iter().zip(parts) {
        out.push('\'');
        out.push_str(argument);
        out.push('\'');
        out.push_str(part);
    }
    out
}

#[test]
fn referenced_capabilities_statement_matches_the_recorded_source() {
    // Case b6f65cd8 of recording 20260924102622: the recorded source statement
    // renders the `user` branch with entity id '358' before the `namespace`
    // branch with entity ids '452', '464', '92'.
    let targets = [
        target("user", "358", "default"),
        target("namespace", "452", "group-a"),
        target("namespace", "464", "group-b"),
        target("namespace", "92", "group-c"),
    ];
    let (sql, arguments) = referenced_capabilities_statement(REFERENCE_MODEL_KIND, &targets);
    // The bound arguments follow the recorded branch order.
    assert_eq!(arguments, vec!["358", "452", "464", "92"]);
    assert_eq!(
        normalized(&materialized(&sql, &arguments)),
        normalized(
            "SELECT resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, kinds.id AS kinds_id, \
             kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \
             FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \
             WHERE resource_members.resource_type = 'Model' \
             AND resource_members.status = 'approved' \
             AND (resource_members.entity_type = 'user' \
             AND resource_members.entity_id IN ('358') \
             OR resource_members.entity_type = 'namespace' \
             AND resource_members.entity_id IN ('452', '464', '92')) \
             AND kinds.kind = 'Model' AND kinds.user_id != 0 AND kinds.is_active IS true \
             ORDER BY kinds.id"
        )
    );
}

#[test]
fn referenced_capabilities_statement_omits_parentheses_for_one_branch() {
    // `or_(*filters)` renders a lone branch without parentheses.
    let targets = [target("user", "3942", "default")];
    let (sql, arguments) = referenced_capabilities_statement(REFERENCE_MODEL_KIND, &targets);
    assert_eq!(arguments, vec!["3942"]);
    assert_eq!(
        normalized(&materialized(&sql, &arguments)),
        normalized(
            "SELECT resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, kinds.id AS kinds_id, \
             kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \
             FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \
             WHERE resource_members.resource_type = 'Model' \
             AND resource_members.status = 'approved' \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id IN ('3942') \
             AND kinds.kind = 'Model' AND kinds.user_id != 0 AND kinds.is_active IS true \
             ORDER BY kinds.id"
        )
    );
}

#[test]
fn referenced_capabilities_statement_keeps_one_branch_per_entity_type() {
    // The source iterates the target-type set once, so every group target
    // collapses into a single `IN` list in target order.
    let targets = [
        target("user", "358", "default"),
        target("namespace", "452", "group-a"),
        target("namespace", "464", "group-b"),
        target("namespace", "92", "group-c"),
    ];
    let (sql, arguments) = referenced_capabilities_statement(REFERENCE_MODEL_KIND, &targets);
    assert_eq!(arguments, vec!["358", "452", "464", "92"]);
    assert_eq!(
        sql.matches("resource_members.entity_type = 'user'").count(),
        1
    );
    assert_eq!(
        sql.matches("resource_members.entity_type = 'namespace'")
            .count(),
        1
    );
    assert!(sql.contains("resource_members.entity_id IN (?, ?, ?)"));
    assert!(
        sql.find("resource_members.entity_type = 'user'")
            < sql.find("resource_members.entity_type = 'namespace'")
    );
}

#[test]
fn placeholders_match_the_requested_list_length() {
    assert_eq!(placeholders(1), "?");
    assert_eq!(placeholders(3), "?, ?, ?");
}

/// `PublicModelService.get_models` filters rows through the `allowedUsers`
/// whitelist: a model with `allowedUsersEnabled` admits only the listed user
/// names, and every other model stays visible.
#[test]
fn public_model_whitelist_admits_only_listed_users() {
    use crate::json_compat::OpaqueJson;
    use crate::teams::public_model_access::allowed_for_user_name;
    use serde_json::json;

    let whitelisted = OpaqueJson::from(json!({
        "spec": {"allowedUsersEnabled": true, "allowedUsers": [" yansheng3 "]}
    }));
    let open = OpaqueJson::from(json!({"spec": {"modelType": "llm"}}));
    let enabled_without_users = OpaqueJson::from(json!({
        "spec": {"allowedUsersEnabled": true}
    }));

    assert!(allowed_for_user_name(&whitelisted, Some("yansheng3")));
    // The list entries are stripped before comparison.
    assert!(!allowed_for_user_name(&whitelisted, Some("yansheng3 ")));
    assert!(!allowed_for_user_name(&whitelisted, Some("zhuchen3")));
    assert!(!allowed_for_user_name(&whitelisted, None));
    assert!(allowed_for_user_name(&open, Some("zhuchen3")));
    // An enabled whitelist without entries denies everyone.
    assert!(!allowed_for_user_name(
        &enabled_without_users,
        Some("zhuchen3")
    ));
}
