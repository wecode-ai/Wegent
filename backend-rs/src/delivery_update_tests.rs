use super::*;

fn delivery() -> DeliveryRow {
    DeliveryRow {
        id: "delivery-1".into(),
        loop_item_id: "issue-1".into(),
        created_by_user_id: 7,
        source_task_binding_id: None,
        source_task_snapshot: None,
        status: "delivered".into(),
        version: 3,
        created_at: chrono::DateTime::UNIX_EPOCH.naive_utc(),
        delivered_at: None,
        markdown_object_key: "old/markdown.md".into(),
        chat_object_key: None,
        manifest_object_key: None,
        metadata: Some(Json(json!({"fulfillments": []}))),
    }
}

fn input() -> Update {
    Update {
        title: "Title".into(),
        version: 3,
        markdown: "Notes".into(),
        chat: None,
        retained_asset_ids: vec![],
        files: vec![],
    }
}

fn asset() -> Asset {
    Asset {
        id: "asset-1".into(),
        kind: "file".into(),
        relative_path: "reports/result.txt".into(),
        display_name: "result.txt".into(),
        content_type: None,
        size_bytes: 3,
        sha256: "abc".into(),
        object_key: "old/file".into(),
    }
}

#[test]
fn response_normalizes_empty_values_like_python_readers() {
    let mut file = asset();
    for content_type in [None, Some(String::new())] {
        file.content_type = content_type;
        assert!(serde_json::to_value(&file).unwrap()["content_type"].is_null());
    }
    file.content_type = Some("text/plain".into());
    assert_eq!(
        serde_json::to_value(&file).unwrap()["content_type"],
        "text/plain"
    );
    let mut row = delivery();
    assert!(response_snapshot(&row).is_none());
    row.source_task_snapshot = Some(Json(json!({})));
    assert!(response_snapshot(&row).is_none());
    row.source_task_snapshot = Some(Json(json!({"task_id": "task-1"})));
    assert_eq!(response_snapshot(&row), Some(&json!({"task_id": "task-1"})));
}

#[test]
fn nullable_schema_keeps_optional_foreign_and_unique_columns_unset() {
    let sql = asset_insert_sql(&HashSet::new());
    for column in [
        "local_project_id",
        "assignee_team_id",
        "backend_task_id",
        "parent_id",
        "public_id",
        "project_key",
        "storage_prefix",
    ] {
        assert!(
            !sql.contains(column),
            "{column} must retain its NULL default"
        );
    }
    assert_eq!(sql.matches('?').count(), 10);
}

#[test]
fn sentinel_schema_supplies_only_the_required_optional_columns() {
    let required = ["local_project_id", "public_id", "metadata", "deleted_at"]
        .into_iter()
        .map(String::from)
        .collect();
    let sql = asset_insert_sql(&required);
    assert!(sql.contains("public_id, local_project_id, deleted_at, metadata"));
    assert!(sql.ends_with("'', 0, '1970-01-01 00:00:01', '{}')"));
    assert!(!sql.contains("assignee_team_id"));
    assert_eq!(sql.matches('?').count(), 10);
}

#[test]
fn validates_version_title_and_delivery_status() {
    assert!(validate(&input(), &delivery(), &[]).is_ok());
    let mut update = input();
    update.version = 2;
    assert!(validate(&update, &delivery(), &[]).is_err());
    update.version = 3;
    update.title = "  ".into();
    assert!(validate(&update, &delivery(), &[]).is_err());
    update.title = "x".repeat(256);
    assert!(validate(&update, &delivery(), &[]).is_err());
    let mut draft = delivery();
    draft.status = "draft".into();
    assert!(validate(&input(), &draft, &[]).is_err());
}

