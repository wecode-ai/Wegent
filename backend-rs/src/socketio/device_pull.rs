// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` `runtime.tasks.pull` — Executor-owned execution delivery.
//!
//! Source: `app/api/ws/device_namespace.py::on_runtime_tasks_pull` and
//! `app/services/loop_item_executions/device_pull.py::pull_execution`.
//!
//! The connected Executor pulls work through its Socket.IO connection:
//!
//! 1. an optional `runner_catalog` capability report is validated and stored
//!    under the device's `spec.runnerCatalog`;
//! 2. the per-runtime Redis lock `wegent:lock:robot_exec:{owner}:runtime:{id}`
//!    serializes claims with a token-owned Redis lease;
//! 3. `runtime.tasks.pull` claims one queued execution for the session's
//!    execution target (unconfirmed redelivery first, then the priority/FIFO
//!    queue);
//! 4. a separate read fills `workspace_cleanup_intents = pull_due(...)`.
//!
//! Claim delivery and the persisted Runtime request compilation are not ported
//! yet (their Runtime payload builder and issue TaskBinding are separate source
//! modules). The queue read is followed by the source's claimability and
//! occupancy filters, so a pull that admits no eligible row acknowledges
//! `task: null`; only a row that survives those filters reaches the unported
//! delivery branch, which fails explicitly with `NOT_IMPLEMENTED` before
//! reserving the selected execution.

use std::sync::Arc;

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use brz_redis::{Redis, SetExpiration, SetOptions};
use brz_socket_io::ClientError;
use chrono::{NaiveDateTime, Utc};
use serde_json::{Map, Value, json};

use crate::device_identity::{
    device_identity_ids, resolve_owned_device_alias, resolve_owned_device_alias_on,
    resolve_runtime_route_identity,
};
use crate::json_compat::python_str;
use crate::socketio::device::DeviceType;
use crate::socketio::device_pull_claim as claim;
use crate::socketio::runner_catalog;
use crate::socketio::session::SessionSnapshot;
use crate::state::AppState;

/// `DEVICE_PULL_LOCK_SECONDS`.
const DEVICE_PULL_LOCK_SECONDS: u64 = 30;

/// One pull request's session-derived arguments.
#[derive(Debug)]
pub(super) struct PullCommand<'a> {
    pub(super) owner_user_id: i64,
    pub(super) runtime_device_id: &'a str,
    pub(super) execution_target_id: &'a str,
    pub(super) runtime_instance_id: &'a str,
    pub(super) environment: &'static str,
    runner_catalog: Option<&'a Value>,
}

/// `on_runtime_tasks_pull`: validate the session, run `pull_execution`, and
/// return its ACK.
pub(crate) async fn pull(
    app: &Arc<AppState>,
    snapshot: &SessionSnapshot,
    data: &Value,
) -> Result<Value, ClientError> {
    let command = match pull_command(snapshot, data) {
        Ok(command) => command,
        Err(ack) => return Ok(ack),
    };
    pull_execution(app, &command).await.map_err(|error| {
        tracing::error!(%error, "runtime.tasks.pull failed");
        ClientError::new("INTERNAL_ERROR", "Runtime task pull failed")
    })
}

/// `on_runtime_tasks_pull`'s session and payload normalization.
fn pull_command<'a>(
    snapshot: &'a SessionSnapshot,
    data: &'a Value,
) -> Result<PullCommand<'a>, Value> {
    let device = &snapshot.device;
    let runtime_device_id = device.device_id.as_deref().unwrap_or("");
    let execution_target_id = device.execution_target_id.as_deref().unwrap_or("");
    let runtime_instance_id = device.runtime_instance_id.as_deref().unwrap_or("");
    if snapshot.user_id == 0
        || runtime_device_id.is_empty()
        || execution_target_id.is_empty()
        || runtime_instance_id.is_empty()
    {
        return Err(json!({"success": false, "error": "Device is not registered"}));
    }
    let environment = match device.device_type {
        Some(DeviceType::Cloud | DeviceType::Remote) => "cloud",
        _ => "local",
    };
    let runner_catalog = data
        .as_object()
        .and_then(|object| object.get("runner_catalog"))
        .filter(|value| !value.is_null());
    Ok(PullCommand {
        owner_user_id: snapshot.user_id,
        runtime_device_id,
        execution_target_id,
        runtime_instance_id,
        environment,
        runner_catalog,
    })
}

