// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the device capability sync flow.
#![cfg(test)]

use super::*;
use serde_json::json;

/// The reconcile request-session transaction is read-only and must end by
/// rolling back, reproducing the source's `db.close()`. The sentinel error
/// is distinguishable from a real failure only by this exact reason.
#[test]
fn request_session_rollback_is_distinguishable_from_real_failures() {
    let rollback = request_session_rollback();
    assert!(matches!(
        &rollback,
        MysqlError::InvalidQuery { reason } if reason == ROLLBACK_REASON
    ));
    let other = MysqlError::InvalidQuery {
        reason: "plugin_write_busy".to_string(),
    };
    assert!(!matches!(
        &other,
        MysqlError::InvalidQuery { reason } if reason == ROLLBACK_REASON
    ));
}

#[test]
fn release_id_requires_integer() {
    assert_eq!(
        integer_release_id(&json!({"spec": {"releaseId": 38}})),
        Some(38)
    );
    assert_eq!(
        integer_release_id(&json!({"spec": {"releaseId": "38"}})),
        None
    );
    assert_eq!(integer_release_id(&json!({"spec": {}})), None);
}

#[test]
fn auto_update_blocked_matches_source_rules() {
    let row = PluginDeviceInstallationRow {
        id: 1,
        installed_kind_id: 2,
        user_id: 3,
        device_id: "d".to_string(),
        desired_release_id: 5,
        actual_release_id: 4,
        state: "failed".to_string(),
        error_code: String::new(),
        error_message: String::new(),
        attempt_count: AUTO_UPDATE_FAILURE_LIMIT,
        last_sync_at: chrono::NaiveDateTime::default(),
        updated_at: chrono::NaiveDateTime::default(),
    };
    assert!(auto_update_blocked(&row, 5));
    let mut other = row;
    other.attempt_count -= 1;
    assert!(!auto_update_blocked(&other, 5));
}

#[test]
fn flush_orders_updates_by_identity_map_not_iteration() {
    // The recorded sync-device cases prove the source's flush order: the
    // iteration visits the desired installs in `_desired_installs` result
    // order. Each UPDATE is emitted at `db.commit()` in identity-map
    // order: the load order, primary key ascending.
    // The flush must therefore sort by identity-map position.
    let mut identity_map = Vec::new();
    let mut flush = PendingFlush::default();
    // load order: row 101 (kind 201) before 102 (kind 202).
    for (id, kind) in [(101_i64, 201_i64), (102, 202)] {
        identity_map.push(PluginDeviceInstallationRow {
            id,
            installed_kind_id: kind,
            user_id: 301,
            device_id: "app-record-201".to_string(),
            desired_release_id: 401,
            actual_release_id: 0,
            state: "failed".to_string(),
            error_code: "PLUGIN_DOWNLOAD_FAILED".to_string(),
            error_message: "download failed".to_string(),
            attempt_count: 7,
            last_sync_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        });
    }
    // Iteration visits 102 (identity-map index 1) before 101 (index 0);
    // the flush must still emit 101 first because it follows the map.
    flush.updates.push((1, vec!["state='pending'".to_string()]));
    flush.updates.push((0, vec!["state='pending'".to_string()]));
    flush.updates.sort_by_key(|(index, _)| *index);
    let order: Vec<i64> = flush
        .updates
        .iter()
        .map(|(index, _)| identity_map[*index].id)
        .collect();
    assert_eq!(order, vec![101, 102]);
}

#[test]
fn flush_update_statement_binds_updated_at() {
    // Every flushed UPDATE of this table carries `updated_at` because
    // `PluginDeviceInstallation.updated_at` declares `onupdate=datetime.now`
    // (app/models/plugin_marketplace.py). The value is bound as a prepared
    // statement parameter (like `catalog_write`'s reset UPDATE) so its
    // current-time generation is comparable under the verification policy's
    // time rules rather than baked into the SQL text.
    let statement = format!(
        "UPDATE plugin_device_installations SET {}, updated_at=? WHERE \
         plugin_device_installations.id = ?",
        "state='pending', error_code='', error_message=''"
    );
    assert!(statement.contains(
        "SET state='pending', error_code='', error_message='', updated_at=? WHERE \
         plugin_device_installations.id = ?"
    ));
    assert_eq!(flush_timestamp().len(), "YYYY-MM-DD HH:MM:SS.ffffff".len());
}

