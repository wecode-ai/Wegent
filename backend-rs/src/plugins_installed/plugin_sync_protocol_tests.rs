// SPDX-License-Identifier: Apache-2.0

#[tokio::test(start_paused = true)]
async fn snapshot_and_intent_work_share_the_same_bounded_budget() {
    let start = tokio::time::Instant::now();
    let result =
        super::with_sync_write_budget(std::future::pending::<brz_mysql::MysqlResult<()>>()).await;
    assert_eq!(
        super::super::write_coordination::plugin_write_error_code(&result.unwrap_err()),
        Some("plugin_write_busy")
    );
    assert_eq!(start.elapsed(), std::time::Duration::from_secs(20));
    let result =
        super::with_sync_write_budget(std::future::pending::<Result<(), super::BuildError>>())
            .await;
    let super::BuildError::Mysql(error) = result.unwrap_err() else {
        panic!("snapshot timeout must retain the coordination error");
    };
    assert_eq!(
        super::super::write_coordination::plugin_write_error_code(&error),
        Some("plugin_write_busy")
    );
    assert_eq!(start.elapsed(), std::time::Duration::from_secs(40));
}

#[tokio::test]
async fn local_snapshot_survives_more_than_two_concurrent_metadata_writers() {
    let mut attempts = 0;
    let result = super::retry_sync_write(super::SNAPSHOT_WRITE_ATTEMPTS, || {
        attempts += 1;
        std::future::ready(if attempts <= 3 {
            Err(super::coordination_error("plugin_write_conflict"))
        } else {
            Ok(17)
        })
    })
    .await
    .unwrap();
    assert_eq!(attempts, 4);
    assert_eq!(result, 17);
}

use std::sync::{Arc, Mutex};

use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};
use serde_json::json;

use super::*;

/// Record one transaction's statements in call order.
#[derive(Clone, Default)]
struct RecordingTransaction {
    statements: Arc<Mutex<Vec<String>>>,
}

impl RecordingTransaction {
    fn statements(&self) -> Vec<String> {
        self.statements.lock().unwrap().clone()
    }

    fn record(&self, sql: &str) {
        self.statements
            .lock()
            .unwrap()
            .push(sql.split_whitespace().collect::<Vec<_>>().join(" "));
    }
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        self.record(sql.as_ref());
        Ok(MysqlExecution {
            rows_affected: 1,
            last_insert_id: 2460258,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql.as_ref());
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql.as_ref());
        panic!("the versioned build reads no single row")
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
        futures_util::stream::empty()
    }

    async fn fetch_all<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql.as_ref());
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn the_versioned_build_reads_plugin_sync_state_before_the_installed_skill() {
    let mut transaction = RecordingTransaction::default();
    let mut query = &mut transaction;
    let snapshot = build_versioned_snapshot(&mut query, 203, "app-record-273921", true, None)
        .await
        .expect("the versioned snapshot builds");
    assert_eq!(snapshot.generation, 1);
    assert!(snapshot.payload.get("plugin_sync").is_none());
    let statements = transaction.statements();
    assert_eq!(statements.len(), 8, "{statements:#?}");
    assert!(
        statements[0].contains("FROM plugin_states"),
        "{statements:#?}"
    );
    assert!(
        statements[4].contains("kinds.kind = 'InstalledSkill'"),
        "{statements:#?}"
    );
    assert!(
        statements[5].contains("kinds.kind = 'InstalledPlugin'"),
        "{statements:#?}"
    );
    assert!(
        statements[6].contains("kinds.kind = 'InstalledMCP'"),
        "{statements:#?}"
    );
    assert!(
        statements[7].starts_with("INSERT INTO plugin_states"),
        "{statements:#?}"
    );
}

#[test]
fn only_an_integer_protocol_version_selects_the_versioned_protocol() {
    assert!(supports_plugin_sync_v2(Some(
        &json!({"pluginSync": {"protocolVersion": 2}})
    )));
    assert!(!supports_plugin_sync_v2(Some(
        &json!({"pluginSync": {"protocolVersion": 1}})
    )));
    assert!(!supports_plugin_sync_v2(Some(
        &json!({"pluginSync": {"protocolVersion": 2.0}})
    )));
    assert!(!supports_plugin_sync_v2(Some(
        &json!({"pluginSync": {"protocolVersion": "2"}})
    )));
    assert!(!supports_plugin_sync_v2(Some(&json!({}))));
    assert!(!supports_plugin_sync_v2(None));
}