async fn pull_execution(app: &AppState, command: &PullCommand<'_>) -> anyhow::Result<Value> {
    if let Some(catalog) = command.runner_catalog {
        let Some(normalized) = runner_catalog::normalize(catalog) else {
            return Ok(json!({"success": false, "error": "Invalid runner capability report"}));
        };
        match save_catalog(
            app,
            command.owner_user_id,
            command.execution_target_id,
            &normalized,
        )
        .await?
        {
            CatalogOutcome::Saved => {}
            CatalogOutcome::NotAuthorized => {
                return Ok(json!({"success": false, "error": "Runner is no longer authorized"}));
            }
        }
    }

    let key = lock_key(command.owner_user_id, command.runtime_instance_id);
    let mut ack = match acquire_lock(app, &key).await {
        PullLock::Busy => Ok(json!({"success": true, "task": null})),
        PullLock::Unavailable => claim_execution(app, command).await,
        PullLock::Owned(token) => {
            let result = claim_execution(app, command).await;
            release_lock(app, &key, &token).await;
            result
        }
    }?;
    ack["workspace_cleanup_intents"] =
        Value::Array(pull_due(app, command.owner_user_id, command.runtime_device_id).await?);
    Ok(ack)
}

/// `_claim_execution`: redeliver an unconfirmed claim, otherwise claim the
/// next eligible queued run.
async fn claim_execution(app: &AppState, command: &PullCommand<'_>) -> anyhow::Result<Value> {
    if let Some(reserved) = unconfirmed_claim(app, command).await? {
        let Some(mut prepared) = claim::redelivery_preparation(&reserved) else {
            return Ok(json!({
                "success": false, "task": null, "error": "Claimed execution has no Runtime task identity"
            }));
        };
        let payload =
            super::device_pull_payload::compile_request(app, command, &reserved, &mut prepared)
                .await?;
        if claim::renew_redelivery(app, command, &reserved).await? {
            return Ok(delivery(reserved.id, &prepared.runtime_task_id, payload));
        }
        return Ok(json!({"success": true, "task": null}));
    }
    crate::background_jobs::robot::prepare_queued_assignments(app).await?;
    let identities =
        owned_execution_device_ids(app, command.owner_user_id, command.execution_target_id).await?;
    let canonical =
        canonical_execution_device(app, command.owner_user_id, command.execution_target_id).await?;
    let queued =
        claim::queue_rows(app, command.owner_user_id, &identities, command.environment).await?;
    // `claim_next_for_device`'s post-queue filters: only a row whose current
    // authority, device set, route/affinity and execution scope allow it may
    // be claimed.
    let candidate = claim::select_claimable(
        app,
        command.owner_user_id,
        command.execution_target_id,
        queued,
    )
    .await?;
    if let Some(candidate) = candidate
        && let Some(mut prepared) = claim::prepare_candidate(
            app,
            &candidate,
            command.owner_user_id,
            command.execution_target_id,
            command.runtime_device_id,
        )
        .await?
    {
        let payload = match super::device_pull_payload::compile_request(
            app,
            command,
            &candidate,
            &mut prepared,
        )
        .await
        {
            Ok(payload) => payload,
            Err(error) if crate::background_jobs::robot::authority::infrastructure(&error) => {
                return Err(error);
            }
            Err(error) => {
                tracing::warn!(execution_id = candidate.id, %error, "queued Runtime preflight failed");
                let detail = error
                    .downcast_ref::<crate::background_jobs::project::runtime_rpc::IncompleteCloudModelIdentity>()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "Execution configuration is unavailable".to_owned());
                crate::background_jobs::robot::fail_preparation(
                    app,
                    &candidate.execution(),
                    &detail,
                )
                .await?;
                return Ok(json!({"success": false, "error": detail, "task": null}));
            }
        };
        if claim::reserve(app, command, &candidate, &prepared, &canonical).await? {
            tracing::info!(
                execution_id = candidate.id,
                device = command.runtime_device_id,
                runtime_task_id = prepared.runtime_task_id,
                "Queued Runtime execution claimed"
            );
            return Ok(delivery(candidate.id, &prepared.runtime_task_id, payload));
        }
    }
    Ok(json!({"success": true, "task": null}))
}

fn delivery(execution_id: i64, runtime_task_id: &str, payload: Value) -> Value {
    let prompt = payload["executionRequest"]["prompt"].as_str();
    json!({"success": true, "task": {
        "execution_id": execution_id, "runtime_task_id": runtime_task_id,
        "payload": payload, "prompt": prompt
    }})
}

