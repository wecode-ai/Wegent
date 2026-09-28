// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn task_row(id: i64, name: &str, updated_at: &str) -> ProjectTaskRow {
    ProjectTaskRow {
        id,
        name: name.to_string(),
        crd: TaskCrd::default(),
        updated_at: NaiveDateTime::parse_from_str(updated_at, "%Y-%m-%d %H:%M:%S").unwrap(),
    }
}

fn task_row_with_crd(id: i64, name: &str, updated_at: &str, crd: TaskCrd) -> ProjectTaskRow {
    ProjectTaskRow {
        id,
        name: name.to_string(),
        crd,
        updated_at: NaiveDateTime::parse_from_str(updated_at, "%Y-%m-%d %H:%M:%S").unwrap(),
    }
}

#[test]
fn include_tasks_parses_pydantic_booleans() {
    assert!(parse_include_tasks(None).unwrap());
    assert!(parse_include_tasks(Some("true")).unwrap());
    assert!(!parse_include_tasks(Some("False")).unwrap());
    assert!(parse_include_tasks(Some("1")).unwrap());
    assert!(!parse_include_tasks(Some("0")).unwrap());
    assert!(parse_include_tasks(Some("yes")).unwrap());
    assert!(parse_include_tasks(Some("on")).unwrap());
    let error = parse_include_tasks(Some("maybe")).unwrap_err();
    assert_eq!(
        error.status(),
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[test]
fn client_origin_matches_the_source_pattern() {
    assert_eq!(parse_client_origin(None).unwrap(), "frontend");
    assert_eq!(parse_client_origin(Some("wework")).unwrap(), "wework");
    assert!(parse_client_origin(Some("app")).is_err());
}

/// The route's declared response type must be the typed model, which the API
/// adapter converts through its JSON kind. The source declares
/// `response_model=ProjectListResponse`, so FastAPI renders the body with the
/// `application/json` media type; a raw `HttpResponse<Binary>` body only
/// satisfies the binary kind and renders `application/octet-stream`.
#[test]
fn list_projects_declares_the_json_response_model() {
    fn assert_json_route<F>(_route: F)
    where
        F: for<'a> std::ops::AsyncFn(
                &'a Arc<AppState>,
                crate::auth::SessionUser,
                Option<String>,
                Option<String>,
            ) -> Result<ProjectListResponse, FastApiError>,
    {
    }

    assert_json_route(list_projects);
}

#[test]
fn merge_puts_shard_rows_first_dedups_and_sorts_desc() {
    let shard = vec![
        task_row(2, "b", "2026-09-02 10:00:00"),
        task_row(3, "c", "2026-09-01 10:00:00"),
    ];
    let legacy = vec![
        task_row(1, "a", "2026-09-05 10:00:00"),
        task_row(2, "b-old", "2026-09-04 10:00:00"),
    ];
    let merged = merge_project_tasks(shard, legacy);
    let ids: Vec<i64> = merged.iter().map(|row| row.id).collect();
    assert_eq!(ids, vec![1, 2, 3]);
}

#[test]
fn task_item_uses_the_source_fallbacks() {
    let crd = TaskCrd {
        spec: Some(TaskSpec {
            title: Some("Example Title".to_string()),
            device_id: Some("dev-1".to_string()),
            is_group_chat: Some(true),
            execution: Some(TaskExecution {
                workspace: Some(TaskWorkspace {
                    source: Some(" git ".to_string()),
                    path: Some("  ".to_string()),
                }),
            }),
        }),
        status: Some(TaskStatus { phase: None }),
    };
    let row = task_row_with_crd(42, "task-42", "2026-09-02 16:25:00", crd);
    let item = task_item(&row, 2282);
    assert_eq!(item.task_id, 42);
    assert_eq!(item.task_title, "Example Title");
    assert_eq!(item.task_status, "PENDING");
    assert_eq!(item.device_id.as_deref(), Some("dev-1"));
    assert_eq!(item.execution_workspace_source.as_deref(), Some("git"));
    assert!(item.execution_workspace_path.is_none());
    assert!(item.is_group_chat);
    assert_eq!(item.project_id, 2282);
    assert_eq!(item.updated_at, "2026-09-02T16:25:00");
}

#[test]
fn task_title_falls_back_to_name_then_id() {
    let named = task_row(7, "task-7", "2026-01-01 00:00:00");
    assert_eq!(task_item(&named, 1).task_title, "task-7");

    let unnamed = task_row(9, "", "2026-01-01 00:00:00");
    assert_eq!(task_item(&unnamed, 1).task_title, "Task #9");
}

#[test]
fn task_status_reads_the_phase_field() {
    let crd = TaskCrd {
        spec: None,
        status: Some(TaskStatus {
            phase: Some("RUNNING".to_string()),
        }),
    };
    let row = task_row_with_crd(1, "n", "2026-01-01 00:00:00", crd);
    assert_eq!(task_item(&row, 1).task_status, "RUNNING");

    let row2 = task_row(1, "n", "2026-01-01 00:00:00");
    assert_eq!(task_item(&row2, 1).task_status, "PENDING");
}

#[test]
fn datetimes_render_pydantic_style() {
    let parsed = NaiveDateTime::parse_from_str("2026-09-02 16:21:57", "%Y-%m-%d %H:%M:%S").unwrap();
    assert_eq!(pydantic_datetime(parsed), "2026-09-02T16:21:57");
}

#[test]
fn task_crd_decodes_from_json() {
    let crd: TaskCrd = serde_json::from_str(
        r#"{"spec":{"title":"t","device_id":"d","is_group_chat":true,
        "execution":{"workspace":{"source":"git","path":"/foo"}}},
        "status":{"phase":"RUNNING"}}"#,
    )
    .unwrap();
    assert_eq!(crd.spec().unwrap().title.as_deref(), Some("t"));
    assert_eq!(crd.spec().unwrap().device_id.as_deref(), Some("d"));
    assert!(crd.spec().unwrap().is_group_chat.unwrap());
    assert_eq!(
        crd.spec()
            .unwrap()
            .execution
            .as_ref()
            .unwrap()
            .workspace
            .as_ref()
            .unwrap()
            .source
            .as_deref(),
        Some("git")
    );
    assert_eq!(crd.status_phase(), Some("RUNNING"));
}

