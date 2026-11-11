#![cfg(test)]

use super::*;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult};
use std::sync::{Arc, Mutex};

/// The registration read and write must reach one transaction handle; a
/// second handle would commit the read before the write, which the source
/// never does.
#[derive(Clone, Default)]
struct RecordingTransaction {
    statements: Arc<Mutex<Vec<String>>>,
}

impl RecordingTransaction {
    fn record(&self, sql: &str) {
        self.statements
            .lock()
            .unwrap()
            .push(sql.split_whitespace().collect::<Vec<_>>().join(" "));
    }

    fn statements(&self) -> Vec<String> {
        self.statements.lock().unwrap().clone()
    }
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        self.record(sql.as_ref());
        let last_insert_id = if sql.as_ref().starts_with("INSERT INTO kinds") {
            // MySQL returns the auto-increment id of the new Device row.
            77
        } else {
            0
        };
        Ok(MysqlExecution {
            rows_affected: 1,
            last_insert_id,
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

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("registration never fetches exactly one row")
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

fn payload() -> RegisterPayload {
    RegisterPayload {
        device_id: "b549ace3".into(),
        name: "executor".into(),
        client_ip: Some("127.0.0.1".into()),
        ..RegisterPayload::default()
    }
}

#[tokio::test]
async fn registration_reads_and_writes_on_the_same_transaction() {
    let mut transaction = RecordingTransaction::default();
    let outcome = upsert_registration(&mut transaction, 329, &payload(), None, Some("127.0.0.1"))
        .await
        .expect("transaction");
    // The committed row id comes from the real `last_insert_id`.
    assert!(outcome >= 0);
    let statements = transaction.statements();
    assert_eq!(statements.len(), 4, "{statements:?}");
    // `lock_device_owner` first: the owner row lock must cover the write.
    assert!(
        statements[0].starts_with("SELECT users.id AS users_id"),
        "{statements:?}"
    );
    assert!(
        statements[0].ends_with("LIMIT 1 FOR UPDATE"),
        "{statements:?}"
    );
    // The owned-device read is ordered by primary key and takes no Kind lock.
    assert!(
        statements[1].starts_with("SELECT kinds.id AS kinds_id"),
        "{statements:?}"
    );
    assert!(
        statements[1].ends_with("ORDER BY kinds.id"),
        "{statements:?}"
    );
    assert!(!statements[1].contains("FOR UPDATE"), "{statements:?}");
    // The create branch's `isDefault` scan runs before the insert.
    assert!(
        statements[2].contains("kinds.is_active = true"),
        "{statements:?}"
    );
    assert!(
        statements[2].ends_with("AND kinds.is_active = true"),
        "{statements:?}"
    );
    assert!(
        statements[3].starts_with("INSERT INTO kinds"),
        "{statements:?}"
    );
}

fn device_row(id: i64, json: Value, is_active: i8) -> DeviceKindRow {
    DeviceKindRow {
        id,
        name: "local-device".into(),
        json,
        is_active,
    }
}

fn device_json(device_type: Option<&str>, runtime: Option<&str>, app: Option<&str>) -> Value {
    let mut spec = serde_json::json!({});
    if let Some(device_type) = device_type {
        spec["deviceType"] = Value::String(device_type.into());
    }
    if let Some(runtime) = runtime {
        spec["runtimeInstanceId"] = Value::String(runtime.into());
    }
    if let Some(app) = app {
        spec["appDeviceId"] = Value::String(app.into());
    }
    serde_json::json!({"spec": spec})
}

#[test]
fn selection_prefers_the_exact_runtime_and_app_installation() {
    let rows = vec![
        device_row(
            2,
            device_json(Some("app"), Some("runtime-a"), Some("app-a")),
            0,
        ),
        device_row(
            3,
            device_json(Some("app"), Some("runtime-b"), Some("app-b")),
            1,
        ),
    ];
    let selected = select_registration_device(
        &rows,
        "local-device",
        Some("runtime-a"),
        Some("app-a"),
        DeviceType::App,
    )
    .expect("no conflict")
    .expect("an exact match");
    assert_eq!(selected.id, 2, "inactive exact rows are still reused");
}

#[test]
fn selection_keeps_another_app_installation_on_its_own_route() {
    let rows = vec![device_row(
        2,
        device_json(Some("app"), Some("runtime-a"), Some("app-a")),
        1,
    )];
    let selected = select_registration_device(
        &rows,
        "local-device",
        Some("runtime-b"),
        Some("app-b"),
        DeviceType::App,
    )
    .expect("no conflict");
    assert!(
        selected.is_none(),
        "a different installation does not reuse the row"
    );
}

#[test]
fn selection_rejects_two_active_rows_as_ambiguous() {
    let rows = vec![
        device_row(2, device_json(Some("local"), None, None), 1),
        device_row(3, device_json(Some("local"), None, None), 1),
    ];
    let error = select_registration_device(&rows, "local-device", None, None, DeviceType::Local)
        .expect_err("two active rows are ambiguous");
    assert!(
        error.starts_with("Ambiguous device identity local-device"),
        "{error}"
    );
}

#[test]
fn selection_disambiguates_inactive_duplicates_by_runtime() {
    let rows = vec![
        device_row(2, device_json(Some("local"), Some("runtime-a"), None), 0),
        device_row(3, device_json(Some("local"), Some("runtime-b"), None), 0),
    ];
    let selected = select_registration_device(
        &rows,
        "local-device",
        Some("runtime-b"),
        None,
        DeviceType::Local,
    )
    .expect("no conflict")
    .expect("the single matching runtime");
    assert_eq!(selected.id, 3);
    let error = select_registration_device(
        &rows,
        "local-device",
        Some("runtime-c"),
        None,
        DeviceType::Local,
    )
    .expect_err("no single runtime matches");
    assert!(
        error.starts_with("Ambiguous inactive device identity local-device"),
        "{error}"
    );
}

#[test]
fn create_marks_default_only_without_an_active_local_device() {
    let payload = RegisterPayload {
        device_id: "local-device".into(),
        name: "executor".into(),
        ..RegisterPayload::default()
    };
    let json: Value =
        serde_json::from_str(&create_device_json(&payload, None, Some("127.0.0.1"), true))
            .expect("json");
    assert_eq!(json["spec"]["isDefault"], true);
    // The spec always carries the source's keys; absent values are null.
    for key in [
        "deviceId",
        "deviceType",
        "connectionMode",
        "bindShell",
        "isDefault",
        "capabilities",
        "clientIp",
        "runtimeTransferHost",
        "runtimeInstanceId",
        "appDeviceId",
        "runtimeTransferPort",
        "displayName",
    ] {
        assert!(json["spec"].get(key).is_some(), "missing spec.{key}");
    }
    assert_eq!(json["spec"]["capabilities"], Value::Null);
    assert_eq!(json["spec"]["deviceId"], "local-device");
    assert_eq!(json["metadata"]["displayName"], "executor");
}

#[test]
fn the_persisted_client_ip_is_the_observed_peer() {
    // Observed peer A (session) vs executor-reported B: `spec.clientIp` is A,
    // while `runtimeTransferHost` keeps the `reported host or client_ip` rule.
    let payload = RegisterPayload {
        device_id: "local-device".into(),
        name: "executor".into(),
        client_ip: Some("192.0.2.9".into()),
        ..RegisterPayload::default()
    };
    let json: Value = serde_json::from_str(&create_device_json(
        &payload,
        Some("192.0.2.9"),
        Some("127.0.0.1"),
        false,
    ))
    .expect("json");
    assert_eq!(json["spec"]["clientIp"], "127.0.0.1");
    assert_eq!(json["spec"]["runtimeTransferHost"], "192.0.2.9");
    let json: Value = serde_json::from_str(
        &updated_device_json(
            device_json(Some("local"), None, None),
            &payload,
            Some("192.0.2.9"),
            Some("127.0.0.1"),
        )
        .expect("updated json"),
    )
    .expect("json");
    assert_eq!(json["spec"]["clientIp"], "127.0.0.1");
    assert_eq!(json["spec"]["runtimeTransferHost"], "192.0.2.9");
}

#[test]
fn a_missing_observed_peer_writes_null_and_keeps_the_stored_value() {
    let payload = RegisterPayload {
        device_id: "local-device".into(),
        name: "executor".into(),
        client_ip: Some("192.0.2.9".into()),
        ..RegisterPayload::default()
    };
    // CREATE persists the source's explicit null when the peer is unknown.
    let json: Value =
        serde_json::from_str(&create_device_json(&payload, None, None, false)).expect("json");
    assert_eq!(json["spec"]["clientIp"], Value::Null);
    // UPDATE writes `spec.clientIp` only when the connection peer is known.
    let mut stored = device_json(Some("local"), None, None);
    stored["spec"]["clientIp"] = Value::String("127.0.0.1".into());
    let json: Value = serde_json::from_str(
        &updated_device_json(stored, &payload, None, None).expect("updated json"),
    )
    .expect("json");
    assert_eq!(json["spec"]["clientIp"], "127.0.0.1");
}

#[test]
fn create_counts_missing_device_types_as_local() {
    assert!(is_local_device(&device_json(None, None, None)));
    assert!(is_local_device(&device_json(Some("local"), None, None)));
    assert!(!is_local_device(&device_json(Some("app"), None, None)));
}

#[test]
fn update_keeps_the_persisted_display_name_alias() {
    let payload = RegisterPayload {
        device_id: "local-device".into(),
        name: "reported-name".into(),
        ..RegisterPayload::default()
    };
    let json: Value = serde_json::from_str(
        &updated_device_json(
            device_json(Some("local"), None, None),
            &payload,
            None,
            Some("127.0.0.1"),
        )
        .expect("updated json"),
    )
    .expect("json");
    // No persisted alias → the reported name is written.
    assert_eq!(json["spec"]["displayName"], "reported-name");
    let mut stored = device_json(Some("local"), None, None);
    stored["spec"]["displayName"] = Value::String("kept-alias".into());
    let json: Value = serde_json::from_str(
        &updated_device_json(stored, &payload, None, Some("127.0.0.1")).expect("updated json"),
    )
    .expect("json");
    assert_eq!(json["spec"]["displayName"], "kept-alias");
    assert_eq!(json["metadata"]["displayName"], "kept-alias");
}

#[test]
fn an_inactive_row_is_reactivated_only_by_the_reactivation_update() {
    // SQLAlchemy only adds `is_active` to the SET list when the assignment
    // changes the value, so the active profile stays untouched. Both profiles
    // bind the `upsert_device_crd` client-side `updated_at` rather than the
    // model's `onupdate` database clock.
    assert_eq!(
        device_update_query(false),
        "UPDATE kinds SET json=?, updated_at=? WHERE kinds.id = ?"
    );
    assert!(!device_update_query(false).contains("is_active"));
    assert_eq!(
        device_update_query(true),
        "UPDATE kinds SET json=?, is_active=1, updated_at=? WHERE kinds.id = ?"
    );
    assert!(device_update_query(true).ends_with("WHERE kinds.id = ?"));
    // The cloud match only marks `json` dirty, so its flush keeps the ORM
    // `onupdate` clock.
    assert_eq!(
        UPDATE_DEVICE_JSON_QUERY,
        "UPDATE kinds SET json=?, updated_at=now() WHERE kinds.id = ?"
    );
}

#[test]
fn registration_rejects_identity_inputs_before_the_owner_lock() {
    // `upsert_device` rejects these before opening the transaction, so no
    // owner lock or Device read can run first.
    let blank = RegisterPayload {
        device_id: "   ".into(),
        ..RegisterPayload::default()
    };
    assert_eq!(
        pre_transaction_rejection(&blank).as_deref(),
        Some("Device ID is required for registration")
    );
    let app_without_runtime = RegisterPayload {
        device_id: "local-device".into(),
        device_type: DeviceType::App,
        runtime_instance_id: Some("  ".into()),
        ..RegisterPayload::default()
    };
    assert_eq!(
        pre_transaction_rejection(&app_without_runtime).as_deref(),
        Some("App registration requires a persistent Runtime ID")
    );
    let reserved = RegisterPayload {
        device_id: "app-record-9".into(),
        ..RegisterPayload::default()
    };
    assert_eq!(
        pre_transaction_rejection(&reserved).as_deref(),
        Some("Device ID uses a reserved routing prefix")
    );
    assert!(pre_transaction_rejection(&payload()).is_none());
}

#[test]
fn update_overrides_bind_shell_and_keeps_persisted_capabilities() {
    let payload = RegisterPayload {
        device_id: "local-device".into(),
        name: "executor".into(),
        bind_shell: super::super::device::BindShell::Openclaw,
        capabilities: Some(serde_json::json!(["reported"])),
        ..RegisterPayload::default()
    };
    let mut stored = device_json(Some("local"), None, None);
    stored["spec"]["bindShell"] = Value::String("claudecode".into());
    stored["spec"]["capabilities"] = serde_json::json!(["persisted"]);
    let json: Value = serde_json::from_str(
        &updated_device_json(stored, &payload, None, Some("127.0.0.1")).expect("updated json"),
    )
    .expect("json");
    // A provided binding overrides; the socket path never writes the
    // reported capabilities, so the persisted caps stay.
    assert_eq!(json["spec"]["bindShell"], "openclaw");
    assert_eq!(
        json["spec"]["capabilities"],
        serde_json::json!(["persisted"])
    );
}

#[test]
fn update_writes_the_resolved_transfer_port() {
    let payload = RegisterPayload {
        device_id: "local-device".into(),
        name: "executor".into(),
        runtime_transfer_port: Some(17888),
        runtime_transfer_port_set: true,
        ..RegisterPayload::default()
    };
    let json: Value = serde_json::from_str(
        &updated_device_json(
            device_json(Some("local"), None, None),
            &payload,
            None,
            Some("127.0.0.1"),
        )
        .expect("updated json"),
    )
    .expect("json");
    assert_eq!(json["spec"]["runtimeTransferPort"], 17888);
    let default_payload = RegisterPayload {
        device_id: "local-device".into(),
        name: "executor".into(),
        ..RegisterPayload::default()
    };
    let json: Value = serde_json::from_str(
        &updated_device_json(
            device_json(Some("local"), None, None),
            &default_payload,
            None,
            Some("127.0.0.1"),
        )
        .expect("updated json"),
    )
    .expect("json");
    // `effective_transfer_port` fills the deployment default when unset.
    assert_eq!(
        json["spec"]["runtimeTransferPort"],
        serde_json::json!(17888)
    );
}

#[tokio::test]
async fn cloud_match_locks_and_updates_on_the_same_transaction() {
    // `_match_cloud_device_sync` opens one session for the `FOR UPDATE`
    // read and the Runtime pin; a second handle would commit the lock
    // before the write it guards.
    let mut transaction = RecordingTransaction::default();
    let outcome = match_cloud_registration(&mut transaction, 329, &payload(), None)
        .await
        .expect("transaction");
    assert!(matches!(outcome, CloudMatch::None));
    let statements = transaction.statements();
    assert_eq!(statements.len(), 1, "{statements:?}");
    assert!(
        statements[0].contains("END = 'cloud' FOR UPDATE"),
        "{statements:?}"
    );
}

#[test]
fn cloud_runtime_spec_pins_the_runtime_on_the_stored_document() {
    let json = serde_json::json!({
        "spec": {
            "deviceType": "cloud",
            "cloudConfig": {"deviceId": "b549ace3", "sandboxId": "sandbox-1"},
        },
        "status": {"state": "Available"},
    });
    let payload = RegisterPayload {
        runtime_instance_id: Some("runtime-1".into()),
        ..payload()
    };
    let updated: Value =
        serde_json::from_str(&cloud_runtime_spec(&json, &payload, Some("192.0.2.1")).unwrap())
            .unwrap();
    assert_eq!(updated["spec"]["runtimeInstanceId"], "runtime-1");
    assert_eq!(updated["spec"]["runtimeTransferHost"], "192.0.2.1");
    assert_eq!(updated["spec"]["runtimeTransferPort"], 17888);
    assert_eq!(updated["spec"]["cloudConfig"]["sandboxId"], "sandbox-1");
    assert_eq!(updated["status"]["state"], "Available");
    assert!(
        chrono::DateTime::parse_from_rfc3339(updated["status"]["lastSeenAt"].as_str().unwrap())
            .is_ok()
    );
}

#[test]
fn update_carries_the_merged_spec() {
    let json: Value = serde_json::from_str(
        &updated_device_json(
            device_json(Some("local"), None, None),
            &payload(),
            Some("192.0.2.1"),
            Some("127.0.0.1"),
        )
        .expect("merged device json"),
    )
    .expect("json");
    assert_eq!(json["spec"]["displayName"], "executor");
    assert_eq!(json["spec"]["clientIp"], "127.0.0.1");
    assert_eq!(json["spec"]["runtimeTransferHost"], "192.0.2.1");
}