/// `_unconfirmed_claim`: work reserved by this Runtime but not acknowledged.
async fn unconfirmed_claim(
    app: &AppState,
    command: &PullCommand<'_>,
) -> MysqlResult<Option<claim::QueueExecutionRow>> {
    app.mysql
        .fetch_optional(
            format!(
                "SELECT {} \
             FROM loop_item_executions \
             WHERE loop_item_executions.executor_owner_user_id = ? \
             AND loop_item_executions.runtime_device_id = ? \
             AND loop_item_executions.runtime_instance_id = ? \
             AND loop_item_executions.execution_environment = ? \
             AND loop_item_executions.status = 'claimed' \
             AND (loop_item_executions.start_requested_at IS NULL \
                  OR loop_item_executions.start_requested_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             ORDER BY loop_item_executions.claimed_at ASC, loop_item_executions.id ASC \
             LIMIT 1",
                crate::loop_tasks::loop_repository::EXECUTION_COLUMNS
            ),
            (
                command.owner_user_id,
                command.runtime_device_id,
                command.runtime_instance_id,
                command.environment,
            ),
        )
        .await
}

/// `_owned_execution_device_ids`: every queue identity for one owned device.
async fn owned_execution_device_ids(
    app: &AppState,
    owner_user_id: i64,
    submitted_device_id: &str,
) -> MysqlResult<Vec<String>> {
    match resolve_owned_device_alias(&app.mysql, owner_user_id, submitted_device_id).await? {
        Some(device) => Ok(device_identity_ids(&device)),
        None => Ok(vec![submitted_device_id.to_owned()]),
    }
}

/// `_canonical_execution_device`: the canonical queue identity for a submitted
/// device id, or the submitted id when it cannot be resolved.
async fn canonical_execution_device(
    app: &AppState,
    owner_user_id: i64,
    submitted_device_id: &str,
) -> MysqlResult<String> {
    Ok(
        match resolve_runtime_route_identity(&app.mysql, owner_user_id, submitted_device_id).await?
        {
            Some(identity) => identity.runtime_device_id,
            None => submitted_device_id.to_owned(),
        },
    )
}

enum CatalogOutcome {
    Saved,
    NotAuthorized,
}

#[derive(FromMysqlRow)]
struct KindsJsonRow {
    #[mysql(rename = "json")]
    kinds_json: Value,
}

/// `save_catalog`: refresh the device row under `FOR UPDATE`, then persist the
/// normalized report only when it changed. The source session's read and
/// locking refresh share one transaction.
async fn save_catalog(
    app: &AppState,
    owner_user_id: i64,
    execution_target_id: &str,
    normalized: &Value,
) -> MysqlResult<CatalogOutcome> {
    app.mysql
        .with_transaction(async |transaction| {
            let mut transaction = transaction;
            let Some(device) =
                resolve_owned_device_alias_on(&mut transaction, owner_user_id, execution_target_id)
                    .await?
            else {
                return Ok(CatalogOutcome::NotAuthorized);
            };
            let refreshed: Option<KindsJsonRow> = transaction
                .fetch_optional(
                    "SELECT kinds.json \
                     FROM kinds \
                     WHERE kinds.id = ? FOR UPDATE",
                    (device.id,),
                )
                .await?;
            let Some(refreshed) = refreshed else {
                return Ok(CatalogOutcome::NotAuthorized);
            };
            let mut payload = match refreshed.kinds_json {
                Value::Object(values) => values,
                _ => Map::new(),
            };
            let mut spec = match payload.get("spec") {
                Some(Value::Object(values)) => values.clone(),
                _ => Map::new(),
            };
            let changed = spec.get("runnerCatalog") != Some(normalized);
            spec.insert("runnerCatalog".to_owned(), normalized.clone());
            payload.insert("spec".to_owned(), Value::Object(spec));
            if changed {
                transaction
                    .execute(
                        "UPDATE kinds SET json=? WHERE kinds.id=?",
                        (Value::Object(payload).to_string(), device.id),
                    )
                    .await?;
            }
            Ok(CatalogOutcome::Saved)
        })
        .await
}

