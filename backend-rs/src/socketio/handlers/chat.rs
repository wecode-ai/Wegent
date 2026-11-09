// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/chat_namespace.py::ChatNamespace._event_handlers`.

use std::sync::Arc;

use brz_socket_io::{ClientError, ConnectionContext, Reply};
use serde_json::Value;

use super::placeholder;
use crate::socketio::chat_session::ChatSession;
use crate::socketio::chat_task_join;
use crate::socketio::runtime::SocketRuntime;
use crate::state::AppState;

/// `on_task_join`.
#[brz_socket_io::event("task:join", namespace = "/chat")]
async fn join_task(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    chat_task_join::join_task(app, runtime, session, context.id(), data).await
}

placeholder!("/chat", "chat:send", send);
placeholder!("/chat", "chat:cancel", cancel);
placeholder!("/chat", "chat:resume", resume);
placeholder!("/chat", "chat:retry", retry);
placeholder!("/chat", "chat:guide", guide);
placeholder!("/chat", "task:leave", leave_task);
placeholder!("/chat", "task:close-session", close_session);
placeholder!("/chat", "history:sync", history_sync);
placeholder!("/chat", "skill:response", skill_response);
