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
async fn the_public_store_reads_project_tasks_from_the_base_table() {
    use crate::sql_test_support::KindQueryCapture;
    use crate::task_store::{DefaultTaskStore, TaskStore};

    for origin in [None, Some("frontend")] {
        let mysql = KindQueryCapture::default();
        let rows = DefaultTaskStore::new(mysql.clone())
            .list_active_project_tasks(11, 7, origin)
            .await
            .unwrap();
        assert!(rows.is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 2 + usize::from(origin.is_some()));
        assert_eq!(queries[0].first_integer, Some(11));
        assert!(queries[0].sql.starts_with("SELECT id, user_id, kind"));
        assert!(queries[0].sql.contains("FROM tasks"));
        assert!(queries[0].sql.contains("AND user_id = ?"));
        assert_eq!(
            queries[0].sql.contains("AND client_origin = ?"),
            origin.is_some()
        );
        assert!(queries[0].sql.ends_with("ORDER BY updated_at DESC"));
        assert!(!queries[0].sql.contains('{'));
    }
}

/// `_with_task_project_label(task, None)` drops only
/// `metadata.labels.projectId`, keeping every other key.
#[test]
fn clear_project_label_drops_only_the_project_id_label() {
    let task = serde_json::json!({
        "metadata": {"labels": {"projectId": "2180", "keep": "yes"}, "name": "t"},
        "spec": {"title": "x"}
    });
    assert_eq!(
        clear_project_label(&task),
        serde_json::json!({
            "metadata": {"labels": {"keep": "yes"}, "name": "t"},
            "spec": {"title": "x"}
        })
    );
}

/// The source normalizes each level with `dict(... or {})`, so a task without
/// metadata or labels renders them as empty objects.
#[test]
fn clear_project_label_materializes_missing_metadata_and_labels() {
    assert_eq!(
        clear_project_label(&serde_json::json!({"spec": {}})),
        serde_json::json!({"spec": {}, "metadata": {"labels": {}}})
    );
    assert_eq!(
        clear_project_label(&serde_json::Value::Null),
        serde_json::json!({"metadata": {"labels": {}}})
    );
}

/// The route's declared response type must be the typed model, which the API
/// adapter converts through its JSON kind (`response_model=
/// RemoveTaskFromProjectResponse`), so the 200 body renders as
/// `application/json`.
#[test]
fn remove_task_declares_the_json_response_model() {
    fn assert_json_route<F>(_route: F)
    where
        F: for<'a> std::ops::AsyncFn(
                &'a Arc<AppState>,
                crate::auth::SessionUser,
                i64,
                i64,
                Option<String>,
            )
                -> Result<RemoveTaskFromProjectResponse, FastApiError>,
    {
    }

    assert_json_route(remove_task_from_project);
}

/// The route returns the source's explicit `204` empty response, so the
/// handler's declared return type is the framework `Response` the adapter
/// renders directly (a JSON kind would serialize `null` as a body).
#[test]
fn delete_project_declares_the_empty_response() {
    fn assert_response_route<F>(_route: F)
    where
        F: for<'a> std::ops::AsyncFn(
                &'a Arc<AppState>,
                crate::auth::SessionUser,
                i64,
                Option<String>,
            ) -> Result<Response, FastApiError>,
    {
    }

    assert_response_route(delete_project);
}

/// The clear-project statements keep the recorded SQLAlchemy shapes: the
/// `synchronize_session="fetch"` primary-key select reads only `id`, and the
/// bulk update sets `updated_at` (the column's Python-side `onupdate`) before
/// `project_id=0`; the optional origin predicate binds last.
#[test]
fn clear_project_statements_keep_their_recorded_shapes() {
    use crate::task_store::{clear_project_ids_statement, clear_project_update_statement};

    assert_eq!(
        clear_project_ids_statement("tasks", true),
        "SELECT tasks.id \nFROM tasks \n\
         WHERE tasks.project_id = ? AND tasks.user_id = ? AND tasks.client_origin = ?"
    );
    assert_eq!(
        clear_project_update_statement("tasks", true),
        "UPDATE tasks SET updated_at = ?, project_id=0 \n\
         WHERE tasks.project_id = ? AND tasks.user_id = ? AND tasks.client_origin = ?"
    );
    assert!(!clear_project_ids_statement("tasks", false).contains("client_origin"));
    assert!(!clear_project_update_statement("tasks", false).contains("client_origin"));
}

/// A recording `Mysql` handle that captures write statements and their
/// parameter counts without a database.
#[derive(Clone, Default)]
struct WriteCapture {
    writes: std::sync::Arc<std::sync::Mutex<Vec<(String, usize)>>>,
}

impl WriteCapture {
    fn writes(&self) -> Vec<(String, usize)> {
        self.writes.lock().unwrap().clone()
    }
}

impl brz_mysql::Mysql for WriteCapture {
    type Transaction = brz_mysql::MysqlTransactionService;

    fn with_route<R: brz_mysql::MysqlRouting + 'static>(&self, _: R) -> brz_mysql::MysqlService {
        panic!("plain queries must reuse the configured service")
    }

    fn route<K: brz_mysql::MysqlRouteKey>(&self, _key: K) -> Self {
        panic!("these writes carry no routing key")
    }

    async fn execute<S, A>(&self, sql: S, args: A) -> MysqlResult<brz_mysql::MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
    {
        self.writes.lock().unwrap().push((
            sql.as_ref()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            args.len(),
        ));
        Ok(brz_mysql::MysqlExecution {
            rows_affected: 0,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&self, _: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        panic!("unexpected fetch_optional")
    }

    async fn fetch_all<S, A, T>(&self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        panic!("unexpected fetch_all")
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
    }

    fn fetch<'a, S, A, T>(
        &'a self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: brz_mysql::MysqlArgs + Send + 'a,
        T: brz_mysql::FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }

    async fn with_transaction<T, F>(&self, _: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        panic!("unexpected transaction")
    }
}

/// The single-table store detaches the project's tasks with one bulk update,
/// binding `updated_at` first, then the project id, the owner, and the
/// optional origin.
#[tokio::test]
async fn the_public_store_clears_the_project_with_one_update() {
    use crate::task_store::{DefaultTaskStore, TaskStore};

    for origin in [None, Some("frontend")] {
        let mysql = WriteCapture::default();
        let updated = DefaultTaskStore::new(mysql.clone())
            .clear_project_for_owned_tasks(11, 7, origin)
            .await
            .unwrap();
        assert_eq!(updated, 0);
        let writes = mysql.writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].1, 3 + usize::from(origin.is_some()));
        assert!(
            writes[0]
                .0
                .starts_with("UPDATE tasks SET updated_at = ?, project_id=0"),
            "{}",
            writes[0].0
        );
        assert!(
            writes[0]
                .0
                .contains("WHERE tasks.project_id = ? AND tasks.user_id = ?")
        );
        assert_eq!(
            writes[0].0.contains("AND tasks.client_origin = ?"),
            origin.is_some()
        );
        assert!(!writes[0].0.contains('{'));
    }
}
