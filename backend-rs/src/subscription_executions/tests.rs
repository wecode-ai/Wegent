// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused unit tests for the subscriptions executions handler.

use super::*;
use chrono::NaiveDate;

fn exec_row(id: i32, sub_id: i32) -> ExecutionRow {
    let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
        .unwrap()
        .and_hms_opt(4, 59, 37)
        .unwrap();
    ExecutionRow {
        id,
        user_id: 1237,
        subscription_id: sub_id,
        task_id: 170011985603497,
        inbox_message_id: 0,
        trigger_type: "cron".to_string(),
        trigger_reason: "Scheduled (cron: 29,59 8-19 * * *)".to_string(),
        prompt: "test prompt".to_string(),
        status: "COMPLETED".to_string(),
        result_summary: "summary".to_string(),
        error_message: String::new(),
        retry_attempt: 0,
        version: 1,
        started_at: dt,
        completed_at: dt,
        created_at: dt,
        updated_at: dt,
    }
}

#[test]
fn execution_item_has_pydantic_field_order() {
    let item = execution_item(
        &exec_row(2164069, 259790),
        Some("sub-name".to_string()),
        Some("Display".to_string()),
        Some("team".to_string()),
        Some("collection".to_string()),
        true,
    );
    let serialized = serde_json::to_value(&item).unwrap();
    let keys: Vec<&str> = serialized
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "subscription_id",
            "trigger_type",
            "trigger_reason",
            "prompt",
            "id",
            "user_id",
            "task_id",
            "status",
            "result_summary",
            "error_message",
            "retry_attempt",
            "started_at",
            "completed_at",
            "created_at",
            "updated_at",
            "subscription_name",
            "subscription_display_name",
            "team_name",
            "task_type",
            "can_delete",
        ]
    );
}

#[test]
fn pydantic_datetime_renders_without_fraction() {
    let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
        .unwrap()
        .and_hms_opt(4, 59, 37)
        .unwrap();
    let rendered = serde_json::to_value(PydanticDateTime::new(dt)).unwrap();
    assert_eq!(rendered, json!("2026-09-10T04:59:37"));
}

#[test]
fn pydantic_datetime_renders_with_microseconds() {
    let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
        .unwrap()
        .and_hms_micro_opt(4, 59, 37, 123456)
        .unwrap();
    let rendered = serde_json::to_value(PydanticDateTime::new(dt)).unwrap();
    assert_eq!(rendered, json!("2026-09-10T04:59:37.123456"));
}

#[test]
fn parses_default_query_params() {
    let params = ExecutionsQuery {
        page: None,
        limit: None,
        subscription_id: None,
        status: None,
        start_date: None,
        end_date: None,
        include_silent: None,
    }
    .validated()
    .unwrap();
    assert_eq!(params.page, 1);
    assert_eq!(params.limit, 50);
    assert_eq!(params.subscription_id, None);
    assert!(!params.include_silent);
}

#[test]
fn parses_explicit_query_params() {
    let params = ExecutionsQuery {
        page: Some("2".to_string()),
        limit: Some("100".to_string()),
        subscription_id: Some("42".to_string()),
        status: Some(vec!["COMPLETED".to_string()]),
        start_date: None,
        end_date: None,
        include_silent: Some("true".to_string()),
    }
    .validated()
    .unwrap();
    assert_eq!(params.page, 2);
    assert_eq!(params.limit, 100);
    assert_eq!(params.subscription_id, Some(42));
    assert!(params.include_silent);
    assert_eq!(params.status, vec!["COMPLETED"]);
}

