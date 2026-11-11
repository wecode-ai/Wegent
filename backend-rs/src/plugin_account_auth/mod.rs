// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Plugin credential exchange on the registered device socket.
//!
//! Source: `app/api/ws/plugin_auth_broker.py::exchange`, reached from the
//! `plugin.auth.*` handlers in `app/api/ws/device_namespace.py`.
//!
//! Identity comes exclusively from the authenticated, registered socket: the
//! broker resolves the owned device row and its current Runtime socket, then
//! re-resolves the route on its own session before dispatching the operation.

mod automation;
mod connections;
mod credential_cipher;
mod definition;
mod execution;
mod local_http;
mod local_lifecycle;
mod migrations;
mod native_credential;
mod notifications;
mod oauth_refresh;
mod revocations;
pub(crate) mod route;
mod transfers;
mod write_targets;

use serde_json::{Value, json};

use brz_socket_io::ClientError;

use crate::socketio::session::SessionSnapshot;
use crate::state::AppState;

/// `operation="oauth_revocations"`.
pub(crate) const OAUTH_REVOCATIONS: &str = "oauth_revocations";
/// `operation="automatic"`.
pub(crate) const AUTOMATIC: &str = "automatic";
/// `operation="local_lifecycle"`.
pub(crate) const LOCAL_LIFECYCLE: &str = "local_lifecycle";
/// `operation="prepare"`.
pub(crate) const PREPARE: &str = "prepare";
/// `operation="execute"`.
pub(crate) const EXECUTE: &str = "execute";
/// `operation="read"`.
pub(crate) const READ: &str = "read";
/// `operation="enroll"`.
pub(crate) const ENROLL: &str = "enroll";
/// `operation="oauth_begin"`.
pub(crate) const OAUTH_BEGIN: &str = "oauth_begin";
/// `operation="oauth_finish"`.
pub(crate) const OAUTH_FINISH: &str = "oauth_finish";
/// `operation="oauth_revoke_begin"`.
pub(crate) const OAUTH_REVOKE_BEGIN: &str = "oauth_revoke_begin";
/// `operation="oauth_revoke_finish"`.
pub(crate) const OAUTH_REVOKE_FINISH: &str = "oauth_revoke_finish";
/// `operation="transfer_stage"`.
pub(crate) const TRANSFER_STAGE: &str = "transfer_stage";
/// `operation="transfer_prepare"`.
pub(crate) const TRANSFER_PREPARE: &str = "transfer_prepare";
/// `operation="transfer_finish"`.
pub(crate) const TRANSFER_FINISH: &str = "transfer_finish";
/// `operation="transfer_abort"`.
pub(crate) const TRANSFER_ABORT: &str = "transfer_abort";

/// `PluginAccountAuthError("plugin_auth_device_not_registered")`.
pub(crate) const DEVICE_NOT_REGISTERED: &str = "plugin_auth_device_not_registered";
/// `PluginAccountAuthError("plugin_auth_stale_device_socket")`.
pub(crate) const STALE_DEVICE_SOCKET: &str = "plugin_auth_stale_device_socket";
/// `PluginAccountAuthError("plugin_auth_device_not_found")`.
pub(crate) const DEVICE_NOT_FOUND: &str = "plugin_auth_device_not_found";
/// `PluginAccountAuthError("plugin_auth_device_upgrade_required")`.
pub(crate) const DEVICE_UPGRADE_REQUIRED: &str = "plugin_auth_device_upgrade_required";
/// `PluginAccountAuthError("plugin_auth_invalid_request")`.
pub(crate) const INVALID_REQUEST: &str = "plugin_auth_invalid_request";
/// `PluginAccountAuthError("plugin_auth_invalid_operation")`.
pub(crate) const INVALID_OPERATION: &str = "plugin_auth_invalid_operation";
/// The broker's generic failure code (`plugin_auth_exchange_failed`).
pub(crate) const EXCHANGE_FAILED: &str = "plugin_auth_exchange_failed";
/// Internal sentinel for a well-formed operation whose service is not ported.
/// `RuntimeRouteError("device_not_found")`.
const ROUTE_DEVICE_NOT_FOUND: &str = "device_not_found";
/// `RuntimeRouteError("device_offline")`.
const ROUTE_DEVICE_OFFLINE: &str = "device_offline";
/// `RuntimeRouteError("runtime_route_missing")`.
const ROUTE_RUNTIME_MISSING: &str = "runtime_route_missing";