/// `pull_due`: due or cancelled cleanup intents addressed to this Runtime.
async fn pull_due(
    app: &AppState,
    owner_user_id: i64,
    runtime_device_id: &str,
) -> MysqlResult<Vec<Value>> {
    let rows: Vec<CleanupIntentRow> = app
        .mysql
        .fetch_all(
            format!(
                "SELECT {} \
                 FROM loop_items \
                 WHERE loop_items.task_user_id = ? \
                 AND loop_items.device_id = ? \
                 AND loop_items.status IN ('pending', 'executing', 'cancelled') \
                 AND loop_items.resource_type IN ('workspace_cleanup') \
                 ORDER BY loop_items.updated_at ASC, loop_items.id ASC",
                crate::cloud_projects::LOOP_ITEMS_COLUMNS
            ),
            (owner_user_id, runtime_device_id),
        )
        .await?;
    let now = Utc::now().naive_utc();
    Ok(rows
        .iter()
        .filter_map(|row| cleanup_intent(row, now))
        .collect())
}

#[derive(FromMysqlRow)]
struct CleanupIntentRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_loop_item_id")]
    loop_item_id: String,
    #[mysql(rename = "loop_items_status")]
    status: String,
    #[mysql(rename = "loop_items_version")]
    version: i64,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Value,
    #[mysql(rename = "loop_items_due_at")]
    due_at: Option<NaiveDateTime>,
}

/// `pull_due`'s per-row projection; due time and cancellation decide whether a
/// pending/executing intent is visible.
fn cleanup_intent(row: &CleanupIntentRow, now: NaiveDateTime) -> Option<Value> {
    if matches!(row.status.as_str(), "pending" | "executing") {
        let due_at = row.due_at?;
        if due_at > now {
            return None;
        }
    }
    let runtime_task_ids = row
        .metadata
        .get("runtime_task_ids")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(python_str)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(json!({
        "intent_id": row.id,
        "issue_id": row.loop_item_id,
        "issue_version": row.version,
        "action": if row.status == "cancelled" { "retain" } else { "release" },
        "runtime_task_ids": runtime_task_ids,
    }))
}

/// `distributed_lock`'s complete key: `wegent:lock:{lock_name}`.
fn lock_key(owner_user_id: i64, runtime_instance_id: &str) -> String {
    format!("wegent:lock:robot_exec:{owner_user_id}:runtime:{runtime_instance_id}")
}

enum PullLock {
    Busy,
    Unavailable,
    Owned(String),
}

/// Redis is advisory. The database still arbitrates ownership when it is unavailable.
async fn acquire_lock(app: &AppState, key: &str) -> PullLock {
    let Some(redis) = app.redis.as_ref() else {
        return PullLock::Unavailable;
    };
    let token = crate::device_identity_lock::lock_token();
    let options = SetOptions::default()
        .with_expiration(SetExpiration::Seconds(DEVICE_PULL_LOCK_SECONDS))
        .if_absent();
    match redis.set_with(key, token.as_str(), options).await {
        Ok(true) => PullLock::Owned(token),
        Ok(false) => PullLock::Busy,
        Err(error) => {
            tracing::warn!(%error, "robot execution lock acquisition failed; proceeding");
            PullLock::Unavailable
        }
    }
}

