// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/wework_runtime_namespace.py::WeworkRuntimeNamespace`.

use std::sync::Arc;

use brz_socket_io::{ClientError, Reply};
use serde_json::Value;

use crate::socketio::project_chat_events;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::runtime_request;
use crate::state::AppState;

/// `on_runtime_request`: relay one app IPC-style runtime request to an online
/// executor.
#[brz_socket_io::event("runtime:request", namespace = "/wework-runtime")]
async fn request(
    #[payload] data: Value,
    #[auth] user: &super::AuthenticatedUser,
    #[session] session: &crate::socketio::mcp_app_ownership::Ownership,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    let ack = runtime_request::handle(app, user.identity(), session, data).await?;
    Ok(Reply::payload(ack))
}

/// `on_project_chat_subscribe`.
#[brz_socket_io::event("wework:project_chat:subscribe", namespace = "/wework-runtime")]
async fn subscribe(
    #[payload] data: Value,
    #[auth] user: &super::AuthenticatedUser,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    project_chat_events::subscribe(app, user.identity().user_id, data).await
}

/// `on_project_chat_unsubscribe`.
#[brz_socket_io::event("wework:project_chat:unsubscribe", namespace = "/wework-runtime")]
async fn unsubscribe(#[payload] data: Value) -> Result<Reply<Value>, ClientError> {
    project_chat_events::unsubscribe(data).await
}

/// `on_project_chat_message_send`.
#[brz_socket_io::event("wework:project_chat:message:send", namespace = "/wework-runtime")]
async fn send_message(
    #[payload] data: Value,
    #[auth] user: &super::AuthenticatedUser,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    let identity = user.identity();
    project_chat_events::send(app, runtime, identity.user_id, &identity.user_name, data).await
}

/// `on_project_chat_agent_start`.
#[brz_socket_io::event("wework:project_chat:agent:start", namespace = "/wework-runtime")]
async fn start_agent(
    #[payload] data: Value,
    #[auth] user: &super::AuthenticatedUser,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    project_chat_events::agent_start(app, runtime, user.identity().user_id, data).await
}

/// `on_project_chat_execution_snapshot`: persist the authenticated device
/// owner's execution facts and return the changed activity views.
#[brz_socket_io::event(
    "wework:project_chat:execution:snapshot",
    namespace = "/wework-runtime"
)]
async fn snapshot(
    #[payload] data: Value,
    #[auth] user: &super::AuthenticatedUser,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<crate::socketio::runtime::SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    let ack = crate::socketio::project_chat_snapshot::handle(
        app,
        runtime,
        user.identity().user_id,
        &data,
    )
    .await;
    Ok(Reply::payload(ack))
}

/// `on_project_chat_agent_failed`.
#[brz_socket_io::event("wework:project_chat:agent:failed", namespace = "/wework-runtime")]
async fn agent_failed(
    #[payload] data: Value,
    #[auth] user: &super::AuthenticatedUser,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    project_chat_events::agent_failed(app, runtime, user.identity().user_id, data).await
}

/// `on_project_chat_comment_execute`.
#[brz_socket_io::event("wework:project_chat:comment:execute", namespace = "/wework-runtime")]
async fn execute_comment(
    #[payload] data: Value,
    #[auth] user: &super::AuthenticatedUser,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<crate::socketio::runtime::SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    project_chat_events::comment_execute(app, runtime, user.identity().user_id, data).await
}
