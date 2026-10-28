#![cfg(test)]
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Recorded-statement and route tests for the create resolution reads.
//!
//! Extracted from `resolution.rs` to keep that product module within the
//! repository's file-size bound; the tests exercise the parent module's
//! pools, statements and cached-reader fakes.

use super::*;
use brz_mysql::MysqlResult;
use std::sync::Mutex;

/// Records the statement each handle read issues.
#[derive(Default)]
struct RecordedRequestSql {
    calls: Mutex<Vec<(RouteKey, String, Vec<StatementArg>)>>,
}

impl RecordedRequestSql {
    fn calls(&self) -> Vec<(RouteKey, String, Vec<StatementArg>)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl RequestSql for RecordedRequestSql {
    async fn execute_statement(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> MysqlResult<brz_mysql::MysqlExecution> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments));
        Ok(brz_mysql::MysqlExecution {
            rows_affected: 1,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional_row(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> MysqlResult<Option<brz_mysql::MysqlRow>> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments));
        Ok(None)
    }

    async fn fetch_all_rows(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> MysqlResult<Vec<brz_mysql::MysqlRow>> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments));
        Ok(Vec::new())
    }
}

/// The handle variant issues the same statement text and the same
/// parameter order as the pooled `M: Mysql` function: both use
/// [`model_by_name_namespace_statement`] and bind
/// `(name, namespace, user_id)`.
#[tokio::test]
async fn model_handle_read_matches_the_pooled_statement_and_parameters() {
    let mut sql = RecordedRequestSql::default();
    let model = model_by_name_namespace_on(&mut sql, 6539, "ali-qwen3.7-flash", "default")
        .await
        .expect("read");
    assert!(model.is_none());
    let calls = sql.calls();
    // The direct read misses (the fake returns no row), so the referenced
    // Model fallback runs exactly as in the pooled function.
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0].0, RouteKey::None);
    assert_eq!(
        calls[0].1,
        model_by_name_namespace_statement("default"),
        "the handle variant must issue the pooled statement verbatim"
    );
    assert_eq!(
        format!("{:?}", calls[0].2),
        "[Str(\"ali-qwen3.7-flash\"), Str(\"default\"), Int(6539)]",
        "parameter order must match the pooled (name, namespace, user_id) binds"
    );
    assert_eq!(calls[1].1, referenced_model_statement());
    assert_eq!(
        format!("{:?}", calls[1].2),
        "[Str(\"user\"), Str(\"6539\"), Str(\"ali-qwen3.7-flash\")]"
    );
}

/// A non-`default` namespace binds only `(name, namespace)`, like the
/// pooled statement.
#[tokio::test]
async fn model_handle_read_outside_default_binds_two_values() {
    let mut sql = RecordedRequestSql::default();
    let _ = model_by_name_namespace_on(&mut sql, 6539, "m", "group-a").await;
    let calls = sql.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0].1, model_by_name_namespace_statement("group-a"));
    assert_eq!(
        format!("{:?}", calls[0].2),
        "[Str(\"m\"), Str(\"group-a\")]"
    );
    // The non-default namespace resolves its id before the referenced read.
    assert_eq!(calls[1].1, namespace_id_statement());
    assert_eq!(format!("{:?}", calls[1].2), "[Str(\"group-a\")]");
}

use serde_json::json;

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn team_by_id_matches_the_recorded_read() {
    // Recorded: SELECT kinds.id AS kinds_id, ... FROM kinds WHERE
    // kinds.id = 568317 AND kinds.kind = 'Team' AND kinds.is_active IS true
    // LIMIT 1
    assert_eq!(
        normalize(&team_by_id_statement()),
        "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
         kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
         kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
         kinds.is_active AS kinds_is_active, \
         kinds.created_at AS kinds_created_at, \
         kinds.updated_at AS kinds_updated_at FROM kinds \
         WHERE kinds.id = ? AND kinds.kind = 'Team' AND kinds.is_active IS true \
         LIMIT 1"
    );
}

#[test]
fn team_by_owner_matches_the_recorded_candidate_read() {
    let sql = normalize(&team_by_owner_statement());
    assert!(sql.contains("WHERE kinds.user_id = ? AND kinds.kind = 'Team'"));
    assert!(sql.contains("AND kinds.namespace = ? AND kinds.name = ?"));
    assert!(sql.contains("AND kinds.is_active = true LIMIT 1"));
}

