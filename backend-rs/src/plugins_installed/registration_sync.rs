// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Registration-time capability follow-up.
//!
//! Source: `app/api/ws/device_namespace.py::
//! _sync_global_capabilities_to_registered_device` ->
//! `plugin_marketplace_service.reconcile_stale_installed_catalog_refs` ->
//! `plugin_device_installation_service.ensure_pending_for_device` ->
//! `device_capability_sync_service.sync_current_device_capabilities` ->
//! `_record_registration_sync_result`.
//!
//! The HTTP sync-device endpoint owns the request-scoped path in
//! [`super::sync_device`]; this module reuses its desired-state builder, route
//! resolution and result persistence for the socket-owned follow-up.

use std::time::Duration;

use serde_json::Value;

use crate::state::AppState;

use super::desired_capabilities::{
    build_desired_capabilities_for_registration, capability_snapshot,
};
use super::online_route::{OnlineRouteResolution, resolve_online_route, supports_plugin_delta};
use super::record_sync_result::SyncResult;
use super::sync_device::{DESIRED_STATE_SYNC_ATTEMPTS, ack_argument, log_build_error};

/// `REGISTER_CAPABILITY_SYNC_TIMEOUT_SECONDS`: the registration-time deadline.
pub(crate) const REGISTER_CAPABILITY_SYNC_TIMEOUT_SECONDS: Duration = Duration::from_secs(120);

/// `_prepare_plugins_for_registered_device`'s outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PluginPreparation {
    /// Plugin coordination succeeded; the desired state includes plugins.
    Ready,
    /// The source's `PluginWriteError` category defers plugins to a later sync.
    Deferred,
    /// Any other failure aborts the best-effort follow-up.
    Failed,
}