async fn release_lock(app: &AppState, key: &str, token: &str) {
    let Some(redis) = app.redis.as_ref() else {
        return;
    };
    // A long preflight may outlive the TTL. Release only our own lease.
    let released: Result<i64, _> = redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        [key], [token],
    ).await;
    if let Err(error) = released {
        tracing::warn!(%error, "robot execution lock release failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::socketio::session::DeviceSessionState;

    fn snapshot(state: DeviceSessionState) -> SessionSnapshot {
        SessionSnapshot {
            user_id: 167,
            user_name: "tester".into(),
            auth_type: "jwt",
            client_ip: None,
            device: state,
        }
    }

    fn registered(device_type: DeviceType) -> DeviceSessionState {
        DeviceSessionState {
            device_id: Some("app-record-271206".into()),
            reported_device_id: Some("local-device".into()),
            logical_device_id: Some("app-record-271206".into()),
            runtime_instance_id: Some("runtime-ebd1102bbcde088793edb840".into()),
            device_type: Some(device_type),
            execution_target_id: Some("app-record-271206".into()),
            registered: true,
            ..DeviceSessionState::default()
        }
    }

    #[test]
    fn an_unregistered_session_reports_the_source_ack() {
        let snapshot = snapshot(DeviceSessionState::default());
        let data = json!({});
        let ack = pull_command(&snapshot, &data)
            .expect_err("missing session identity is a business error");
        assert_eq!(
            ack,
            json!({"success": false, "error": "Device is not registered"})
        );
    }

    #[test]
    fn app_and_local_sessions_pull_local_work() {
        for device_type in [DeviceType::App, DeviceType::Local] {
            let snapshot = snapshot(registered(device_type));
            let data = json!({});
            let command = pull_command(&snapshot, &data).expect("registered session");
            assert_eq!(command.environment, "local");
            assert_eq!(command.runtime_device_id, "app-record-271206");
            assert_eq!(command.execution_target_id, "app-record-271206");
        }
    }

    #[test]
    fn cloud_and_remote_sessions_pull_cloud_work() {
        for device_type in [DeviceType::Cloud, DeviceType::Remote] {
            let snapshot = snapshot(registered(device_type));
            let data = json!({});
            let command = pull_command(&snapshot, &data).expect("registered session");
            assert_eq!(command.environment, "cloud");
        }
    }

    #[test]
    fn the_pull_lock_uses_the_source_prefix_and_components() {
        assert_eq!(
            lock_key(167, "runtime-ebd1102bbcde088793edb840"),
            "wegent:lock:robot_exec:167:runtime:runtime-ebd1102bbcde088793edb840"
        );
    }

    #[test]
    fn runner_catalog_is_only_read_from_an_object_payload() {
        let snapshot = snapshot(registered(DeviceType::App));

        let data = json!("not-an-object");
        let command = pull_command(&snapshot, &data).expect("registered session");
        assert!(command.runner_catalog.is_none());

        let catalog = json!({"errors": [], "runtimes": [], "models": []});
        let data = json!({"runner_catalog": catalog});
        let command = pull_command(&snapshot, &data).expect("registered session");
        assert_eq!(command.runner_catalog, Some(&catalog));

        let data = json!({"runner_catalog": null});
        let command = pull_command(&snapshot, &data).expect("registered session");
        assert!(command.runner_catalog.is_none());
    }

    #[test]
    fn cleanup_intents_skip_pending_work_that_is_not_due() {
        let now = NaiveDateTime::default();
        let row = CleanupIntentRow {
            id: "cleanup-1".into(),
            loop_item_id: "issue-1".into(),
            status: "pending".into(),
            version: 3,
            metadata: json!({"runtime_task_ids": ["task-1", "", 7]}),
            due_at: Some(now + chrono::Duration::seconds(30)),
        };
        assert!(cleanup_intent(&row, now).is_none());
    }

    #[test]
    fn cleanup_intents_project_the_source_fields() {
        let now = NaiveDateTime::default();
        let row = CleanupIntentRow {
            id: "cleanup-1".into(),
            loop_item_id: "issue-1".into(),
            status: "executing".into(),
            version: 3,
            metadata: json!({"runtime_task_ids": ["task-1", "", 7]}),
            due_at: Some(now - chrono::Duration::seconds(30)),
        };
        assert_eq!(
            cleanup_intent(&row, now).expect("due intent"),
            json!({
                "intent_id": "cleanup-1",
                "issue_id": "issue-1",
                "issue_version": 3,
                "action": "release",
                "runtime_task_ids": ["task-1", "7"],
            })
        );
        let cancelled = CleanupIntentRow {
            status: "cancelled".into(),
            due_at: None,
            ..row
        };
        assert_eq!(
            cleanup_intent(&cancelled, now).expect("cancelled intent")["action"],
            json!("retain")
        );
    }

    #[test]
    fn cleanup_intents_without_task_ids_report_an_empty_list() {
        let now = NaiveDateTime::default();
        let row = CleanupIntentRow {
            id: "cleanup-1".into(),
            loop_item_id: "issue-1".into(),
            status: "cancelled".into(),
            version: 1,
            metadata: json!(null),
            due_at: None,
        };
        assert_eq!(
            cleanup_intent(&row, now).expect("cancelled intent")["runtime_task_ids"],
            json!([])
        );
    }

    #[test]
    fn the_no_work_ack_matches_the_source_shape() {
        let mut ack = json!({"success": true, "task": null});
        ack["workspace_cleanup_intents"] = Value::Array(Vec::new());
        assert_eq!(
            ack,
            json!({"success": true, "task": null, "workspace_cleanup_intents": []})
        );
    }
}
