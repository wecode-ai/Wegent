// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/wework_runtime_namespace.py::WeworkRuntimeNamespace`.

use std::sync::Arc;

use brz_socket_io::{ClientError, Reply};
use serde_json::Value;

use super::placeholder;
use crate::socketio::runtime_request;
use crate::state::AppState;

/// `on_runtime_request`: relay one app IPC-style runtime request to an online
/// executor.
#[brz_socket_io::event("runtime:request", namespace = "/wework-runtime")]
async fn request(
    #[payload] data: Value,
    #[auth] user: &super::AuthenticatedUser,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    let ack = runtime_request::handle(app, user.identity(), data).await?;
    Ok(Reply::payload(ack))
}

placeholder!(
    "/wework-runtime",
    "wework:project_chat:subscribe",
    subscribe
);
placeholder!(
    "/wework-runtime",
    "wework:project_chat:unsubscribe",
    unsubscribe
);
placeholder!(
    "/wework-runtime",
    "wework:project_chat:message:send",
    send_message
);
placeholder!(
    "/wework-runtime",
    "wework:project_chat:agent:start",
    start_agent
);
placeholder!(
    "/wework-runtime",
    "wework:project_chat:execution:snapshot",
    snapshot
);
placeholder!(
    "/wework-runtime",
    "wework:project_chat:agent:failed",
    agent_failed
);
placeholder!(
    "/wework-runtime",
    "wework:project_chat:comment:execute",
    execute_comment
);