#[test]
fn team_by_owner_name_first_keeps_the_recorded_filter_order() {
    let sql = normalize(&team_by_owner_name_first_statement());
    assert!(sql.contains("AND kinds.name = ? AND kinds.namespace = ?"));
    assert!(sql.contains("AND kinds.is_active IS true LIMIT 1"));
}

#[test]
fn model_read_matches_the_recorded_statement() {
    // Recorded (group namespace): WHERE kinds.kind = 'Model' AND
    // kinds.name = ? AND kinds.namespace = ? AND kinds.is_active IS true
    // ORDER BY kinds.id ASC LIMIT 1.
    let group = normalize(&model_by_name_namespace_statement("example-team"));
    assert!(
        group.contains("WHERE kinds.kind = 'Model' AND kinds.name = ? AND kinds.namespace = ?")
    );
    assert!(group.contains("AND kinds.is_active IS true"));
    assert!(group.contains("ORDER BY kinds.id ASC LIMIT 1"));
    // The group-namespace WHERE clause carries no owner filter.
    let group_where = group.split(" WHERE ").nth(1).unwrap_or_default();
    assert!(!group_where.contains("kinds.user_id"));

    // Recorded (default namespace): the caller's own or the public Model,
    // newest owner first.
    let default_ns = normalize(&model_by_name_namespace_statement("default"));
    assert!(default_ns.contains("(kinds.user_id = ? OR kinds.user_id = 0)"));
    assert!(default_ns.contains("ORDER BY kinds.user_id DESC, kinds.id ASC LIMIT 1"));
}

#[test]
fn referenced_model_reads_match_the_recorded_statements() {
    // Recorded: SELECT namespace.id FROM namespace WHERE namespace.name =
    // 'example-team' AND namespace.is_active IS true.
    let ns = normalize(&namespace_id_statement());
    assert!(ns.contains("SELECT namespace.id FROM namespace"));
    assert!(ns.contains("WHERE namespace.name = ? AND namespace.is_active IS true"));

    // Recorded: the approved Model shared into the scope, smallest id
    // first, never the public row.
    let referenced = normalize(&referenced_model_statement());
    assert!(referenced.contains("resource_members.resource_type = 'Model'"));
    assert!(referenced.contains("resource_members.entity_type = ?"));
    assert!(referenced.contains("resource_members.entity_id = ?"));
    assert!(referenced.contains("resource_members.status = 'approved'"));
    assert!(referenced.contains("AND kinds.user_id != 0"));
    assert!(referenced.contains("ORDER BY kinds.id ASC LIMIT 1"));
}

/// `_find_model_with_namespace`'s public-model gate
/// (`model_resolver.py:924`) reads the caller with
/// `db.query(User).filter(User.id == user_id).first()`. The recorded
/// statement carries the aliased ORM projection and the `.first()` limit,
/// which is what `team_union_lookups::user_by_id` renders.
#[test]
fn the_public_model_whitelist_reads_the_recorded_user_statement() {
    let sql = normalize(&format!(
        "SELECT {} FROM users WHERE users.id = ? LIMIT 1",
        crate::teams::teams_repository::USER_COLUMNS
    ));
    assert!(sql.starts_with(
        "SELECT users.id AS users_id, users.user_name AS users_user_name, \
         users.password_hash AS users_password_hash"
    ));
    assert!(sql.contains("WHERE users.id = ? LIMIT 1"));
}

#[test]
fn model_selection_follows_the_source_priorities() {
    let bot =
        json!({"modelRef": {"name": "ref-model"}, "agent_config": {"bind_model": "bound-model"}});
    assert_eq!(
        resolve_model_name(&bot, true, Some("task-model")).as_deref(),
        Some("task-model")
    );
    assert_eq!(
        resolve_model_name(&bot, false, Some("task-model")).as_deref(),
        Some("bound-model")
    );
    let ref_only = json!({"modelRef": {"name": "ref-model"}});
    assert_eq!(
        resolve_model_name(&ref_only, false, None).as_deref(),
        Some("ref-model")
    );
    assert_eq!(
        resolve_model_name(&json!({}), false, Some("task-model")).as_deref(),
        Some("task-model")
    );
    assert_eq!(resolve_model_name(&json!({}), false, None), None);
}

#[test]
fn model_reads_match_the_source_filters() {
    let private = normalize(&model_private_statement());
    assert!(
        private.contains("WHERE kinds.kind = 'Model' AND kinds.user_id = ? AND kinds.name = ?")
    );
    let group = normalize(&model_group_statement(2));
    assert!(group.contains("AND kinds.namespace IN (?, ?)"));
    let public = normalize(&model_public_statement());
    assert!(public.contains("WHERE kinds.user_id = 0 AND kinds.kind = 'Model'"));
}