#[test]
fn rejects_limit_over_100() {
    let error = ExecutionsQuery {
        page: None,
        limit: Some("101".to_string()),
        subscription_id: None,
        status: None,
        start_date: None,
        end_date: None,
        include_silent: None,
    }
    .validated()
    .unwrap_err();
    assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[test]
fn build_where_clause_excludes_silent_by_default() {
    let params = ExecutionsParams {
        page: 1,
        limit: 50,
        subscription_id: None,
        status: Vec::new(),
        start_date: None,
        end_date: None,
        include_silent: false,
    };
    let clause = build_where_clause(1237, &[], &params, None);
    assert!(clause.contains("status != 'COMPLETED_SILENT'"));
}

#[test]
fn build_where_clause_includes_followed_ids() {
    let params = ExecutionsParams {
        page: 1,
        limit: 50,
        subscription_id: None,
        status: Vec::new(),
        start_date: None,
        end_date: None,
        include_silent: false,
    };
    let clause = build_where_clause(1237, &[237489, 259790], &params, None);
    assert!(clause.contains(
        "(background_executions.user_id = 1237 OR background_executions.subscription_id IN (237489, 259790))"
    ));
}

#[test]
fn distinct_subscription_ids_dedupes() {
    let rows = vec![exec_row(1, 10), exec_row(2, 20), exec_row(3, 10)];
    let ids = distinct_subscription_ids(&rows);
    assert_eq!(ids, vec![10, 20]);
}

#[test]
fn build_where_clause_public_subscription_filters_by_id_alone() {
    let params = ExecutionsParams {
        page: 1,
        limit: 50,
        subscription_id: Some(119702),
        status: Vec::new(),
        start_date: None,
        end_date: None,
        include_silent: false,
    };
    let clause = build_where_clause(1237, &[], &params, Some(119702));
    assert_eq!(
        clause,
        "background_executions.subscription_id = 119702 AND background_executions.status != 'COMPLETED_SILENT'"
    );
}

#[test]
fn build_where_clause_non_public_subscription_keeps_user_filter() {
    let params = ExecutionsParams {
        page: 1,
        limit: 50,
        subscription_id: Some(119702),
        status: Vec::new(),
        start_date: None,
        end_date: None,
        include_silent: false,
    };
    let clause = build_where_clause(1237, &[], &params, None);
    assert_eq!(
        clause,
        "background_executions.user_id = 1237 AND background_executions.subscription_id = 119702 AND background_executions.status != 'COMPLETED_SILENT'"
    );
}

#[test]
fn is_public_visibility_matches_only_public() {
    let public = SubscriptionCrd {
        spec: Some(SubscriptionSpec {
            display_name: None,
            task_type: None,
            team_ref: None,
            visibility: Some("public".to_string()),
        }),
    };
    let private = SubscriptionCrd {
        spec: Some(SubscriptionSpec {
            display_name: None,
            task_type: None,
            team_ref: None,
            visibility: Some("private".to_string()),
        }),
    };
    let missing = SubscriptionCrd { spec: None };
    assert!(is_public_visibility(&public));
    assert!(!is_public_visibility(&private));
    assert!(!is_public_visibility(&missing));
}

#[test]
fn team_predicate_omits_single_condition_parentheses() {
    let single = vec![("新闻洞察团队(示例)".to_string(), "default".to_string())];
    assert_eq!(
        team_predicate(&single),
        "kinds.name = '新闻洞察团队(示例)' AND kinds.namespace = 'default'"
    );
}

#[test]
fn team_predicate_wraps_multiple_conditions_in_one_group() {
    let multiple = vec![
        ("team-a".to_string(), "default".to_string()),
        ("team-b".to_string(), "ns".to_string()),
    ];
    assert_eq!(
        team_predicate(&multiple),
        "(kinds.name = 'team-a' AND kinds.namespace = 'default' OR kinds.name = 'team-b' AND kinds.namespace = 'ns')"
    );
}

#[test]
fn insert_team_ref_dedupes_and_preserves_first_seen_order() {
    // The source builds `team_refs` as a dict keyed by (name, namespace):
    // repeated references collapse to one first-seen entry per team.
    let mut team_refs: Vec<(String, String)> = Vec::new();
    for (name, namespace) in [
        ("wegent-wework", "default"),
        ("wegent-chat", "default"),
        ("wegent-wework", "default"),
    ] {
        insert_team_ref(
            &mut team_refs,
            &TeamRef {
                name: name.to_string(),
                namespace: namespace.to_string(),
            },
        );
    }
    assert_eq!(
        team_refs,
        vec![
            ("wegent-wework".to_string(), "default".to_string()),
            ("wegent-chat".to_string(), "default".to_string()),
        ]
    );
    assert_eq!(
        team_predicate(&team_refs),
        "(kinds.name = 'wegent-wework' AND kinds.namespace = 'default' OR kinds.name = 'wegent-chat' AND kinds.namespace = 'default')"
    );
}

#[test]
fn escape_sql_string_quotes_apostrophes() {
    assert_eq!(escape_sql_string("a'b"), "a\\'b");
    assert_eq!(escape_sql_string("normal"), "normal");
}