/// Source `_prepare_plugins_for_registered_device`: reconcile catalog refs and
/// pending installs in one committed session before loading desired state.
pub(crate) async fn prepare_plugins_for_registered_device(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> PluginPreparation {
    // `reconcile_stale_installed_catalog_refs` holds the plugin write lease
    // (`plugin_marketplace_service.py:173`) and the source's `before_commit`
    // hook flushes the pending writes and then advances the policy revision in
    // the same transaction (`plugin_write_coordination.py:243-256`).
    let lease = match async {
        super::plugin_sync_protocol::ensure_sync_state(&state.mysql, state.redis.as_ref(), user_id)
            .await?;
        super::write_coordination::PluginWriteLease::acquire_installed(
            &state.mysql,
            state.redis.as_ref(),
            user_id,
            None,
        )
        .await
    }
    .await
    {
        Ok(lease) => lease,
        Err(error) if super::write_coordination::is_plugin_write_error(&error) => {
            return PluginPreparation::Deferred;
        }
        Err(error) => {
            tracing::error!(%error, user_id, "Plugin write lease acquisition failed");
            return PluginPreparation::Failed;
        }
    };
    let outcome = state
        .mysql
        .with_transaction_options(
            brz_mysql::MysqlTransactionOptions::default()
                .with_isolation_level(brz_mysql::MysqlIsolationLevel::ReadCommitted),
            async |transaction| {
                let mut session = &mut *transaction;
                // `read_policy_revision` runs before the writes on the primary
                // connection the transaction already owns; a missing, duplicated,
                // malformed or inactive policy skips only the revision CAS, while
                // transport failures stay errors.
                let revisions = lease.read_plugin_revisions(&mut *session).await?;
                // Source initial acquire: the policy read is followed by the
                // lease's `owned` GET before any business read.
                lease.verify_owned().await?;
                let changed = super::catalog_reconcile::reconcile_installed_catalog_refs(
                    &mut session,
                    state.redis.as_ref(),
                    &state.entity_resolvers,
                    user_id,
                    lease.installation_ids(),
                )
                .await?;
                // `ensure_pending_for_device` enters
                // `reconcile_plugin_device_rows`, whose reentrant acquire only
                // checks ownership again (no second SET).
                lease.verify_owned().await?;
                super::sync_device::ensure_pending_for_installs(
                    &mut session,
                    user_id,
                    device_id,
                    Some(&lease),
                    lease.installation_ids(),
                )
                .await?;
                if changed > 0 {
                    super::plugin_sync_protocol::touch_desired_state(&mut session, user_id).await?;
                }
                lease
                    .commit_plugin_revisions(&mut *session, revisions)
                    .await
            },
        )
        .await;
    lease.release().await;
    match outcome {
        Ok(_) => PluginPreparation::Ready,
        Err(error) if super::write_coordination::is_plugin_write_error(&error) => {
            tracing::warn!(
                user_id,
                device_id,
                "Plugin coordination deferred after registration; syncing Skills/MCP only"
            );
            PluginPreparation::Deferred
        }
        Err(error) => {
            tracing::error!(%error, user_id, device_id, "Registration plugin preparation failed");
            PluginPreparation::Failed
        }
    }
}

/// Source `_record_registration_sync_result`: persist the round trip in a
/// fresh committed session after the device acknowledged the snapshot.
pub(crate) async fn record_registration_sync_result(
    state: &AppState,
    user_id: i64,
    result: &SyncResult,
) {
    // `_record_registration_sync_result` -> `record_device_sync_result` ->
    // `reconcile_plugin_device_rows` holds its own plugin write lease for this
    // second root transaction (`plugin_device_identity.py:118-124`), with the
    // source's `before_flush`/`before_commit` ownership checks and revision
    // advance.
    let lease = match async {
        super::plugin_sync_protocol::ensure_sync_state(&state.mysql, state.redis.as_ref(), user_id)
            .await?;
        super::write_coordination::PluginWriteLease::acquire_installed(
            &state.mysql,
            state.redis.as_ref(),
            user_id,
            None,
        )
        .await
    }
    .await
    {
        Ok(lease) => lease,
        Err(error) => {
            tracing::error!(%error, user_id, "Sync result plugin write lease failed");
            return;
        }
    };
    let outcome = state
        .mysql
        .with_transaction_options(
            brz_mysql::MysqlTransactionOptions::default()
                .with_isolation_level(brz_mysql::MysqlIsolationLevel::ReadCommitted),
            async |transaction| {
                let mut session = &mut *transaction;
                // Source order: policy SELECT, then the initial ownership
                // check, then the business reads; the commit check follows.
                let revisions = lease.read_plugin_revisions(&mut *session).await?;
                lease.verify_owned().await?;
                super::record_sync_result::record_device_sync_result_for_installs(
                    &mut session,
                    user_id,
                    result,
                    Some(&lease),
                    lease.installation_ids(),
                )
                .await?;
                lease
                    .commit_plugin_revisions(&mut *session, revisions)
                    .await
            },
        )
        .await;
    lease.release().await;
    if let Err(error) = outcome {
        tracing::error!(
            %error,
            user_id,
            device_id = result.device_id,
            "Registration capability sync result persistence failed"
        );
    }
}

/// One capability-sync dispatch outcome for a registration-time caller.
pub(crate) enum DispatchOutcome {
    /// The device acknowledged with the source's positional argument list.
    Ack(Value),
    /// The dispatch never reached or never answered the device; the value is
    /// the source's `str(exc)` replacement.
    Failure(&'static str),
    /// Shutdown interrupted the source's pending callback wait, so the source
    /// never produces (or persists) a sync result for this registration.
    Cancelled,
}

/// Dispatch one `device:sync_capabilities` payload to a live socket.
///
/// Registration owns the socket itself, so it delivers locally and publishes
/// the adapter message; the HTTP sync-device path keeps the process-owned
/// Redis RPC. Both share the resolve/build/retry/record pipeline below.
pub(crate) trait CapabilityDispatch {
    fn dispatch(
        &self,
        socket_id: &str,
        payload: &Value,
        timeout: Duration,
    ) -> impl std::future::Future<Output = DispatchOutcome> + Send;
}

/// Source `sync_current_device_capabilities` for the registration follow-up:
/// build desired state, dispatch, and reload until the snapshot is stable.
///
/// Returns `None` when a desired-state build failed (the source's outer
/// best-effort handler logs and stops); `include_plugins` chooses the payload
/// shape and whether the round trip is persisted. A device that advertises the
/// versioned plugin protocol receives a `plugin_sync` snapshot instead of the
/// legacy desired-state payload.
pub(crate) async fn sync_registration_capabilities<D: CapabilityDispatch>(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    include_plugins: bool,
    dispatch: &D,
) -> Option<SyncResult> {
    // `sync_current_device_capabilities`: the route is resolved once before
    // the build to negotiate the plugin protocol; the result selects the
    // versioned loader for every build and reload in this round trip.
    let versioned = include_plugins && supports_plugin_delta(state, user_id, device_id).await;
    let mut payload =
        match build_registration_payload(state, user_id, device_id, include_plugins, versioned)
            .await
        {
            Ok(payload) => payload,
            Err(()) => return None,
        };
    let mut last: Option<SyncResult> = None;
    for _attempt in 1..=DESIRED_STATE_SYNC_ATTEMPTS {
        let route = match resolve_online_route(state, user_id, device_id).await {
            Ok(OnlineRouteResolution::Ready(route)) => route,
            Ok(OnlineRouteResolution::Unavailable(reason)) => {
                return Some(snapshot_failure(device_id, &payload, versioned, reason));
            }
            Err(error) => {
                tracing::error!(?error, user_id, "registration capability route read failed");
                return None;
            }
        };
        if versioned
            && !super::plugin_sync_protocol::supports_plugin_sync_v2(
                route.online.get("runtime_features"),
            )
        {
            return Some(snapshot_failure(
                device_id,
                &payload,
                versioned,
                "Device plugin sync capability changed; retry synchronization",
            ));
        }
        if versioned
            && let Err(error) = super::plugin_sync_protocol::register_plugin_snapshot_intent(
                state, user_id, device_id, &payload,
            )
            .await
        {
            tracing::error!(
                %error,
                user_id,
                device_id,
                "plugin snapshot intent registration failed"
            );
            return Some(snapshot_failure(
                device_id,
                &payload,
                versioned,
                &error.to_string(),
            ));
        }
        let mut dispatch_payload = payload.clone();
        if let Value::Object(object) = &mut dispatch_payload {
            object.insert(
                "device_id".to_string(),
                Value::String(route.runtime_device_id),
            );
        }
        let mut result = match dispatch
            .dispatch(
                &route.socket_id,
                &dispatch_payload,
                REGISTER_CAPABILITY_SYNC_TIMEOUT_SECONDS,
            )
            .await
        {
            DispatchOutcome::Ack(args) => {
                let ack = ack_argument(&args);
                if versioned
                    && let Some(error) =
                        super::plugin_sync_protocol::validate_plugin_ack(&payload, ack)
                {
                    return Some(snapshot_failure(device_id, &payload, versioned, error));
                }
                SyncResult::from_ack(device_id, ack)
            }
            DispatchOutcome::Failure(reason) => SyncResult::failure(device_id, None, reason),
            // The process is stopping, so the source's callback wait never
            // reaches a result and nothing may be persisted.
            DispatchOutcome::Cancelled => return None,
        };
        if versioned {
            result.desired_plugin_snapshot = Some(payload.clone());
        }
        if !result.acknowledged {
            return Some(result);
        }
        let latest =
            match build_registration_payload(state, user_id, device_id, include_plugins, versioned)
                .await
            {
                Ok(payload) => payload,
                Err(()) => return None,
            };
        if capability_snapshot(&latest) == capability_snapshot(&payload) {
            return Some(result);
        }
        tracing::warn!(
            user_id,
            device_id,
            "capability desired state changed during registration sync; retrying latest snapshot"
        );
        payload = latest;
        last = Some(result);
    }
    Some(SyncResult::failure(
        device_id,
        last,
        "Capability desired state kept changing during synchronization",
    ))
}

/// One failed versioned round trip; the source keeps the desired snapshot so
/// the result recording can still fence the acknowledged generation.
fn snapshot_failure(device_id: &str, payload: &Value, versioned: bool, error: &str) -> SyncResult {
    let mut result = SyncResult::failure(device_id, None, error);
    if versioned {
        result.desired_plugin_snapshot = Some(payload.clone());
    }
    result
}

/// One registration-time desired-state build; a failure stops the follow-up.
async fn build_registration_payload(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    include_plugins: bool,
    versioned: bool,
) -> Result<Value, ()> {
    let built = if versioned {
        super::plugin_sync_protocol::load_versioned_registration_payload(
            state,
            user_id,
            device_id,
            include_plugins,
            true,
        )
        .await
    } else {
        build_desired_capabilities_for_registration(
            &state.mysql,
            user_id,
            device_id,
            include_plugins,
        )
        .await
    };
    match built {
        Ok(payload) => Ok(payload),
        Err(error) => {
            log_build_error(user_id, &error);
            Err(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_preparation_outcomes_are_distinct() {
        assert_ne!(PluginPreparation::Ready, PluginPreparation::Deferred);
        assert_ne!(PluginPreparation::Deferred, PluginPreparation::Failed);
    }

    #[test]
    fn registration_timeout_matches_the_source_constant() {
        assert_eq!(
            REGISTER_CAPABILITY_SYNC_TIMEOUT_SECONDS,
            Duration::from_secs(120)
        );
    }
}
