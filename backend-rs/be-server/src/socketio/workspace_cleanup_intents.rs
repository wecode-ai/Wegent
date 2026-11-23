// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use brz_socket_io::ClientError;
use serde_json::Value;
use wegent_runtime_execution::workspace_cleanup_intents;

use super::{chat_support::internal_error, session::SessionSnapshot};
use crate::state::AppState;

pub(crate) async fn claim(
    state: &AppState,
    snapshot: &SessionSnapshot,
    data: &Value,
) -> Result<Value, ClientError> {
    workspace_cleanup_intents::claim(&state.mysql, registered(snapshot), data)
        .await
        .map_err(|_| internal_error())
}

pub(crate) async fn accept(
    state: &AppState,
    snapshot: &SessionSnapshot,
    data: &Value,
) -> Result<Value, ClientError> {
    workspace_cleanup_intents::accept(&state.mysql, registered(snapshot), data)
        .await
        .map_err(|_| internal_error())
}

fn registered(snapshot: &SessionSnapshot) -> Option<(i64, &str)> {
    let device_id = snapshot
        .device
        .device_id
        .as_deref()
        .or(snapshot.device.reported_device_id.as_deref())
        .filter(|device_id| !device_id.is_empty())?;
    (snapshot.user_id != 0).then_some((snapshot.user_id, device_id))
}
