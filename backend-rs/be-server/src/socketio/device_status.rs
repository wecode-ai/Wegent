// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use serde_json::Value;
use wegent_device_lifecycle::device_status;

use super::device_lifecycle::services;
use super::runtime::SocketRuntime;
use super::session::SessionSnapshot;
use crate::state::AppState;

pub async fn status(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    snapshot: &SessionSnapshot,
    socket_id: &str,
    data: &Value,
) -> Value {
    device_status::status(
        &services(state),
        runtime.as_ref(),
        snapshot,
        socket_id,
        data,
    )
    .await
}

pub async fn upgrade_status(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    snapshot: &SessionSnapshot,
    socket_id: &str,
    data: &Value,
) -> Value {
    device_status::upgrade_status(
        &services(state),
        runtime.as_ref(),
        snapshot,
        socket_id,
        data,
    )
    .await
}