#[test]
fn task_crd_ignores_unknown_keys() {
    let crd: TaskCrd = serde_json::from_str(
        r#"{"spec":{"title":"t","unknown":42},"status":{"phase":"PENDING"},"extra":1}"#,
    )
    .unwrap();
    assert_eq!(crd.spec().unwrap().title.as_deref(), Some("t"));
    assert_eq!(crd.status_phase(), Some("PENDING"));
}

#[test]
fn task_crd_handles_empty_object() {
    let crd: TaskCrd = serde_json::from_str("{}").unwrap();
    assert!(crd.spec().is_none());
    assert!(crd.status_phase().is_none());
}

#[test]
fn task_crd_non_object_defaults_to_empty() {
    let crd: TaskCrd = serde_json::from_str("\"some string\"").unwrap();
    assert!(crd.spec().is_none());
    assert!(crd.status_phase().is_none());

    let crd: TaskCrd = serde_json::from_str("null").unwrap();
    assert!(crd.spec().is_none());

    let crd: TaskCrd = serde_json::from_str("42").unwrap();
    assert!(crd.spec().is_none());

    let crd: TaskCrd = serde_json::from_str("[1, 2]").unwrap();
    assert!(crd.spec().is_none());
}

#[test]
fn stored_project_config_decodes_and_serializes() {
    let config: StoredProjectConfig = serde_json::from_str(
        r#"{"mode":"workspace","device_id":"d1",
        "execution":{"targetType":"local","deviceId":"d1"}}"#,
    )
    .unwrap();
    let json = serde_json::to_string(&config).unwrap();
    assert!(json.contains("\"mode\":\"workspace\""));
    assert!(json.contains("\"device_id\":\"d1\""));
    assert!(json.contains("\"execution\""));
    assert!(json.contains("\"targetType\":\"local\""));
    assert!(json.contains("\"team\":null"));
    assert!(json.contains("\"workspace\":null"));
    assert!(json.contains("\"git\":null"));
    assert!(json.contains("\"modelSelection\":null"));
}