#[test]
fn bot_reads_match_the_recorded_projection() {
    let bot = normalize(&bot_group_statement());
    assert!(bot.contains("WHERE kinds.kind = 'Bot' AND kinds.namespace = ? AND kinds.name = ?"));
    assert!(bot.contains("AND kinds.is_active = true LIMIT 1"));
    let personal = normalize(&bot_personal_statement());
    assert!(personal.contains("WHERE kinds.user_id = ? AND kinds.kind = 'Bot'"));
    let public = normalize(&bot_public_statement());
    assert!(public.contains("WHERE kinds.user_id = 0 AND kinds.kind = 'Bot'"));
}

#[test]
fn bot_refs_follow_member_order() {
    let team = serde_json::json!({
        "spec": {"members": [
            {"botRef": {"name": "Copy of team-beta-bot", "namespace": "ns-b"}},
            {"botRef": {"name": "second", "namespace": "ns-b"}},
        ]}
    });
    assert_eq!(
        bot_refs(&team),
        vec![
            BotRef {
                namespace: "ns-b".to_string(),
                name: "Copy of team-beta-bot".to_string(),
            },
            BotRef {
                namespace: "ns-b".to_string(),
                name: "second".to_string(),
            },
        ]
    );
}

#[test]
fn bot_refs_skip_malformed_members() {
    let team = serde_json::json!({
        "spec": {"members": [{"name": "x"}, {"botRef": {"name": "y"}}]}
    });
    assert!(bot_refs(&team).is_empty());
    assert!(bot_refs(&serde_json::json!({})).is_empty());
}

#[tokio::test]
async fn resolve_team_bots_reads_one_cached_bot_per_member() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    let team = serde_json::json!({
        "spec": {"members": [{"botRef": {"name": "bot", "namespace": "ns-b"}}]}
    });
    let bots = resolve_team_bots(&store, 6527, &team)
        .await
        .expect("resolve");
    // The capture fake returns no rows.
    assert!(bots.bot_ids.is_empty());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    // The cached reader's group predicate: kind/namespace/name params
    // (`get_group`'s filter, no owner id).
    assert!(queries[0].sql.contains("kinds.kind = ?"));
    assert!(queries[0].sql.contains("kinds.namespace = ?"));
    assert!(queries[0].sql.contains("kinds.name = ?"));
    assert_eq!(queries[0].args, 3);
}

#[tokio::test]
async fn task_ref_team_with_a_user_id_reads_by_owner() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let team = resolve_task_ref_team(&mysql, Some(1809), "ns-b", "team-beta", 6527)
        .await
        .expect("team");
    assert!(team.is_none());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    // The owner-scoped read (`kinds.user_id = ?`), not the viewer chain.
    assert!(queries[0].sql.contains("WHERE kinds.user_id = ?"));
}

#[tokio::test]
async fn task_ref_team_without_a_user_id_uses_the_viewer_chain() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let _ = resolve_task_ref_team(&mysql, None, "ns-b", "team", 6527)
        .await
        .expect("team");
    // The group branch of the cached team resolution runs first.
    assert!(
        mysql.queries()[0]
            .sql
            .contains("kinds.kind = ? AND kinds.namespace = ?")
    );
}

#[test]
fn group_and_namespace_reads_match_the_recorded_statements() {
    let group = normalize(&team_group_statement());
    assert!(group.contains("WHERE kinds.kind = 'Team' AND kinds.namespace = ? AND kinds.name = ?"));
    assert!(group.contains("AND kinds.is_active = true LIMIT 1"));
    // `get_group` carries no `user_id` filter (unlike `get_personal`).
    assert!(!group.contains("kinds.user_id = ?"));

    let namespace = normalize(&namespace_by_name_statement());
    assert!(namespace.contains("FROM namespace WHERE namespace.name = ?"));
    assert!(namespace.contains("AND namespace.is_active = 1 LIMIT 1"));

    let member = normalize(&namespace_member_statement());
    assert!(member.contains("resource_members.resource_type = 'Namespace'"));
    assert!(member.contains("resource_members.resource_id = ?"));
    assert!(member.contains("resource_members.entity_type = 'user'"));
    assert!(member.contains("resource_members.entity_id = ?"));
    assert!(member.contains("resource_members.status = 'approved' LIMIT 1"));

    let personal = normalize(&team_personal_statement());
    assert!(personal.contains("WHERE kinds.user_id = ?"));
    let public = normalize(&team_public_statement());
    assert!(public.contains("WHERE kinds.user_id = 0"));
}

