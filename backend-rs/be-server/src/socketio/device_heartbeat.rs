// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use brz_socket_io::{ClientError, Reply};
use serde_json::Value;
use wegent_device_lifecycle::device_heartbeat;
pub(crate) use wegent_device_lifecycle::device_heartbeat::CODEX_RUNTIME;

use super::device_lifecycle::services;
use super::runtime::SocketRuntime;
use super::session::DeviceSession;
use crate::state::AppState;

pub async fn heartbeat(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &DeviceSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    device_heartbeat::heartbeat(&services(state), runtime.clone(), session, socket_id, data).await
}

pub(crate) async fn broadcast_slot_update(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
) -> Result<(), String> {
    device_heartbeat::broadcast_slot_update(&services(state), runtime, user_id, device_id).await
}