/// The broker's rejection shape: `{"success": False, "error": code}`.
pub(crate) fn refused(code: &str) -> Value {
    json!({"success": false, "error": code})
}

/// Validate one operation's request against the source pydantic model
/// (`app/schemas/plugin_account_auth.py`, every model `extra="forbid"` and
/// strict). The source validates inside `_exchange_sync`'s operation branch,
/// so a malformed payload becomes `plugin_auth_invalid_request` only after the
/// route identity recheck.
pub(crate) fn request_valid(operation: &str, data: &Value) -> bool {
    let Some(object) = data.as_object() else {
        return false;
    };
    match operation {
        PREPARE | TRANSFER_PREPARE | TRANSFER_FINISH | TRANSFER_ABORT => {
            only_fields(object, &["migration_id"]) && hex64(object.get("migration_id"))
        }
        EXECUTE | OAUTH_BEGIN => {
            only_fields(
                object,
                &["installed_plugin_id", "connector_slug", "account_id"],
            ) && positive_int(object.get("installed_plugin_id"))
                && slug(object.get("connector_slug"))
                && nullable_string(object.get("account_id"), 1, 256)
        }
        READ => {
            only_fields(
                object,
                &["connection_id", "installed_plugin_id", "expected_revision"],
            ) && hex64(object.get("connection_id"))
                && positive_int(object.get("installed_plugin_id"))
                && int_at_least(object.get("expected_revision"), 1)
        }
        ENROLL | TRANSFER_STAGE => {
            only_fields(
                object,
                &["migration_id", "account_id", "account_label", "credential"],
            ) && hex64(object.get("migration_id"))
                && required_string(object.get("account_id"), 1, 256)
                && optional_string(object.get("account_label"), 0, 256)
                && credential(object.get("credential"))
        }
        LOCAL_LIFECYCLE => {
            only_fields(object, &["installed_plugin_id", "connector_slug", "action"])
                && positive_int(object.get("installed_plugin_id"))
                && slug(object.get("connector_slug"))
                && matches!(
                    object.get("action").and_then(Value::as_str),
                    Some("status" | "logout" | "login")
                )
        }
        OAUTH_FINISH => {
            only_fields(
                object,
                &[
                    "connection_id",
                    "operation_id",
                    "succeeded",
                    "attempted",
                    "account_id",
                    "credential",
                ],
            ) && hex64(object.get("connection_id"))
                && hex64(object.get("operation_id"))
                && object.get("succeeded").is_some_and(Value::is_boolean)
                && object.get("attempted").is_none_or(Value::is_boolean)
                && nullable_string(object.get("account_id"), 1, 256)
                && nullable_credential(object.get("credential"))
                && oauth_finish_result(object)
        }
        OAUTH_REVOKE_BEGIN => {
            only_fields(object, &["connection_id"]) && hex64(object.get("connection_id"))
        }
        OAUTH_REVOKE_FINISH => {
            only_fields(object, &["connection_id", "operation_id", "succeeded"])
                && hex64(object.get("connection_id"))
                && hex64(object.get("operation_id"))
                && object.get("succeeded").is_some_and(Value::is_boolean)
        }
        _ => true,
    }
}

/// `PluginOAuthFinish`: `succeeded` requires `attempted`, an account and a
/// credential; a failed operation carries neither.
fn oauth_finish_result(object: &serde_json::Map<String, Value>) -> bool {
    let succeeded = object.get("succeeded") == Some(&Value::Bool(true));
    let attempted = object.get("attempted") != Some(&Value::Bool(false));
    let has_account = object.get("account_id").is_some_and(Value::is_string);
    let has_credential = object.get("credential").is_some_and(Value::is_string);
    if succeeded {
        attempted && has_account && has_credential
    } else {
        !has_account && !has_credential
    }
}

