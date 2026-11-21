// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `reconcile=true` branch of `POST /api/plugins/installed/sync-device`.
//!
//! Source: `app/api/endpoints/installed_plugins.py::reconcile_device_plugins`
//! -> `plugin_reconciliation.reconcile_device_plugins` ->
//! `plugin_device_installation_service.desired_plugins` /
//! `record_reconciliation_result`. The request-session reads and the dispatch
//! primitive stay in the parent module; this module owns the plugins-only
//! snapshot, the `scope="plugins"` acknowledgement requirements, and the
//! conditional persistence of an acknowledged snapshot.

use super::*;
use crate::device_identity::resolve_plugin_runtime_device_id_on;
use crate::plugins_installed::desired_capabilities::{BuildError, build_desired_plugins_on};
use crate::plugins_installed::online_route::supports_plugin_delta;
use crate::plugins_installed::plugin_sync_protocol::{
    load_versioned_plugins_payload, lock_plugin_sync_state, touch_desired_state,
    write_sync_state_document,
};
use crate::plugins_installed::record_sync_result::SyncItem;
use crate::plugins_installed::write_coordination;

/// Outcome of the reconcile branch's request-session reads: the authenticated
/// user and the resolved runtime device, or the exact rejection.
enum ReconcileSession {
    Rejected(FastApiError),
    Resolved {
        user_id: i64,
        device_id: Option<String>,
    },
}

/// Source `reconcile_device_plugins`: dispatch the plugins-only payload and
/// require the executor's `scope="plugins"` acknowledgement.
pub(super) async fn reconcile_device_plugins(
    state: &AppState,
    actor: &auth::SyncDeviceUser,
    device_id: &str,
) -> Result<Value, FastApiError> {
    let normalized_device_id = device_id.trim();
    if normalized_device_id.is_empty() {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "device_id is required",
        ));
    }
    // `current_user` is the auth dependency's row, read on the same request
    // session the endpoint receives. A device key resolves through
    // `verify_api_key` (`api_keys` + its active owner); the JWT path reads the
    // active `users` row. The source's `get_plugin_db` cache hands both the
    // endpoint and this dependency the same READ COMMITTED session, so the auth
    // reads and the device resolution reads form one transaction on one
    // connection. `with_transaction_options` opens it with the source's NEXT
    // scope `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`, which shares this
    // session's recorded Level; the read-only group is then closed by the
    // transaction's own end.
    let resolved = {
        // A read-only group still ends as the source's `db.close()` ROLLBACK,
        // not a commit. `with_transaction_options` commits an `Ok`, so capture
        // the outcome and return a sentinel error to roll this transaction back.
        let mut slot: Option<ReconcileSession> = None;
        let result = state
            .mysql
            .with_transaction_options(
                MysqlTransactionOptions::default()
                    .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
                async |transaction| {
                    let mut session = &mut *transaction;
                    let user_id = match &actor.api_key {
                        Some(api_key) => {
                            match auth::verify_personal_api_key_on(&mut session, api_key).await? {
                                Some(user) => user.id,
                                None => {
                                    slot = Some(ReconcileSession::Rejected(
                                        FastApiError::unauthorized(auth::INVALID_API_KEY_DETAIL),
                                    ));
                                    return Err(request_session_rollback());
                                }
                            }
                        }
                        None => match session_user(&mut session, &actor.user_name).await? {
                            Ok(user) => user.id,
                            Err(rejection) => {
                                slot = Some(ReconcileSession::Rejected(rejection));
                                return Err(request_session_rollback());
                            }
                        },
                    };
                    // `resolve_plugin_runtime_device_id` on the request session (`kinds` reads).
                    let device_id = resolve_plugin_runtime_device_id_on(
                        &mut session,
                        user_id,
                        normalized_device_id,
                    )
                    .await?;
                    slot = Some(ReconcileSession::Resolved { user_id, device_id });
                    Err(request_session_rollback())
                },
            )
            .await;
        match result {
            Err(MysqlError::InvalidQuery { reason }) if reason == ROLLBACK_REASON => {
                slot.expect("the request-session transaction recorded its outcome")
            }
            Err(error) => {
                tracing::error!(%error, "plugin reconcile session reads failed");
                return Err(FastApiError::unhandled());
            }
            Ok(()) => unreachable!("the request-session transaction always rolls back"),
        }
    };
    let (user_id, device_id) = match resolved {
        ReconcileSession::Rejected(rejection) => return Err(rejection),
        ReconcileSession::Resolved { user_id, device_id } => (user_id, device_id),
    };
    let Some(device_id) = device_id else {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Device not found",
        ));
    };
    let versioned = supports_plugin_delta(state, user_id, &device_id).await;
    // Repair catalog references before taking the ordered complete snapshot.
    if versioned {
        desired_plugins(state, user_id, &device_id).await?;
    }
    let mut payload = load_plugins_payload(state, user_id, &device_id, versioned).await?;
    for _attempt in 0..DESIRED_STATE_SYNC_ATTEMPTS {
        let result = sync_device_payload(
            state,
            user_id,
            &device_id,
            &payload,
            None,
            SYNC_TIMEOUT_SECONDS,
        )
        .await?;
        if !result.success || !result.errors.is_empty() || result.plugins.iter().any(is_failed_item)
        {
            return Err(FastApiError::detail(
                brz_http_server::StatusCode::BAD_GATEWAY,
                reconciliation_failure_detail(&result),
            ));
        }
        if result.scope.as_str() != Some("plugins") {
            return Err(FastApiError::detail(
                brz_http_server::StatusCode::CONFLICT,
                "Update the desktop runtime to reconcile plugins",
            ));
        }
        let latest =
            record_reconciliation_result(state, user_id, &device_id, &payload, &result).await?;
        if let Some(latest) = latest {
            payload = if versioned {
                load_plugins_payload(state, user_id, &device_id, true).await?
            } else {
                latest
            };
            continue;
        }
        let mut response = serde_json::Map::new();
        response.insert("reconciled".to_string(), Value::Bool(true));
        response.insert("deviceId".to_string(), Value::String(device_id.clone()));
        response.insert("pendingCount".to_string(), Value::from(0));
        response.insert("sync".to_string(), result.response("merge"));
        return Ok(Value::Object(response));
    }
    Err(FastApiError::detail(
        brz_http_server::StatusCode::CONFLICT,
        "Plugin installations changed during reconciliation; refresh again",
    ))
}

