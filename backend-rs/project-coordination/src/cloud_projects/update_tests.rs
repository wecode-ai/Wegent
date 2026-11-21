// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the update transaction body.
use super::*;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};
use serde_json::{Map, Value, json};

/// The stored `metadata` document of the representative PATCH case.
const RECORDED_METADATA: &str = r#"{"tags": [], "visibility": "private", "board_config": {"group_by": "status", "statuses": [{"id": "inbox", "name": "收集箱", "color": "gray"}, {"id": "pending", "name": "待开始", "color": "blue"}, {"id": "in_progress", "name": "进行中", "color": "orange"}, {"id": "in_review", "name": "待确认", "color": "purple"}, {"id": "completed", "name": "已完成", "color": "green"}], "processing_start_status_id": "pending"}, "project_store": "backend", "task_provider": "local", "provider_config": {}}"#;

/// Records `(sql, argument count)` for every write, reports one affected row
/// (the optimistic-lock UPDATE succeeds) and no existing grant.
/// One captured write: the collapsed SQL, its argument count, and the encoded
/// size hint (which distinguishes an integer argument, 8 bytes, from the same
/// value bound as text, `len + 9`).
#[derive(Debug)]
struct Write {
    sql: String,
    args: usize,
    hint: usize,
}

#[derive(Default)]
struct WriteLog {
    writes: Vec<Write>,
}

impl MysqlTransaction for WriteLog {
    async fn execute<S, A>(&mut self, sql: S, arguments: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        let collapsed = sql
            .as_ref()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        self.writes.push(Write {
            sql: collapsed,
            args: arguments.len(),
            hint: arguments.encoded_size_hint(),
        });
        Ok(MysqlExecution {
            rows_affected: 1,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
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

fn target() -> UpdateTarget {
    UpdateTarget {
        id: "1000000000000000004".to_string(),
        metadata: serde_json::from_str::<Map<String, Value>>(RECORDED_METADATA).unwrap(),
        priority: 0,
    }
}

/// The recorded case issues the metadata UPDATE and the `Viewer` grant INSERT
/// in that order, with the recorded column set.
#[tokio::test]
async fn the_recorded_update_writes_the_metadata_and_the_grant() {
    let mut transaction = WriteLog::default();
    let update =
        super::request::CloudProjectUpdate::decode(&json!({"version": 1, "visibility": "public"}))
            .unwrap();
    apply_update(&mut transaction, &update, &target(), 3459, "jwt-key")
        .await
        .unwrap();

    assert_eq!(transaction.writes.len(), 2);
    let update_write = &transaction.writes[0];
    assert_eq!(
        update_write.sql,
        "UPDATE loop_items SET metadata=?, version=(loop_items.version + 1), \
         updated_at=now() WHERE loop_items.id = ? AND loop_items.version = ? \
         AND loop_items.resource_type IN ('project')"
    );
    assert_eq!(update_write.args, 3);
    // The recorded statement renders the expected version as the integer
    // literal `loop_items.version = 1`, so the bound value keeps the integer
    // type: `i64` contributes 8 bytes, while the same value as text would
    // contribute `1 + 9`. Replay constrains exact value types.
    let metadata = python_json_value(&Value::Object(
        serde_json::from_str::<Map<String, Value>>(RECORDED_METADATA).unwrap(),
    ));
    assert_eq!(
        update_write.hint,
        metadata.len() + 9 + "1000000000000000004".len() + 9 + 8
    );

    let insert_write = &transaction.writes[1];
    assert!(insert_write.sql.starts_with("INSERT INTO resource_members"));
    assert_eq!(insert_write.args, 3);
}

/// A `name`/`description` update adds those columns ahead of the version
/// bump; no metadata assignment appears because no metadata field was set.
#[tokio::test]
async fn direct_columns_precede_the_metadata_assignment() {
    let mut transaction = WriteLog::default();
    let update = super::request::CloudProjectUpdate::decode(&json!({
        "name": "Renamed",
        "version": 2,
    }))
    .unwrap();
    apply_update(&mut transaction, &update, &target(), 3459, "jwt-key")
        .await
        .unwrap();
    assert_eq!(transaction.writes.len(), 1);
    let write = &transaction.writes[0];
    assert_eq!(
        write.sql,
        "UPDATE loop_items SET name=?, version=(loop_items.version + 1), \
         updated_at=now() WHERE loop_items.id = ? AND loop_items.version = ? \
         AND loop_items.resource_type IN ('project')"
    );
    assert_eq!(write.args, 3);
    assert_eq!(
        write.hint,
        "Renamed".len() + 9 + "1000000000000000004".len() + 9 + 8
    );
}

#[test]
fn maintainer_permission_is_the_source_hierarchy() {
    assert!(has_permission("Owner", "Maintainer"));
    assert!(has_permission("Maintainer", "Maintainer"));
    assert!(!has_permission("Developer", "Maintainer"));
    assert!(!has_permission("Viewer", "Maintainer"));
    assert!(!has_permission("RestrictedAnalyst", "Maintainer"));
}

#[test]
fn a_lost_optimistic_lock_maps_to_the_409_conflict() {
    let error = map_update_error(conflict());
    assert_eq!(error.status(), StatusCode::CONFLICT);
    assert_eq!(error.detail_message(), Some("Cloud project changed"));
}

#[test]
fn a_merge_rejection_maps_to_the_422_detail() {
    let error = map_update_error(rejection(
        "Private projects cannot grant public access".to_owned(),
    ));
    assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error.detail_message(),
        Some("Private projects cannot grant public access")
    );
}

#[test]
fn any_other_dependency_failure_stays_an_internal_error() {
    let error = map_update_error(brz_mysql::MysqlError::RowNotFound);
    assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[test]
fn the_grant_request_time_renders_like_the_source_datetime_literal() {
    // The recorded value is `'2026-10-14 09:24:37.759910'`, i.e. Python's
    // `datetime.isoformat(" ")` with six-digit microseconds.
    let with_micros =
        chrono::NaiveDateTime::parse_from_str("2026-10-14 09:24:37.759910", "%Y-%m-%d %H:%M:%S%.f")
            .unwrap();
    assert_eq!(
        render_python_datetime(with_micros),
        "2026-10-14 09:24:37.759910"
    );

    // A whole second drops the fractional part, like `isoformat`.
    let whole =
        chrono::NaiveDateTime::parse_from_str("2026-10-14 09:24:37", "%Y-%m-%d %H:%M:%S").unwrap();
    assert_eq!(render_python_datetime(whole), "2026-10-14 09:24:37");
}