fn only_fields(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn positive_int(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(number)) if number.is_i64() && number.as_i64().unwrap_or(0) > 0)
}

fn int_at_least(value: Option<&Value>, minimum: i64) -> bool {
    matches!(value, Some(Value::Number(number)) if number.is_i64() && number.as_i64().unwrap_or(i64::MIN) >= minimum)
}

fn required_string(value: Option<&Value>, minimum: usize, maximum: usize) -> bool {
    value.is_some_and(|value| {
        string_length(value).is_some_and(|len| (minimum..=maximum).contains(&len))
    })
}

fn optional_string(value: Option<&Value>, minimum: usize, maximum: usize) -> bool {
    value.is_none_or(|value| {
        string_length(value).is_some_and(|len| (minimum..=maximum).contains(&len))
    })
}

/// `str | None` with a `None` default: omitted, explicit `null`, or a string
/// within the model's bounds. (`PluginNativeExecution.account_id` and
/// `PluginOAuthFinish.account_id` declare `str | None`.)
fn nullable_string(value: Option<&Value>, minimum: usize, maximum: usize) -> bool {
    value.is_none_or(|value| {
        value.is_null()
            || string_length(value).is_some_and(|len| (minimum..=maximum).contains(&len))
    })
}

fn string_length(value: &Value) -> Option<usize> {
    value.as_str().map(|text| text.chars().count())
}

