// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_execution_runtime_event_sync` (`device_namespace.py:1011`): project one
//! `/local-executor` Responses event onto the matching robot execution.
//!
//! The Source runs this in a worker thread with its own request-scoped session
//! and swallows every failure, so a write-back never fails the socket event.
//! It resolves the execution once for the previous loop-item version, then
//! hands the event to `handle_runtime_event`, which re-resolves the device and
//! the execution; both reads are observable Source dependencies.

use brz_mysql::{MysqlResult, MysqlTransaction};

use super::{
    RuntimeIdentity, execution_for_runtime, handle_runtime_event, non_binding_runtime_event,
    owned_identity_ids,
};
use crate::state::AppState;

pub(crate) async fn write_back_execution_event(
    state: &AppState,
    runtime: &crate::socketio::runtime::SocketRuntime,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) {
    let device_id = device_id.to_owned();
    let result = state
        .mysql
        .with_transaction(async |transaction| {
            write_back_in_transaction(transaction, user_id, &device_id, identity).await
        })
        .await;
    match result {
        Ok(Some(effects)) => effects.deliver(state, runtime).await,
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(
                %error,
                user_id,
                device_id,
                event = identity.event_name,
                task = identity.runtime_task_id,
                "execution runtime event write-back failed"
            );
        }
    }
}

/// The statement sequence `_execution_runtime_event_sync` issues.
async fn write_back_in_transaction<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<super::lifecycle::Effects>> {
    let task_id = identity.runtime_task_id.clone();
    let ids = owned_identity_ids(transaction, user_id, device_id).await?;
    // `execution_for_runtime` returns early without a query when the device
    // identity did not resolve.
    if ids.is_empty() {
        return Ok(None);
    }
    let execution =
        execution_for_runtime(transaction, &ids, &task_id, Some(user_id), false).await?;
    let version = super::lifecycle::item_version(transaction, execution.as_ref()).await?;
    // Source `handle_runtime_event` dismisses thread metadata, Goal and
    // lifecycle notifications before it re-resolves anything.
    if non_binding_runtime_event(identity.event_name) {
        return Ok(None);
    }
    let handle_ids = owned_identity_ids(transaction, user_id, device_id).await?;
    if handle_ids.is_empty() {
        return Ok(None);
    }
    let Some(row) =
        execution_for_runtime(transaction, &handle_ids, &task_id, Some(user_id), false).await?
    else {
        return Ok(None);
    };
    let mut messages = Vec::new();
    let matched = handle_runtime_event(transaction, row, identity, &mut messages).await?;
    super::lifecycle_effects(transaction, matched, version, identity, messages)
        .await
        .map(Some)
}