/// `load_payload` of `reconcile_device_plugins`: the versioned loader bumps the
/// ordered snapshot generation; every other device takes the legacy desired
/// state.
async fn load_plugins_payload(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    versioned: bool,
) -> Result<Value, FastApiError> {
    if versioned {
        load_versioned_plugins_payload(state, user_id, device_id)
            .await
            .map_err(|error| {
                log_build_error(user_id, &error);
                FastApiError::unhandled()
            })
    } else {
        desired_plugins(state, user_id, device_id).await
    }
}

/// Source `record_reconciliation_result`: validate the acknowledged snapshot
/// under one write lease and persist the device rows only when it is current.
///
/// Returns the freshly built desired state when installations changed while the
/// device was acknowledging; the caller retries with the newer snapshot.
async fn record_reconciliation_result(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    payload: &Value,
    result: &SyncResult,
) -> Result<Option<Value>, FastApiError> {
    let ids = sync_result_installation_ids(result);
    let lease = acquire_sync_installations(state, user_id, ids.as_deref())
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "reconcile result lease acquisition failed");
            FastApiError::unhandled()
        })?;
    let mut build_error: Option<BuildError> = None;
    let outcome = state
        .mysql
        .with_transaction_options(
            MysqlTransactionOptions::default()
                .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
            async |transaction| {
                let mut session = &mut *transaction;
                let revisions = lease.read_plugin_revisions(&mut *session).await?;
                let sync_state = lock_plugin_sync_state(&mut session, user_id).await?;
                let latest = match build_desired_plugins_on(&mut session, user_id, device_id).await
                {
                    Ok(latest) => latest,
                    Err(error) => {
                        build_error = Some(error);
                        return Err(write_coordination::coordination_error(
                            "plugin_sync_desired_state_failed",
                        ));
                    }
                };
                let outdated = plugin_snapshot(&latest) != plugin_snapshot(payload)
                    || result
                        .plugins
                        .iter()
                        .any(|item| item.status.as_str() == Some("superseded"));
                if outdated {
                    return Ok(Some(latest));
                }
                write_sync_state_document(
                    &mut session,
                    sync_state.id,
                    user_id,
                    &crate::json_compat::python_json_value(&sync_state.json),
                    true,
                )
                .await?;
                record_device_sync_result_for_installs(
                    &mut session,
                    user_id,
                    result,
                    Some(&lease),
                    lease.installation_ids(),
                )
                .await?;
                lease
                    .commit_plugin_revisions(&mut *session, revisions)
                    .await?;
                Ok(None)
            },
        )
        .await;
    lease.release().await;
    match (outcome, build_error) {
        (_, Some(error)) => {
            log_build_error(user_id, &error);
            Err(FastApiError::unhandled())
        }
        (Ok(latest), None) => Ok(latest),
        (Err(error), None) => {
            tracing::error!(%error, user_id, "reconcile result recording failed");
            Err(FastApiError::unhandled())
        }
    }
}