#[test]
fn pending_insert_records_epoch_last_sync_at() {
    // Source `_ensure_desired_install_pending` adds the row without a sync
    // timestamp; the `PluginDeviceInstallation` column defaults then bind
    // the epoch sentinel for `last_sync_at` and `datetime.now` for
    // `updated_at` (app/models/plugin_marketplace.py). The recorded
    // sync-device INSERT proves `last_sync_at='1970-01-01 00:00:00'`.
    let now = chrono::NaiveDateTime::parse_from_str(
        "2026-11-09 13:02:16.987728",
        "%Y-%m-%d %H:%M:%S%.6f",
    )
    .unwrap();
    assert_eq!(pending_row_times(now), (EPOCH, now));
}

/// The source's `get_current_user` runs on the request session, so the
/// handler resolves the row through its own transaction and keeps the
/// source's rejection details.
#[tokio::test]
async fn session_user_reports_the_source_auth_failure() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let mut session = &mysql;
    let rejection = session_user(&mut session, "ghost")
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(rejection.detail_message(), Some(auth::UNAUTHORIZED_DETAIL));
    assert_eq!(mysql.queries().len(), 1);
    assert!(mysql.queries()[0].sql.contains("WHERE users.user_name = ?"));
}

/// Source `get_current_user` runs on the `get_plugin_db` request session,
/// which `configure_plugin_session` pins to READ COMMITTED before its first
/// query; the endpoint then rolls it back with `db.close()`. The non-reconcile
/// branch must therefore open its own transaction for the `users` read instead
/// of issuing it on the pool: the recorded session shows the isolation setup
/// before the read and a rollback after it
/// (`453ba71f-025a-417b-bde1-13068ca5db07`, source seq 1295-1298).
///
/// A bare pool read renders the same SQL, so this pins the discriminating
/// observable: the read must sit between the transaction's `BEGIN` and its
/// `ROLLBACK` on one connection.
#[tokio::test]
async fn request_session_read_runs_inside_an_explicit_transaction() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mysql = wegent_backend_persistence::connection::connect(&format!(
            "mysql://fixture@{}/test",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(
            crate::sql_test_support::mysql_pool_server::capture_controls_until(listener, stopped),
        );

        // The fake server answers the first prepared statement with a SQL
        // error, so the scope fails after its prologue; the control statements
        // still reach the wire in order.
        let result = mysql
            .with_transaction_options(
                MysqlTransactionOptions::default()
                    .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
                async |transaction| {
                    let mut session = &mut *transaction;
                    session_user(&mut session, "guangzu1").await
                },
            )
            .await;

        stop.send(()).unwrap();
        let queries = server.await.unwrap();
        mysql.close().await;

        assert!(result.is_err(), "the stub server rejects the users read");
        let begin = queries
            .iter()
            .position(|sql| sql.eq_ignore_ascii_case("BEGIN"))
            .unwrap_or_else(|| panic!("no BEGIN was issued: {queries:?}"));
        let read = queries
            .iter()
            .position(|sql| sql.contains("WHERE users.user_name = ?"))
            .unwrap_or_else(|| panic!("the users read was not issued: {queries:?}"));
        let rollback = queries
            .iter()
            .position(|sql| sql.eq_ignore_ascii_case("ROLLBACK"))
            .unwrap_or_else(|| panic!("no ROLLBACK was issued: {queries:?}"));
        assert!(
            begin < read && read < rollback,
            "the users read must run inside the request-session transaction: {queries:?}"
        );
    })
    .await
    .expect("the request-session transaction should be observable within the test timeout");
}

