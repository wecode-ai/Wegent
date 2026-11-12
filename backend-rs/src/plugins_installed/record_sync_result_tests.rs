// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#![cfg(test)]

use super::*;
use brz_mysql::MysqlError;
use serde_json::json;

#[test]
fn false_acks_copy_the_item_arrays_and_failure_message() {
    let ack = json!({
        "success": false,
        "scope": "all",
        "skills": [],
        "mcps": [],
        "errors": [],
        "plugins": [{
            "id": 267897,
            "name": "dingtalk",
            "status": "failed",
            "stage": "runtime_metadata",
            "error_code": "PLUGIN_RUNTIME_METADATA_FAILED",
            "retryable": false,
            "error": "path is outside the plugin directory"
        }]
    });
    let result = SyncResult::from_ack("electron-1", &ack);
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some(
            "Plugin dingtalk failed during runtime_metadata: path is outside the plugin directory"
        )
    );
    assert_eq!(result.scope, Value::Null);
    assert_eq!(
        result.response("replace")["results"][0]["scope"],
        Value::Null
    );
    let item = result.plugins[0].to_value();
    assert_eq!(item["server_name"], Value::Null);
    assert_eq!(item["id"], json!(267897));
}

#[test]
fn missing_success_is_not_a_rejection() {
    let result = SyncResult::from_ack("d", &json!({"scope": "plugins"}));
    assert!(result.success);
    assert!(result.error.is_none());
    assert_eq!(result.scope, json!("plugins"));
}

#[test]
fn non_object_acks_report_invalid_data() {
    let result = SyncResult::from_ack("d", &json!("nope"));
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Capability sync RPC returned invalid data")
    );
}

#[test]
fn response_errors_append_the_device_error_entry() {
    let mut result = SyncResult::from_ack("d", &json!({"success": false, "error": "boom"}));
    result
        .errors
        .push(json!({"device_id": "other", "error": "x"}));
    let response = result.response("replace");
    assert_eq!(response["synced"], json!(0));
    assert_eq!(response["failed"], json!(1));
    assert_eq!(response["errors"].as_array().unwrap().len(), 2);
    assert_eq!(response["results"].as_array().unwrap().len(), 1);
    assert_eq!(response["results"][0]["error"], json!("boom"));
}

#[test]
fn deferred_writes_follow_the_unit_of_work_order() {
    let mut flush = PendingFlush::default();
    flush.push_update(20, vec!["state='failed'".to_string()]);
    flush.push_delete(5);
    flush.push_insert(DesiredInsert {
        installed_kind_id: 1,
        user_id: 7,
        device_id: "d".into(),
        release_id: 2,
        state: "pending".into(),
        error_code: String::new(),
        error_message: String::new(),
        attempt_count: 0,
        now: Local::now().naive_local(),
    });
    flush.push_update(10, vec!["state='installed'".to_string()]);
    flush.writes.sort_by_key(|write| match write {
        PendingWrite::Update { id, .. } => (0_u8, *id),
        PendingWrite::Insert(_) => (1, 0),
        PendingWrite::Delete(id) => (2, *id),
    });
    let order: Vec<&str> = flush
        .writes
        .iter()
        .map(|write| match write {
            PendingWrite::Insert(_) => "insert",
            PendingWrite::Update { .. } => "update",
            PendingWrite::Delete(_) => "delete",
        })
        .collect();
    assert_eq!(order, vec!["update", "update", "insert", "delete"]);
}

#[tokio::test]
async fn updates_keep_the_source_primary_key_order() {
    // The installed list order is not the installation primary-key order;
    // the flush must still emit the smaller id first.
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let guard = FailingGuard::new(usize::MAX);
    let mut flush = PendingFlush::default();
    flush.push_update(9, vec!["state='failed'".to_string()]);
    flush.push_update(2, vec!["state='installed'".to_string()]);
    flush
        .flush_with_guard(&mut session, Some(&guard))
        .await
        .unwrap();
    let writes = capture.writes();
    assert_eq!(writes.len(), 2);
    assert!(
        writes[0].sql.contains("id = 2"),
        "smaller id first: {}",
        writes[0].sql
    );
    assert!(writes[1].sql.contains("id = 9"), "{}", writes[1].sql);
}