/// `^[a-f0-9]{64}$`.
fn hex64(value: Option<&Value>) -> bool {
    value.is_some_and(|value| {
        value.as_str().is_some_and(|text| {
            text.len() == 64
                && text
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
    })
}

/// `^[a-z0-9][a-z0-9_-]{0,99}$`.
fn slug(value: Option<&Value>) -> bool {
    value.is_some_and(|value| {
        value.as_str().is_some_and(|text| {
            let bytes = text.as_bytes();
            (1..=100).contains(&bytes.len())
                && matches!(bytes[0], b'a'..=b'z' | b'0'..=b'9')
                && bytes[1..]
                    .iter()
                    .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
        })
    })
}

/// `PluginCredentialWrite.limit_credential_size`: a 1..=65536 byte string.
fn credential(value: Option<&Value>) -> bool {
    value.is_some_and(|value| {
        value
            .as_str()
            .is_some_and(|text| (1..=65536).contains(&text.len()))
    })
}

/// `SecretStr | None`: omitted, explicit `null`, or a 1..=65536 byte
/// string (`PluginOAuthFinish.credential`).
fn nullable_credential(value: Option<&Value>) -> bool {
    value.is_none_or(|value| value.is_null() || credential(Some(value)))
}

/// One `plugin.auth.*` exchange.
///
/// Returns the reply payload the source handler returns; the socket framework
/// turns it into the ACK the client recorded.
pub(crate) async fn exchange(
    state: &AppState,
    session: &SessionSnapshot,
    socket_id: &str,
    operation: &str,
    data: &Value,
) -> Result<Value, ClientError> {
    let user_id = session.user_id;
    let Some(runtime_id) = session.device.device_id.clone() else {
        return Ok(refused(DEVICE_NOT_REGISTERED));
    };
    let Some(instance_id) = session.device.runtime_instance_id.clone() else {
        return Ok(refused(DEVICE_NOT_REGISTERED));
    };
    // `runtime_route_resolver.resolve`: owned identity plus its live socket.
    let identity = match route::identity(&state.mysql, user_id, &runtime_id).await {
        Ok(Some(identity)) => identity,
        Ok(None) => return Ok(refused(ROUTE_DEVICE_NOT_FOUND)),
        Err(_) => return Ok(refused(EXCHANGE_FAILED)),
    };
    let Some(online) = route::online(state, user_id, &identity.runtime_device_id).await else {
        return Ok(refused(ROUTE_DEVICE_OFFLINE));
    };
    let online_socket = online
        .get("socket_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    if online_socket.is_empty() {
        return Ok(refused(ROUTE_RUNTIME_MISSING));
    }
    if identity
        .runtime_instance_id
        .as_deref()
        .is_some_and(|expected| {
            online
                .get("runtime_instance_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                != expected
        })
    {
        return Ok(refused(ROUTE_RUNTIME_MISSING));
    }
    if online_socket != socket_id
        || identity.runtime_device_id != runtime_id
        || identity.runtime_instance_id.as_deref() != Some(instance_id.as_str())
    {
        return Ok(refused(STALE_DEVICE_SOCKET));
    }
    // `_exchange_sync`: `configure_plugin_session` makes this session READ
    // COMMITTED before its first query, and the identity re-read, the reads
    // after the Redis wait, the coordination and the revision CAS all run
    // there. The plugin write lease outlives the transaction because Source
    // releases it from `after_transaction_end`, never before COMMIT.
    let options = brz_mysql::MysqlTransactionOptions::default()
        .with_isolation_level(brz_mysql::MysqlIsolationLevel::ReadCommitted);
    if matches!(
        operation,
        AUTOMATIC
            | PREPARE
            | ENROLL
            | LOCAL_LIFECYCLE
            | OAUTH_REVOKE_BEGIN
            | OAUTH_REVOKE_FINISH
            | OAUTH_BEGIN
            | OAUTH_FINISH
            | TRANSFER_STAGE
            | TRANSFER_PREPARE
            | TRANSFER_FINISH
            | TRANSFER_ABORT
    ) {
        // The lease is taken inside the transaction, after the identity/stale
        // checks and the payload validation, exactly like `reconcile` obtains
        // it; the outer holder lets it outlive COMMIT/ROLLBACK.
        let mut lease_slot: Option<automation::Lease<'_>> = None;
        let mut changed_targets = Vec::new();
        let outcome = state
            .mysql
            .with_transaction_options(options, async |transaction| {
                let device_type =
                    recheck_identity(transaction, user_id, &runtime_id, &instance_id).await?;
                let request = if operation != AUTOMATIC {
                    if !request_valid(operation, data) {
                        return Err(exchange_error(INVALID_REQUEST));
                    }
                    None
                } else {
                    Some(
                        automation::AutomationRequest::parse(data)
                            .ok_or_else(|| exchange_error(INVALID_REQUEST))?,
                    )
                };
                if request.as_ref().is_some_and(|request| request.prepare_only)
                    && matches!(
                        device_type,
                        crate::socketio::device::DeviceType::Local
                            | crate::socketio::device::DeviceType::App
                    )
                {
                    return automation::reconcile_on(
                        transaction, None, user_id, &runtime_id,
                        request.as_ref().expect("validated automatic request"),
                    )
                    .await
                    .map_err(exchange_error);
                }
                // Cloud grants may touch all connected installations. Native
                // reconciliation only touches the request's installation IDs.
                let targets = if operation == AUTOMATIC
                    && data["installed_plugin_ids"].as_array().is_some_and(Vec::is_empty)
                    && matches!(
                        device_type,
                        crate::socketio::device::DeviceType::Cloud
                            | crate::socketio::device::DeviceType::Remote
                    )
                {
                    None
                } else {
                    Some(write_targets::resolve(transaction, user_id, data).await?)
                };
                let lease = crate::plugins_installed::write_coordination::PluginWriteLease::acquire_installed(
                    &state.mysql, state.redis.as_ref(), user_id, targets.as_deref(),
                )
                .await?;
                let lease = lease_slot.insert(lease);
                changed_targets = lease.installation_ids().unwrap_or_default().to_vec();
                lease.ensure_policy(&state.mysql).await?;
                let policy = lease.read_revision(transaction).await?;
                let revisions = lease.read_plugin_revisions(transaction).await?;
                if let Some(request) = request {
                    let result = automation::reconcile_on(
                        transaction,
                        Some(lease),
                        user_id,
                        &runtime_id,
                        &request,
                    )
                    .await
                    .map_err(exchange_error)?;
                    lease.commit_plugin_revisions(transaction, revisions).await?;
                    lease.validate_policy_revision(transaction, policy).await?;
                    return Ok(result);
                }
                let result = if operation == PREPARE {
                    migrations::prepare_on(
                        transaction,
                        lease,
                        user_id,
                        &runtime_id,
                        data["migration_id"]
                            .as_str()
                            .expect("validated migration id"),
                    )
                    .await
                } else if operation == ENROLL {
                    transfers::enroll_on(transaction, lease, user_id, &runtime_id, data).await
                } else if operation == TRANSFER_STAGE {
                    transfers::stage_on(transaction, lease, user_id, &runtime_id, data).await
                } else if matches!(
                    operation,
                    TRANSFER_PREPARE | TRANSFER_FINISH | TRANSFER_ABORT
                ) {
                    let migration_id = data["migration_id"]
                        .as_str()
                        .expect("validated migration id");
                    if operation == TRANSFER_PREPARE {
                        transfers::prepare_on(
                            transaction,
                            lease,
                            user_id,
                            &runtime_id,
                            migration_id,
                        )
                        .await
                    } else if operation == TRANSFER_FINISH {
                        transfers::finish_on(transaction, lease, user_id, &runtime_id, migration_id)
                            .await
                    } else {
                        transfers::abort_on(transaction, lease, user_id, &runtime_id, migration_id)
                            .await
                    }
                } else if operation == OAUTH_REVOKE_BEGIN {
                    revocations::begin_on(
                        transaction,
                        lease,
                        user_id,
                        &runtime_id,
                        data["connection_id"]
                            .as_str()
                            .expect("validated connection id"),
                    )
                    .await
                } else if operation == OAUTH_REVOKE_FINISH {
                    revocations::finish_on(transaction, lease, user_id, &runtime_id, data).await
                } else if operation == OAUTH_BEGIN {
                    oauth_refresh::begin_on(transaction, lease, user_id, &runtime_id, data).await
                } else if operation == OAUTH_FINISH {
                    oauth_refresh::finish_on(transaction, lease, user_id, &runtime_id, data).await
                } else {
                    local_lifecycle::exchange_on(
                        transaction,
                        lease,
                        user_id,
                        &runtime_id,
                        data["installed_plugin_id"]
                            .as_i64()
                            .expect("validated plugin id"),
                        data["connector_slug"].as_str().expect("validated slug"),
                        data["action"].as_str().expect("validated action"),
                    )
                    .await
                };
                let result = result.map_err(auth_exchange_error)?;
                lease.commit_plugin_revisions(transaction, revisions).await?;
                lease.validate_policy_revision(transaction, policy).await?;
                Ok(result)
            })
            .await;
        // Release only after the transaction truly ended. `with_transaction_options`
        // awaits the rollback for an ordinary business `Err`, so a refusal is
        // safe to release immediately; only a cancelled/timed-out scope queues
        // its rollback, and that case keeps the lease until its token TTL.
        let releasable = match &outcome {
            Ok(_) => true,
            Err(brz_mysql::MysqlError::InvalidQuery { .. }) => true,
            Err(_) => false,
        };
        if let Some(lease) = lease_slot
            && releasable
        {
            lease.release().await;
        }
        if outcome.is_ok() && notifications::changes_credentials(operation) {
            notifications::publish(state, user_id, &changed_targets).await;
        }
        return Ok(exchange_reply(outcome));
    }
    let outcome = state
        .mysql
        .with_transaction_options(options, async |transaction| {
            recheck_identity(transaction, user_id, &runtime_id, &instance_id).await?;
            if operation == OAUTH_REVOCATIONS {
                let after_id = revocations::parse_cursor(data).map_err(exchange_error)?;
                revocations::pending_on(transaction, user_id, &runtime_id, after_id)
                    .await
                    .map_err(exchange_error)
            } else if matches!(operation, EXECUTE | READ) {
                if !request_valid(operation, data) {
                    return Err(exchange_error(INVALID_REQUEST));
                }
                let result = if operation == EXECUTE {
                    execution::execute_on(transaction, user_id, &runtime_id, data).await
                } else {
                    execution::read_on(transaction, user_id, &runtime_id, data).await
                };
                result.map_err(auth_exchange_error)
            } else {
                Err(exchange_error(INVALID_OPERATION))
            }
        })
        .await;
    Ok(exchange_reply(outcome))
}

/// `_exchange_sync` re-resolves the route on its own session and rejects a
/// socket that no longer matches the persisted identity.
async fn recheck_identity<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    runtime_id: &str,
    instance_id: &str,
) -> Result<crate::socketio::device::DeviceType, brz_mysql::MysqlError> {
    let current = route::identity_on(transaction, user_id, runtime_id)
        .await
        .map_err(|_| exchange_error(EXCHANGE_FAILED))?;
    let Some(current) = current else {
        return Err(exchange_error(STALE_DEVICE_SOCKET));
    };
    if current.runtime_device_id != runtime_id
        || current.runtime_instance_id.as_deref() != Some(instance_id)
    {
        return Err(exchange_error(STALE_DEVICE_SOCKET));
    }
    Ok(current.device_type)
}

fn exchange_error(code: &'static str) -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: code.to_owned(),
    }
}

fn auth_exchange_error(error: connections::AuthFailure) -> brz_mysql::MysqlError {
    exchange_error(match error {
        connections::AuthFailure::Refusal(code) => code,
        connections::AuthFailure::Internal => EXCHANGE_FAILED,
    })
}

fn exchange_reply(outcome: brz_mysql::MysqlResult<Value>) -> Value {
    match outcome {
        Ok(value) => value,
        Err(brz_mysql::MysqlError::InvalidQuery { reason }) if is_refusal(&reason) => {
            refused(&reason)
        }
        Err(_) => refused(EXCHANGE_FAILED),
    }
}

fn is_refusal(reason: &str) -> bool {
    reason == EXCHANGE_FAILED
        || reason == STALE_DEVICE_SOCKET
        || reason == INVALID_REQUEST
        || reason == INVALID_OPERATION
        || reason.starts_with("plugin_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejections_carry_the_broker_shape() {
        assert_eq!(
            refused(DEVICE_NOT_REGISTERED),
            json!({"success": false, "error": "plugin_auth_device_not_registered"})
        );
        assert_eq!(
            refused(INVALID_OPERATION)["error"],
            "plugin_auth_invalid_operation"
        );
    }

    #[test]
    fn recorded_empty_operation_payloads_are_invalid_requests() {
        // Recording 20261109050515 sends `{}` (and `{"action":"status"}` for
        // local_lifecycle) for every plugin.auth event; the source's pydantic
        // models reject each before the operation service runs.
        for operation in [
            PREPARE,
            EXECUTE,
            READ,
            ENROLL,
            OAUTH_BEGIN,
            OAUTH_FINISH,
            OAUTH_REVOKE_BEGIN,
            OAUTH_REVOKE_FINISH,
            TRANSFER_STAGE,
            TRANSFER_PREPARE,
            TRANSFER_FINISH,
            TRANSFER_ABORT,
        ] {
            assert!(!request_valid(operation, &json!({})), "{operation}");
        }
        assert!(!request_valid(
            LOCAL_LIFECYCLE,
            &json!({"action": "status"})
        ));
    }

    #[test]
    fn well_formed_requests_match_the_source_models() {
        let id = "a".repeat(64);
        assert!(request_valid(PREPARE, &json!({"migration_id": id})));
        assert!(!request_valid(
            PREPARE,
            &json!({"migration_id": id, "extra": 1})
        ));
        assert!(!request_valid(
            PREPARE,
            &json!({"migration_id": "A".repeat(64)})
        ));
        assert!(request_valid(
            EXECUTE,
            &json!({"installed_plugin_id": 3, "connector_slug": "dingtalk-access"})
        ));
        assert!(request_valid(
            LOCAL_LIFECYCLE,
            &json!({"installed_plugin_id": 3, "connector_slug": "dws", "action": "login"})
        ));
        assert!(request_valid(
            READ,
            &json!({"connection_id": id, "installed_plugin_id": 3, "expected_revision": 1})
        ));
        assert!(!request_valid(
            READ,
            &json!({"connection_id": id, "installed_plugin_id": 3, "expected_revision": 0})
        ));
        assert!(request_valid(
            ENROLL,
            &json!({"migration_id": id, "account_id": "u", "credential": "{}", "account_label": ""})
        ));
        assert!(!request_valid(
            ENROLL,
            &json!({"migration_id": id, "account_id": "u", "credential": ""})
        ));
        let operation_id = "b".repeat(64);
        assert!(request_valid(
            OAUTH_FINISH,
            &json!({"connection_id": id, "operation_id": operation_id,
                    "succeeded": false, "attempted": true})
        ));
        assert!(!request_valid(
            OAUTH_FINISH,
            &json!({"connection_id": id, "operation_id": operation_id,
                    "succeeded": true, "attempted": false,
                    "account_id": "u", "credential": "{}"})
        ));
        assert!(!request_valid(OAUTH_FINISH, &json!({"connection_id": id})));
        assert!(request_valid(
            OAUTH_REVOKE_FINISH,
            &json!({"connection_id": id, "operation_id": operation_id, "succeeded": true})
        ));
    }

    #[test]
    fn nullable_field_helpers_distinguish_absent_null_and_value() {
        for minimum in [0_usize, 1] {
            assert!(nullable_string(None, minimum, 256));
            assert!(nullable_string(Some(&Value::Null), minimum, 256));
            assert!(nullable_string(Some(&json!("u")), minimum, 256));
            assert!(!nullable_string(Some(&json!("")), 1, 256));
            assert!(!nullable_string(Some(&json!(1)), minimum, 256));
        }
        assert!(nullable_credential(None));
        assert!(nullable_credential(Some(&Value::Null)));
        assert!(nullable_credential(Some(&json!("{}"))));
        assert!(!nullable_credential(Some(&json!(""))));
        assert!(!credential(Some(&Value::Null)));
        // `PluginNativeEnrollment.account_label` is a plain `str`: omitted is
        // fine, explicit null is not.
        assert!(optional_string(None, 0, 256));
        assert!(!optional_string(Some(&Value::Null), 0, 256));
        assert!(optional_string(Some(&json!("")), 0, 256));
    }

    #[test]
    fn explicit_nulls_follow_the_source_optional_fields() {
        let id = "a".repeat(64);
        let operation_id = "b".repeat(64);
        // `PluginNativeExecution.account_id: str | None = None`.
        assert!(request_valid(
            EXECUTE,
            &json!({"installed_plugin_id": 3, "connector_slug": "dws", "account_id": null})
        ));
        assert!(request_valid(
            OAUTH_BEGIN,
            &json!({"installed_plugin_id": 3, "connector_slug": "dws", "account_id": null})
        ));
        // `PluginOAuthFinish` may carry explicit nulls for a failed operation.
        assert!(request_valid(
            OAUTH_FINISH,
            &json!({"connection_id": id, "operation_id": operation_id,
                    "succeeded": false, "attempted": true,
                    "account_id": null, "credential": null})
        ));
        // A successful operation still requires both values.
        assert!(!request_valid(
            OAUTH_FINISH,
            &json!({"connection_id": id, "operation_id": operation_id,
                    "succeeded": true, "attempted": true,
                    "account_id": null, "credential": null})
        ));
        assert!(!request_valid(
            OAUTH_FINISH,
            &json!({"connection_id": id, "operation_id": operation_id,
                    "succeeded": true, "attempted": true,
                    "account_id": "", "credential": "{}"})
        ));
        // `PluginNativeEnrollment.account_label: str = ""` rejects an explicit
        // null; the key may be omitted.
        assert!(request_valid(
            ENROLL,
            &json!({"migration_id": id, "account_id": "u", "credential": "{}"})
        ));
        assert!(!request_valid(
            ENROLL,
            &json!({"migration_id": id, "account_id": "u", "account_label": null,
                    "credential": "{}"})
        ));
        assert!(!request_valid(
            ENROLL,
            &json!({"migration_id": id, "account_id": "u", "account_label": "",
                    "credential": null})
        ));
    }
}