#[test]
fn rejects_foreign_assets_duplicate_paths_and_path_traversal() {
    let mut update = input();
    update.retained_asset_ids = vec!["foreign".into()];
    assert!(validate(&update, &delivery(), &[asset()]).is_err());
    update.retained_asset_ids = vec!["asset-1".into(), "asset-1".into()];
    assert!(validate(&update, &delivery(), &[asset()]).is_err());
    update.retained_asset_ids = vec!["asset-1".into()];
    update.files.push(NewFile {
        relative_path: "reports/result.txt".into(),
        display_name: "new.txt".into(),
        content_type: None,
    });
    assert!(validate(&update, &delivery(), &[asset()]).is_err());
    update.retained_asset_ids.clear();
    assert!(validate(&update, &delivery(), &[asset()]).is_ok());
    for path in [
        "../secret",
        "/absolute",
        "a/../secret",
        "a\\secret",
        "a//b",
        "a/./b",
    ] {
        update.files[0].relative_path = path.into();
        assert!(
            validate(&update, &delivery(), &[asset()]).is_err(),
            "{path}"
        );
    }
}

#[test]
fn protects_fulfillment_asset_references() {
    let mut row = delivery();
    row.metadata = Some(Json(
        json!({"fulfillments": [{"kind":"file", "asset_ids":["asset-1"]}]}),
    ));
    assert!(validate(&input(), &row, &[asset()]).is_err());
    let mut update = input();
    update.retained_asset_ids.push("asset-1".into());
    assert!(validate(&update, &row, &[asset()]).is_ok());
    row.metadata = Some(Json(
        json!({"fulfillments": [{"kind":"code_snapshot", "asset_id":"asset-1"}]}),
    ));
    assert!(validate(&input(), &row, &[asset()]).is_err());
}

#[test]
fn update_route_is_selected_and_registered() {
    let config = crate::hybrid::load_routes_config(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"),
    )
    .unwrap();
    assert!(
        crate::RouteTable::compile(config)
            .unwrap()
            .matches(&http::Method::PATCH, "/api/v1/deliveries/d1")
    );
    const PATCH: u16 = 1 << 4;
    assert!(
        brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .any(|route| route.path == "/api/v1/deliveries/:delivery_id"
                && route.methods & PATCH != 0)
    );
}

use brz_mysql::{MysqlArgs, MysqlExecution, MysqlResult};
#[derive(Default)]
struct RecordingTransaction {
    statements: Vec<String>,
    conflict: bool,
}

fn collapse(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, arguments: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        assert_eq!(
            sql.as_ref().matches('?').count(),
            arguments.len(),
            "SQL bind count"
        );
        self.statements.push(collapse(sql.as_ref()));
        Ok(MysqlExecution {
            rows_affected: if self.conflict { 0 } else { 1 },
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.statements.push(collapse(sql.as_ref()));
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
    }

    async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Ok(Vec::new())
    }

    fn fetch<'transaction, S, A, T>(
        &'transaction mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'transaction
    where
        S: AsRef<str> + Send + 'transaction,
        A: MysqlArgs + Send + 'transaction,
        T: FromMysqlRow + Send + 'transaction,
    {
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }
}

#[tokio::test]
async fn optimistic_lock_failure_stops_before_any_asset_writes() {
    let mut tx = RecordingTransaction {
        conflict: true,
        ..Default::default()
    };
    let result = commit_update(
        &mut tx,
        &delivery(),
        "10",
        &input(),
        &[],
        ContentKeys {
            markdown: "new/md",
            chat: None,
            manifest: "new/manifest",
        },
    )
    .await;
    assert!(
        matches!(result, Err(MysqlError::InvalidQuery { reason }) if reason == "delivery_conflict")
    );
    assert_eq!(tx.statements.len(), 1);
}

#[tokio::test]
async fn editing_only_updates_delivery_and_assets_without_republishing() {
    let mut tx = RecordingTransaction::default();
    commit_update(
        &mut tx,
        &delivery(),
        "10",
        &input(),
        &[asset()],
        ContentKeys {
            markdown: "new/md",
            chat: None,
            manifest: "new/manifest",
        },
    )
    .await
    .unwrap();
    assert_eq!(tx.statements.len(), 2);
    assert!(tx.statements[0].contains("AND version = ?"));
    assert!(!tx.statements[0].contains("delivered_at ="));
    assert!(!tx.statements[0].contains("current_delivery_id"));
    assert!(tx.statements[1].starts_with("INSERT INTO loop_items"));
}