/// A guard that fails on the requested call.
struct FailingGuard {
    calls: std::sync::atomic::AtomicUsize,
    fail_on: usize,
}

impl FailingGuard {
    fn new(fail_on: usize) -> Self {
        Self {
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail_on,
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl crate::device_identity::LeaseCheck for FailingGuard {
    fn check<'a>(
        &'a self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = MysqlResult<()>> + Send + 'a>> {
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        Box::pin(async move {
            if call == self.fail_on {
                Err(MysqlError::InvalidQuery {
                    reason: "plugin_write_lease_lost".into(),
                })
            } else {
                Ok(())
            }
        })
    }
}

#[tokio::test]
async fn a_failed_record_flush_guard_emits_no_insert_delete_or_update() {
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let guard = FailingGuard::new(1);
    let mut flush = PendingFlush::default();
    flush.push_delete(5);
    flush.push_update(10, vec!["state='failed'".to_string()]);
    flush.push_insert(DesiredInsert {
        installed_kind_id: 1,
        user_id: 7,
        device_id: "d".into(),
        release_id: 2,
        state: "pending".into(),
        error_code: String::new(),
        error_message: String::new(),
        attempt_count: 0,
        now: Local::now().naive_local(),
    });
    let error = flush
        .flush_with_guard(&mut session, Some(&guard))
        .await
        .unwrap_err();
    assert!(matches!(error, MysqlError::InvalidQuery { .. }));
    assert_eq!(guard.calls(), 1, "one ownership check gates the flush");
    assert!(capture.writes().is_empty(), "a failed guard emits no write");
}

#[tokio::test]
async fn an_assigned_record_flush_checks_once_and_emits() {
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let guard = FailingGuard::new(usize::MAX);
    let mut flush = PendingFlush::default();
    // An equal-value assignment still marks the session dirty.
    flush.push_update(10, vec!["state='failed'".to_string()]);
    flush
        .flush_with_guard(&mut session, Some(&guard))
        .await
        .unwrap();
    assert_eq!(guard.calls(), 1);
    assert_eq!(capture.writes().len(), 1);
}

#[tokio::test]
async fn an_empty_record_flush_checks_and_emits_nothing() {
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let guard = FailingGuard::new(1);
    let mut flush = PendingFlush::default();
    flush
        .flush_with_guard(&mut session, Some(&guard))
        .await
        .unwrap();
    assert_eq!(guard.calls(), 0);
    assert!(capture.writes().is_empty());
}

#[test]
fn failure_state_uses_the_item_error_code() {
    let result = SyncResult::from_ack(
        "d",
        &json!({"success": false, "plugins": [{"id": 1, "status": "failed", "error": "x"}]}),
    );
    let item = result.plugins[0].clone();
    assert_eq!(
        device_install_state(&result, Some(&item)),
        ("failed", Some("x".to_string()))
    );
}

fn installation_row(
    state: &str,
    error_code: &str,
    error_message: &str,
    attempt_count: i64,
    now: NaiveDateTime,
) -> PluginDeviceInstallationRow {
    PluginDeviceInstallationRow {
        id: 14187,
        installed_kind_id: 2493402,
        user_id: 23,
        device_id: "90d4cd4b".into(),
        desired_release_id: 1,
        actual_release_id: 0,
        state: state.into(),
        error_code: error_code.into(),
        error_message: error_message.into(),
        attempt_count,
        last_sync_at: now,
        updated_at: now,
    }
}

#[test]
fn an_already_failed_removed_row_only_advances_its_retry_clock() {
    let now = NaiveDateTime::parse_from_str("2026-11-05 11:37:52.244784", "%Y-%m-%d %H:%M:%S%.6f")
        .unwrap();
    let message = "Plugin code-review failed: Capability package URL must match backend origin";
    let row = installation_row("failed", "PLUGIN_SYNC_FAILED", message, 42, now);
    let assigns = removed_failed_assignments(&row, message, now);
    assert_eq!(
        assigns,
        vec![
            "attempt_count=43".to_string(),
            format!("last_sync_at='{}'", format_datetime(now)),
            format!("updated_at='{}'", format_datetime(now)),
        ]
    );
}

#[test]
fn a_pending_removed_row_writes_the_changed_failure_columns() {
    let now = NaiveDateTime::parse_from_str("2026-11-05 11:37:52.244784", "%Y-%m-%d %H:%M:%S%.6f")
        .unwrap();
    let row = installation_row("pending", "", "", 0, now);
    let assigns = removed_failed_assignments(&row, "boom", now);
    assert!(assigns.contains(&"state='failed'".to_string()));
    assert!(assigns.contains(&"error_code='PLUGIN_SYNC_FAILED'".to_string()));
    assert!(assigns.contains(&"error_message='boom'".to_string()));
    assert!(assigns.contains(&"attempt_count=1".to_string()));
}

/// A closed-socket capability failure assigns the same empty text the loaded
/// row already carries, so the desired-install UPDATE stays clean.
#[test]
fn a_closed_socket_failure_leaves_the_desired_install_message_clean() {
    let result = SyncResult::failure("d", None, "");
    let (state, message) = device_install_state(&result, None);
    assert_eq!(state, "failed");
    assert_eq!(message.as_deref(), Some(""));
    assert_eq!(
        desired_install_error_message_assignment("", &message.unwrap_or_default()),
        None
    );
}

/// A genuine message change still flushes the column.
#[test]
fn a_changed_desired_install_message_is_flushed() {
    assert_eq!(
        desired_install_error_message_assignment("", "Device rejected plugin removal"),
        Some("error_message='Device rejected plugin removal'".to_string())
    );
}

/// The removed branch keeps flushing its rejection message.
#[test]
fn a_removed_rejection_message_is_still_flushed() {
    let now = NaiveDateTime::parse_from_str("2026-11-05 11:37:52.244784", "%Y-%m-%d %H:%M:%S%.6f")
        .unwrap();
    let row = installation_row("pending", "", "", 0, now);
    let assigns = removed_failed_assignments(&row, "Device rejected plugin removal", now);
    assert!(assigns.contains(&"error_message='Device rejected plugin removal'".to_string()));
}

/// A versioned record runs the source's `acquire_plugin_write_lock` reentrant
/// checks: before the alias reconciliation rows, before the recording
/// transaction's second state read, and before the watermark assignment's
/// flush. The outer policy read and the commit check belong to the caller.
#[tokio::test]
async fn a_versioned_record_checks_the_lease_at_each_source_boundary() {
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let guard = FailingGuard::new(usize::MAX);
    let snapshot = json!({
        "mode": "replace",
        "skills": [],
        "mcps": [],
        "plugins": [],
        "plugin_sync": {"version": 2, "generation": 163, "complete": true},
    });
    let result = SyncResult {
        scope: Value::Null,
        plugin_sync: Some(json!({"version": 2, "generation": 163, "complete": true})),
        desired_plugin_snapshot: Some(snapshot),
        device_id: "app-record-273921".into(),
        success: true,
        acknowledged: true,
        error: None,
        skills: Vec::new(),
        plugins: Vec::new(),
        mcps: Vec::new(),
        errors: Vec::new(),
    };
    record_device_sync_result(&mut session, 203, &result, Some(&guard))
        .await
        .expect("the recording completes");
    assert_eq!(guard.calls(), 3, "reconcile, second lock, before-flush");
    let queries = capture.queries();
    assert!(
        queries[0].sql.contains("plugin_states"),
        "the first state read precedes reconciliation: {queries:#?}"
    );
    assert!(
        queries
            .iter()
            .any(|query| query.sql.contains("plugin_device_installations")),
        "the reconciliation rows are read: {queries:#?}"
    );
}

/// A legacy record has exactly one acquire check: the reconciliation's, which
/// the caller already ran. Adding an entry check here would consume the
/// recorded `before_commit` reply and strand the commit check.
#[tokio::test]
async fn a_legacy_record_adds_no_entry_check_before_reconciliation() {
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let guard = FailingGuard::new(usize::MAX);
    let result = SyncResult::failure(
        "app-record-273921",
        None,
        "Capability package URL must match backend origin",
    );
    record_device_sync_result(&mut session, 203, &result, Some(&guard))
        .await
        .expect("the recording completes");
    assert_eq!(
        guard.calls(),
        0,
        "the caller's acquire check covers the legacy record"
    );
    assert!(
        !capture
            .queries()
            .iter()
            .any(|query| query.sql.contains("PluginSyncState")),
        "a legacy record never reads the versioned state"
    );
}
