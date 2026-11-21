// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the metadata merge and its value helpers.
use super::*;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};
use serde_json::{Map, Value, json};

/// The stored `metadata` document recorded for the representative PATCH case
/// (MySQL object-key order, which `json.dumps` preserves).
const RECORDED_METADATA: &str = r#"{"tags": [], "visibility": "private", "board_config": {"group_by": "status", "statuses": [{"id": "inbox", "name": "收集箱", "color": "gray"}, {"id": "pending", "name": "待开始", "color": "blue"}, {"id": "in_progress", "name": "进行中", "color": "orange"}, {"id": "in_review", "name": "待确认", "color": "purple"}, {"id": "completed", "name": "已完成", "color": "green"}], "processing_start_status_id": "pending"}, "project_store": "backend", "task_provider": "local", "provider_config": {}}"#;

/// A transaction that records statements and reports no existing grant, so a
/// `visibility: public` update takes the "add grant" branch.
#[derive(Default)]
struct RecordingTransaction {
    statements: Vec<String>,
}

fn collapse(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        self.statements.push(collapse(sql.as_ref()));
        Ok(MysqlExecution {
            rows_affected: 1,
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

fn recorded_metadata() -> Map<String, Value> {
    serde_json::from_str(RECORDED_METADATA).expect("the recorded metadata parses")
}

/// The recorded case sets only `visibility: public`: the branch reads the
/// existing grant, adds a `Viewer` grant, and leaves the stored metadata (in
/// particular its stale `"visibility": "private"`) untouched.
#[tokio::test]
async fn public_visibility_requests_a_viewer_grant_and_keeps_the_metadata() {
    let mut transaction = RecordingTransaction::default();
    let update = super::super::request::CloudProjectUpdate::decode(
        &json!({"version": 1, "visibility": "public"}),
    )
    .unwrap();
    let outcome = merge_metadata(
        &mut transaction,
        recorded_metadata(),
        &update,
        999_579_368_579_469_685,
        3459,
        "jwt-key",
    )
    .await
    .unwrap();

    assert_eq!(outcome.grant_role.as_deref(), Some("Viewer"));
    let serialized = crate::json_compat::python_json_value(&Value::Object(outcome.metadata));
    assert_eq!(
        serde_json::from_str::<Value>(&serialized).unwrap(),
        Value::Object(recorded_metadata())
    );
    assert!(serialized.starts_with(r#"{"tags": [], "visibility": "private", "board_config": {"#));
    // `python_json_value` escapes non-ASCII the way `json.dumps` does, so the
    // status name is stored as `\uXXXX`.
    // The parsed round-trip above proves the escaped status names survive.

    assert_eq!(transaction.statements.len(), 1);
    assert!(
        transaction.statements[0].starts_with("SELECT resource_members.id AS resource_members_id")
    );
}

#[tokio::test]
async fn public_access_without_visibility_grants_nothing_for_a_private_project() {
    let mut transaction = RecordingTransaction::default();
    // `public_access` alone leaves `visibility` unset, so the project stays
    // private and the branch rejects the grant.
    let update = super::super::request::CloudProjectUpdate::decode(&json!({
        "version": 1,
        "public_access": {"role": "Viewer"},
    }))
    .unwrap();
    let rejection = merge_metadata(&mut transaction, Map::new(), &update, 1, 1, "jwt-key")
        .await
        .unwrap_err();
    assert!(matches!(
        rejection,
        MergeError::Rejected(ref message) if message == "Private projects cannot grant public access"
    ));
}

#[test]
fn executing_environment_fingerprint_matches_the_source_hash() {
    let empty = json!({
        "workspace_policy": "git_worktree",
        "repositories": [],
        "setup_steps": [],
    });
    assert_eq!(
        execution_environment_fingerprint(&empty),
        "14951fb84fd4a3d11ca34bbfe877916b07cdae16747f672f30632c9b6183a8ea"
    );

    let populated = json!({
        "workspace_policy": "git_worktree",
        "repositories": [
            {"name": " repo ", "url": " https://x/y.git ", "ref": " main ", "path": "src", "primary": true},
        ],
        "setup_steps": [{"command": " make ", "working_directory": "src"}],
    });
    assert_eq!(
        execution_environment_fingerprint(&populated),
        "af1d385caf58bab232e8453b2b09f7c2d3d1864cb67234c04f5d5007c45ede2e"
    );
}

#[test]
fn preparing_keeps_devices_only_when_the_fingerprint_is_unchanged() {
    let definition = json!({
        "workspace_policy": "git_worktree",
        "repositories": [],
        "setup_steps": [],
    });
    let fingerprint = execution_environment_fingerprint(&definition);
    let previous = json!({
        "fingerprint": fingerprint,
        "devices": {"dev-1": {"status": "ready"}},
    });
    let prepared = preparing_execution_environment(&definition, Some(&previous));
    assert_eq!(prepared["fingerprint"], json!(fingerprint));
    assert_eq!(prepared["devices"], json!({"dev-1": {"status": "ready"}}));

    // The fingerprint only covers repositories and setup steps, so a
    // workspace-policy change keeps the prepared devices.
    let policy_changed = json!({
        "workspace_policy": "project",
        "repositories": [],
        "setup_steps": [],
    });
    let prepared = preparing_execution_environment(&policy_changed, Some(&previous));
    assert_eq!(prepared["devices"], json!({"dev-1": {"status": "ready"}}));

    // A changed repository set produces a new fingerprint and drops them.
    let repositories_changed = json!({
        "workspace_policy": "git_worktree",
        "repositories": [{"name": "n", "url": "u", "ref": "", "path": "p", "primary": true}],
        "setup_steps": [],
    });
    let prepared = preparing_execution_environment(&repositories_changed, Some(&previous));
    assert_eq!(prepared["devices"], json!({}));
}

#[test]
fn write_status_change_appends_a_snapshot_entry() {
    let statuses = default_board_statuses();
    let mut metadata = Map::new();
    write_status_change(
        &mut metadata,
        &statuses,
        "pending",
        "",
        "status_removed",
        Some(7),
    );
    let history = metadata["status_history"].as_array().unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["from_status"], json!("pending"));
    assert_eq!(history[0]["from_status_name"], json!("待开始"));
    assert_eq!(history[0]["to_status"], json!(""));
    assert_eq!(history[0]["to_status_name"], json!(""));
    assert_eq!(history[0]["trigger"], json!("status_removed"));
    assert_eq!(history[0]["by_user_id"], json!(7));
}

#[test]
fn metadata_board_statuses_falls_back_to_the_default_board() {
    let statuses = metadata_board_statuses(&Map::new());
    assert_eq!(statuses.len(), 5);
    assert_eq!(statuses[0].0, "inbox");
    assert_eq!(statuses[0].1, "收集箱");

    let mut metadata = Map::new();
    metadata.insert(
        "board_config".to_owned(),
        json!({"statuses": [{"id": "a", "name": "A"}]}),
    );
    assert_eq!(
        metadata_board_statuses(&metadata),
        vec![("a".to_owned(), "A".to_owned())]
    );
}