#[test]
fn generations_follow_the_source_integer_rules() {
    assert_eq!(next_generation(&json!({"spec": {"generation": 162}})), 163);
    assert_eq!(next_generation(&json!({"spec": {}})), 1);
    assert_eq!(next_generation(&json!({})), 1);
    assert_eq!(next_generation(&json!({"spec": {"generation": -4}})), 1);
    assert_eq!(next_generation(&json!({"spec": {"generation": 2.0}})), 1);
}

#[test]
fn the_watermark_keeps_the_highest_complete_or_per_plugin_generation() {
    let mut document = json!({"spec": {"generation": 163}});
    advance_plugin_snapshot_watermark(&mut document, "app-record-1", 163, true, &[]);
    assert_eq!(document["spec"]["generation"], json!(163));
    assert_eq!(
        document["spec"]["devices"]["app-record-1"]["complete_generation"],
        json!(163)
    );
    assert_eq!(plugin_snapshot_watermark(&document, "app-record-1", 7), 163);
    advance_plugin_snapshot_watermark(&mut document, "app-record-1", 164, false, &[7]);
    assert_eq!(document["spec"]["generation"], json!(164));
    assert_eq!(
        document["spec"]["devices"]["app-record-1"]["plugins"]["7"],
        json!(164)
    );
    assert_eq!(plugin_snapshot_watermark(&document, "app-record-1", 7), 164);
    assert_eq!(plugin_snapshot_watermark(&document, "app-record-2", 7), 0);
}

#[test]
fn the_sync_metadata_matches_the_source_shape() {
    assert_eq!(
        plugin_sync_metadata(163, true),
        json!({"version": 2, "generation": 163, "complete": true})
    );
}

#[test]
fn ack_validation_accepts_the_recorded_generation() {
    let payload = json!({
        "mode": "replace",
        "skills": [],
        "mcps": [],
        "plugins": [],
        "plugin_sync": {"version": 2, "generation": 163, "complete": true},
    });
    let ack = json!({
        "success": true,
        "changed": false,
        "requires_restart": false,
        "scope": "all",
        "skills": [],
        "plugins": [],
        "plugin_sync": {"version": 2, "generation": 163, "complete": true},
    });
    assert_eq!(validate_plugin_ack(&payload, &ack), None);
}

#[test]
fn ack_validation_rejects_mismatched_or_obsolete_acknowledgements() {
    let payload = json!({
        "plugin_sync": {"version": 2, "generation": 163, "complete": true},
        "plugins": [{"installed_plugin_id": 7, "version": "1.0.0", "checksum": "sha256:a"}],
    });
    let base = json!({
        "success": true,
        "scope": "all",
        "plugin_sync": {"version": 2, "generation": 163, "complete": true},
        "plugins": [{"id": 7, "operation": "upsert", "status": "synced", "generation": 163,
                     "version": "1.0.0", "checksum": "sha256:a"}],
    });
    assert_eq!(validate_plugin_ack(&payload, &base), None);

    let mut obsolete = base.clone();
    obsolete["plugins"][0]["generation"] = json!(162);
    assert_eq!(
        validate_plugin_ack(&payload, &obsolete),
        Some("Device returned an obsolete plugin acknowledgement")
    );

    let mut missing = base.clone();
    missing["plugins"] = json!([]);
    assert_eq!(
        validate_plugin_ack(&payload, &missing),
        Some("Device did not acknowledge every requested plugin")
    );

    let mut mismatched = base.clone();
    mismatched["plugin_sync"]["generation"] = json!(164);
    assert_eq!(
        validate_plugin_ack(&payload, &mismatched),
        Some("Device returned a mismatched plugin snapshot acknowledgement")
    );

    let mut bad_operation = base;
    bad_operation["plugins"][0]["operation"] = json!("remove");
    assert_eq!(
        validate_plugin_ack(&payload, &bad_operation),
        Some("Device returned a mismatched plugin operation")
    );
}