/// Source `desired_plugins`: repair catalog refs under the account write lease,
/// then build the plugins-only merge payload in the same session.
async fn desired_plugins(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<Value, FastApiError> {
    let lease = acquire_sync_installations(state, user_id, None)
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "reconcile catalog lease acquisition failed");
            FastApiError::unhandled()
        })?;
    let mut build_error: Option<BuildError> = None;
    let outcome = state
        .mysql
        .with_transaction_options(
            MysqlTransactionOptions::default()
                .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
            async |transaction| {
                let mut session = &mut *transaction;
                let revisions = lease.read_plugin_revisions(&mut *session).await?;
                let changed = reconcile_installed_catalog_refs(
                    &mut session,
                    state.redis.as_ref(),
                    &state.entity_resolvers,
                    user_id,
                    lease.installation_ids(),
                )
                .await?;
                let payload = match build_desired_plugins_on(&mut session, user_id, device_id).await
                {
                    Ok(payload) => payload,
                    Err(error) => {
                        build_error = Some(error);
                        return Err(write_coordination::coordination_error(
                            "plugin_sync_desired_state_failed",
                        ));
                    }
                };
                if changed > 0 {
                    touch_desired_state(&mut session, user_id).await?;
                    lease
                        .commit_plugin_revisions(&mut *session, revisions)
                        .await?;
                }
                Ok(payload)
            },
        )
        .await;
    lease.release().await;
    match (outcome, build_error) {
        (_, Some(error)) => {
            log_build_error(user_id, &error);
            Err(FastApiError::unhandled())
        }
        (Ok(payload), None) => Ok(payload),
        (Err(error), None) => {
            tracing::error!(%error, user_id, "reconcile catalog refresh failed");
            Err(FastApiError::unhandled())
        }
    }
}

fn is_failed_item(item: &SyncItem) -> bool {
    item.status.as_str() == Some("failed")
}

/// Source `plugin_snapshot`: signed URLs and expirations are excluded, and
/// plugins are ordered by installed id.
fn plugin_snapshot(payload: &Value) -> Value {
    let mut plugins: Vec<Value> = payload
        .get("plugins")
        .and_then(Value::as_array)
        .map(|plugins| {
            plugins
                .iter()
                .map(|plugin| {
                    let mut object = serde_json::Map::new();
                    if let Value::Object(source) = plugin {
                        for (key, value) in source {
                            if key == "download_path" || key == "download_url_expires_at" {
                                continue;
                            }
                            object.insert(key.clone(), value.clone());
                        }
                    }
                    Value::Object(object)
                })
                .collect()
        })
        .unwrap_or_default();
    plugins.sort_by_key(|plugin| {
        plugin
            .get("installed_plugin_id")
            .map(python_text)
            .unwrap_or_default()
    });
    Value::Array(plugins)
}

/// `str(value)` for the snapshot sort key.
fn python_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => (if *value { "True" } else { "False" }).to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

/// Source `reconciliation_failure_detail`.
pub(super) fn reconciliation_failure_detail(result: &SyncResult) -> String {
    if let Some(failed) = result
        .plugins
        .iter()
        .find(|item| item.status.as_str() == Some("failed"))
    {
        let identity = failed
            .name
            .as_str()
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| {
                failed
                    .id
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| failed.id.as_i64().map(|id| id.to_string()))
            })
            .unwrap_or_else(|| "plugin".to_string());
        let reason = failed
            .error_code
            .as_str()
            .filter(|code| !code.is_empty())
            .or_else(|| failed.stage.as_str().filter(|stage| !stage.is_empty()))
            .or_else(|| failed.error.as_str().filter(|error| !error.is_empty()))
            .unwrap_or("device_sync_failed");
        return format!("Plugin reconciliation failed for {identity}: {reason}");
    }
    match &result.error {
        Some(error) if !error.is_empty() => format!("Plugin reconciliation failed: {error}"),
        _ => "Plugin reconciliation failed on the current device".to_string(),
    }
}
