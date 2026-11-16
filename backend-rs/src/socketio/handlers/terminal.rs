// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/terminal_namespace.py::TerminalNamespace._event_handlers`.

use std::sync::Arc;

use brz_socket_io::{ClientError, ConnectionContext, Reply};
use serde_json::Value;

use crate::socketio::runtime::SocketRuntime;
use crate::socketio::terminal_relay::{self, TerminalSession};
use crate::state::AppState;

/// `on_terminal_attach`: authorize one terminal session and bind the browser
/// socket to its executor.
#[brz_socket_io::event("terminal:attach", namespace = "/terminal")]
async fn attach(
    #[payload] data: Value,
    #[session] session: &TerminalSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    terminal_relay::attach(app, runtime, session, context.id(), data).await
}

/// `on_terminal_ack`: relay a browser output acknowledgement.
#[brz_socket_io::event("terminal:ack", namespace = "/terminal")]
async fn ack(
    #[payload] data: Value,
    #[session] session: &TerminalSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    terminal_relay::ack(app, runtime, session, context.id(), data).await
}

/// `on_terminal_input`: relay browser terminal input.
#[brz_socket_io::event("terminal:input", namespace = "/terminal")]
async fn input(
    #[payload] data: Value,
    #[session] session: &TerminalSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    terminal_relay::input(app, runtime, session, context.id(), data).await
}

/// `on_terminal_resize`: relay a PTY resize and await the executor.
#[brz_socket_io::event("terminal:resize", namespace = "/terminal")]
async fn resize(
    #[payload] data: Value,
    #[session] session: &TerminalSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    terminal_relay::resize(app, runtime, session, context.id(), data).await
}

/// `on_terminal_close`: close the executor PTY and revoke the session record.
#[brz_socket_io::event("terminal:close", namespace = "/terminal")]
async fn close(
    #[payload] data: Value,
    #[session] session: &TerminalSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    terminal_relay::close(app, runtime, session, context.id(), data).await
}