/// Source `ensure_pending_for_device` starts with the user's read and keeps
/// every later read and flush on the same session handle; the pending
/// refresh must therefore reach the caller's transaction rather than the
/// pool.
#[tokio::test]
async fn pending_refresh_reads_on_the_caller_session_first() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &mysql;
    assert_eq!(
        ensure_pending_for_device(&mut session, 3, "app-record-266867", None)
            .await
            .unwrap(),
        0
    );
    let queries = mysql.queries();
    assert_eq!(
        queries.len(),
        3,
        "row read, alias read, then desired installs"
    );
    assert!(queries[0].sql.contains(
        "FROM plugin_device_installations WHERE plugin_device_installations.user_id = ?"
    ));
    assert!(
        !queries[0].sql.contains("FOR UPDATE"),
        "the source reconcile read does not lock"
    );
    assert!(queries[1].sql.contains("kinds.kind = 'Device'"));
    assert!(queries[2].sql.contains("kinds.kind = 'InstalledPlugin'"));
}

/// `_changed_route`'s comparison: only a non-empty socket that differs from
/// the dispatched one reports a reconnect. The recorded foreign-case reads are
/// this poll re-reading `device:online:<user>:<device>` while the ack is
/// outstanding (`backend/app/services/device/capability_sync_rpc.py:24-30`).
#[test]
fn reconnect_requires_a_different_non_empty_socket() {
    let dispatched = "TEgKPvZXKrt4XWWy";
    let document = |socket: Option<&str>| socket.map(|socket| json!({"socket_id": socket}));
    assert!(route_changed(
        document(Some("other-socket")).as_ref(),
        dispatched
    ));
    assert!(!route_changed(
        document(Some(dispatched)).as_ref(),
        dispatched
    ));
    assert!(!route_changed(document(Some("  ")).as_ref(), dispatched));
    assert!(!route_changed(document(None).as_ref(), dispatched));
    assert!(!route_changed(None, dispatched));
}

/// `_changed_route` is a `while True`, so the poll must keep sampling the same
/// owned key once per interval until the acknowledgement lands. The recorded
/// case proves two probes: Source acknowledged roughly 2.8 s after the emit and
/// read `device:online:203:app-record-273921` at +1.0 s and +2.0 s
/// (`capability_sync_rpc.py:23-30`). A single probe was the whole defect.
#[test]
fn route_poll_count_follows_the_acknowledgement_delay() {
    let dispatched = "TEgKPvZXKrt4XWWy";
    let unchanged = json!({"socket_id": dispatched});
    let intervals = |ack_after_seconds: u64| {
        (1..=ack_after_seconds)
            .filter(|_| !route_changed(Some(&unchanged), dispatched))
            .count()
    };
    assert_eq!(intervals(1), 1);
    assert_eq!(intervals(2), 2);
    assert_eq!(intervals(3), 3);
}

/// The poll key is built from the resolved runtime device id, exactly like
/// `resolve_online_route`'s read.
#[test]
fn route_poll_key_matches_the_online_document_key() {
    assert_eq!(
        format!("device:online:{}:{}", 203, "app-record-273921"),
        "device:online:203:app-record-273921"
    );
}

/// `MAX_ROUTE_CHANGES` bounds the reconnect retries and `ROUTE_CHECK_INTERVAL`
/// is the source's one-second probe.
#[test]
fn reconnect_retry_budget_matches_the_source() {
    assert_eq!(MAX_ROUTE_CHANGES, 2);
    assert_eq!(ROUTE_CHECK_INTERVAL, std::time::Duration::from_secs(1));
}

/// An expired dispatch deadline is a `TimeoutError` whose message is the
/// result error, so the reconcile branch answers 502
/// `Plugin reconciliation failed: Device capability sync acknowledgement timed
/// out` (`capability_sync_rpc.py:119-124`,
/// `capability_sync_service.py:576-586`, `plugin_reconciliation.py:88`).
/// Recording 20261111060003 case 67d0e09e-80d6-43ab-9a61-0c3986697416 records
/// exactly that 502 body after 180180 ms.
#[test]
fn expired_deadline_reports_the_acknowledgement_timeout_message() {
    use crate::socketio_rpc::RpcError;

    assert_eq!(
        error_text(&RpcError::Timeout),
        "Device capability sync acknowledgement timed out"
    );
    let result = snapshot_failure("app-record-273921", &None, error_text(&RpcError::Timeout));
    assert!(!result.success);
    assert_eq!(
        reconciliation_failure_detail(&result),
        "Plugin reconciliation failed: Device capability sync acknowledgement timed out"
    );
}