#[test]
fn share_check_reads_match_the_recorded_statements() {
    let member = normalize(&team_member_check_statement());
    assert!(member.contains("resource_members.resource_type IN ('Team')"));
    assert!(member.contains("resource_members.entity_type = 'user'"));
    assert!(member.contains("resource_members.entity_id = ?"));
    assert!(member.contains("resource_members.status IN ('approved', 'APPROVED')"));
    assert!(
        member
            .contains("CASE WHEN (resource_members.resource_type = 'Team') THEN 1 ELSE 0 END DESC")
    );

    let team_entity = normalize(&team_entity_check_statement());
    assert!(team_entity.contains("resource_members.resource_type IN ('Team')"));
    assert!(team_entity.contains("resource_members.entity_type != 'user'"));
    assert!(team_entity.contains("resource_members.entity_id IS NOT NULL"));

    let namespace_entity = normalize(&namespace_entity_check_statement());
    assert!(namespace_entity.contains("resource_members.resource_type IN ('Namespace')"));
    assert!(
        namespace_entity.contains("resource_members.entity_type NOT IN ('', 'user', 'namespace')")
    );
}

#[tokio::test]
async fn resolve_team_group_branch_returns_none_when_the_group_is_absent() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    let team = resolve_team(&store, 6527, "ns-b", "team-beta")
        .await
        .expect("resolve");
    // The capture fake returns no rows, so the group read misses and the
    // chain stops before the namespace read.
    assert!(team.is_none());
    assert_eq!(mysql.queries().len(), 1);
    assert!(mysql.queries()[0].sql.contains("kinds.kind = ?"));
    assert!(!mysql.queries()[0].sql.contains("kinds.user_id = ?"));
}

/// `_bound_model_names`: `agent_config.bind_model` first, then the legacy
/// `spec.modelRef.name`, deduped. This is the list `_resolve_allowed_model_names`
/// probes when a task-level override is present.
#[test]
fn bound_model_names_prefers_bind_model_then_model_ref() {
    let bot = serde_json::json!({
        "spec": {
            "agent_config": {"bind_model": " bound-model "},
            "modelRef": {"name": "ref-model", "namespace": "default"}
        }
    });
    let agent_config = bot
        .get("spec")
        .unwrap()
        .get("agent_config")
        .unwrap()
        .clone();
    assert_eq!(
        bound_model_names(&bot.get("spec").unwrap().clone(), &agent_config),
        vec!["bound-model".to_string(), "ref-model".to_string()]
    );
}

#[test]
fn bound_model_names_dedupes_and_skips_a_blank_bind_model() {
    let bot = serde_json::json!({
        "spec": {
            "agent_config": {"bind_model": "same-model"},
            "modelRef": {"name": "same-model"}
        }
    });
    let agent_config = bot
        .get("spec")
        .unwrap()
        .get("agent_config")
        .unwrap()
        .clone();
    assert_eq!(
        bound_model_names(&bot.get("spec").unwrap().clone(), &agent_config),
        vec!["same-model".to_string()]
    );
    let blank = serde_json::json!({"spec": {"agent_config": {"bind_model": "  "}}});
    let blank_config = blank
        .get("spec")
        .unwrap()
        .get("agent_config")
        .unwrap()
        .clone();
    assert!(bound_model_names(&blank.get("spec").unwrap().clone(), &blank_config).is_empty());
}

/// The source's `isinstance(allowed_models, list) and allowed_models` guard:
/// an absent, non-list or empty whitelist means "no restriction", and only the
/// `name` of dict entries is collected.
#[test]
fn allowed_model_names_requires_a_non_empty_list_of_named_entries() {
    assert_eq!(allowed_model_names(None), None);
    assert_eq!(allowed_model_names(Some(&serde_json::json!([]))), None);
    assert_eq!(allowed_model_names(Some(&serde_json::json!("model"))), None);
    let names = allowed_model_names(Some(&serde_json::json!([
        {"name": "a", "type": "user"},
        {"type": "user"},
        {"name": "b"}
    ])))
    .expect("whitelist");
    assert_eq!(names.len(), 2);
    assert!(names.contains("a"));
    assert!(names.contains("b"));
}