#[test]
fn stored_project_config_rejects_unknown_fields() {
    let result: Result<StoredProjectConfig, _> =
        serde_json::from_str(r#"{"mode":"workspace","extra":"x"}"#);
    assert!(result.is_err());
}

#[test]
fn stored_project_config_empty_object_serializes_all_nulls() {
    let config: StoredProjectConfig = serde_json::from_str("{}").unwrap();
    let json = serde_json::to_string(&config).unwrap();
    assert!(json.contains("\"mode\":null"));
    assert!(json.contains("\"device_id\":null"));
    assert!(json.contains("\"execution\":null"));
    assert!(json.contains("\"team\":null"));
    assert!(json.contains("\"workspace\":null"));
    assert!(json.contains("\"git\":null"));
    assert!(json.contains("\"modelSelection\":null"));
}

#[test]
fn git_config_fills_default_branch() {
    let git: ProjectGitConfig = serde_json::from_str(r#"{"url":"http://x.git"}"#).unwrap();
    assert_eq!(git.branch, "main");
    let json = serde_json::to_string(&git).unwrap();
    assert!(json.contains("\"branch\":\"main\""));
}

#[test]
fn team_config_fills_default_namespace() {
    let team: ProjectTeamConfig = serde_json::from_str(r#"{"id":1}"#).unwrap();
    assert_eq!(team.namespace, "default");
}

#[test]
fn model_selection_fills_default_options() {
    let ms: ProjectModelSelection = serde_json::from_str(r#"{"modelName":"gpt-4"}"#).unwrap();
    let json = serde_json::to_string(&ms).unwrap();
    assert!(json.contains("\"options\":{}"));
}

#[tokio::test]
async fn project_task_queries_bind_origin_and_preserve_ordering() {
    use crate::sql_test_support::{QueryCapture, Route};
    for origin in [None, Some(""), Some("client'\\name")] {
        let mysql = QueryCapture::default();
        query_base_project_tasks(&mysql, 11, 7, origin)
            .await
            .unwrap();
        query_shard_project_tasks(&mysql, 11, 7, origin)
            .await
            .unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2);
        // The legacy rows live in the base table, so the base read passes the
        // zero routing key even though an owner id is available; only the
        // shard read routes to the owner's shard.
        assert_eq!(queries[0].route, Route::User(0));
        assert_eq!(queries[1].route, Route::User(7));
        for query in &queries {
            assert_eq!(query.args, 2 + usize::from(origin.is_some()));
            assert_eq!(
                query.sql.contains("AND client_origin = ?"),
                origin.is_some()
            );
            assert!(!query.sql.contains("client'"));
        }
        assert!(queries[0].sql.ends_with("ORDER BY updated_at DESC"));
        assert!(!queries[1].sql.contains("ORDER BY"));
    }
}

#[tokio::test]
async fn base_project_task_query_uses_the_base_route_once() {
    use crate::sql_test_support::{QueryCapture, Route};
    let mysql = QueryCapture::default();
    let rows = query_base_project_tasks(&mysql, 11, 7, Some("frontend"))
        .await
        .unwrap();
    assert!(rows.is_empty());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].route, Route::User(0));
    assert_eq!(queries[0].args, 3);
    assert!(queries[0].sql.contains("FROM {{tasks}}"));
    assert!(queries[0].sql.contains("user_id = ?"));
    assert!(queries[0].sql.ends_with("ORDER BY updated_at DESC"));
}

#[tokio::test]
async fn migrated_task_probe_binds_each_id_and_skips_empty_input() {
    use crate::sql_test_support::{QueryCapture, Route};
    let mysql = QueryCapture::default();
    assert!(
        exclude_migrated_legacy_rows(&mysql, 7, vec![])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(mysql.queries().is_empty());
    let tasks = vec![
        task_row(41, "one", "2026-01-01 00:00:00"),
        task_row(42, "two", "2026-01-01 00:00:00"),
    ];
    assert_eq!(
        exclude_migrated_legacy_rows(&mysql, 7, tasks)
            .await
            .unwrap()
            .len(),
        2
    );
    let queries = mysql.queries();
    assert_eq!(queries[0].route, Route::User(7));
    assert_eq!(
        queries[0].sql,
        "SELECT id FROM {{tasks}} WHERE id IN (?, ?)"
    );
    assert_eq!(queries[0].args, 2);
}

#[tokio::test]
async fn migrated_task_read_uses_the_base_route_for_the_legacy_half() {
    use crate::sql_test_support::{QueryCapture, Route};
    let mysql = QueryCapture::default();
    // The capture stub returns no rows, so the legacy half is empty and the
    // source's probe early-out applies; only the two reads are issued.
    let merged = query_migrated_project_tasks(&mysql, 11, 7, Some("frontend"))
        .await
        .unwrap();
    assert!(merged.is_empty());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 2);
    // The legacy rows are read from the base `tasks` table (`ByUserId(0)`),
    // while the shard half routes to the owner's shard table.
    assert_eq!(queries[0].route, Route::User(0));
    assert!(queries[0].sql.ends_with("ORDER BY updated_at DESC"));
    assert_eq!(queries[1].route, Route::User(7));
    assert!(!queries[1].sql.contains("ORDER BY"));
}
