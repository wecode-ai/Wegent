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
mod revocations;
pub(crate) mod route;

use serde_json::{Value, json};

use crate::socketio::session::SessionSnapshot;
use crate::state::AppState;

/// `operation="oauth_revocations"`.
pub(crate) const OAUTH_REVOCATIONS: &str = "oauth_revocations";
/// `operation="automatic"`.
pub(crate) const AUTOMATIC: &str = "automatic";

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
) -> Value {
    let user_id = session.user_id;
    let Some(runtime_id) = session.device.device_id.clone() else {
        return refused(DEVICE_NOT_REGISTERED);
    };
    let Some(instance_id) = session.device.runtime_instance_id.clone() else {
        return refused(DEVICE_NOT_REGISTERED);
    };
    // `runtime_route_resolver.resolve`: owned identity plus its live socket.
    let identity = match route::identity(&state.mysql, user_id, &runtime_id).await {
        Ok(Some(identity)) => identity,
        Ok(None) => return refused(ROUTE_DEVICE_NOT_FOUND),
        Err(_) => return refused(EXCHANGE_FAILED),
    };
    let Some(online) = route::online(state, user_id, &identity.runtime_device_id).await else {
        return refused(ROUTE_DEVICE_OFFLINE);
    };
    let online_socket = online
        .get("socket_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    if online_socket.is_empty() {
        return refused(ROUTE_RUNTIME_MISSING);
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
        return refused(ROUTE_RUNTIME_MISSING);
    }
    if online_socket != socket_id
        || identity.runtime_device_id != runtime_id
        || identity.runtime_instance_id.as_deref() != Some(instance_id.as_str())
    {
        return refused(STALE_DEVICE_SOCKET);
    }
    // `_exchange_sync`: `configure_plugin_session` makes this session READ
    // COMMITTED before its first query, and the identity re-read, the reads
    // after the Redis wait, the coordination and the revision CAS all run
    // there. The plugin write lease outlives the transaction because Source
    // releases it from `after_transaction_end`, never before COMMIT.
    let options = brz_mysql::MysqlTransactionOptions::default()
        .with_isolation_level(brz_mysql::MysqlIsolationLevel::ReadCommitted);
    if operation == AUTOMATIC {
        // The lease is taken inside the transaction, after the identity/stale
        // checks and the payload validation, exactly like `reconcile` obtains
        // it; the outer holder lets it outlive COMMIT/ROLLBACK.
        let mut lease_slot: Option<automation::Lease<'_>> = None;
        let outcome = state
            .mysql
            .with_transaction_options(options, async |transaction| {
                recheck_identity(transaction, user_id, &runtime_id, &instance_id).await?;
                if automation::installed_plugin_ids(data).is_none() {
                    return Err(exchange_error(INVALID_REQUEST));
                }
                let lease = automation::acquire_lease(state, user_id)
                    .await
                    .map_err(exchange_error)?;
                lease_slot = Some(lease);
                automation::reconcile_on(
                    transaction,
                    lease_slot.as_ref().expect("lease"),
                    user_id,
                    &runtime_id,
                    data,
                )
                .await
                .map_err(exchange_error)
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
        return exchange_reply(outcome);
    }
    let outcome = state
        .mysql
        .with_transaction_options(options, async |transaction| {
            recheck_identity(transaction, user_id, &runtime_id, &instance_id).await?;
            if operation == OAUTH_REVOCATIONS {
                if !data.as_object().is_some_and(serde_json::Map::is_empty) {
                    return Err(exchange_error(INVALID_REQUEST));
                }
                revocations::pending_on(transaction, user_id, &runtime_id)
                    .await
                    .map(|ids| json!({"success": true, "connection_ids": ids}))
                    .map_err(exchange_error)
            } else {
                Err(exchange_error(INVALID_OPERATION))
            }
        })
        .await;
    exchange_reply(outcome)
}

/// `_exchange_sync` re-resolves the route on its own session and rejects a
/// socket that no longer matches the persisted identity.
async fn recheck_identity<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    runtime_id: &str,
    instance_id: &str,
) -> Result<(), brz_mysql::MysqlError> {
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
    Ok(())
}

fn exchange_error(code: &'static str) -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: code.to_owned(),
    }
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
}
