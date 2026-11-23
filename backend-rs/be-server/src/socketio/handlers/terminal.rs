// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/terminal_namespace.py::TerminalNamespace._event_handlers`.

use std::sync::Arc;

use brz_socket_io::{ClientError, ConnectionContext, Reply};
use serde_json::Value;
use wegent_terminal::TerminalSession;

use crate::socketio::runtime::SocketRuntime;
use crate::socketio::terminal_transport::SocketTerminalTransport;
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
    let transport = SocketTerminalTransport::new(app, runtime);
    wegent_terminal::attach(app.redis.as_ref(), &transport, session, context.id(), data).await
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
    let transport = SocketTerminalTransport::new(app, runtime);
    wegent_terminal::ack(&transport, session, context.id(), data).await
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
    let transport = SocketTerminalTransport::new(app, runtime);
    wegent_terminal::input(&transport, session, context.id(), data).await
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
    let transport = SocketTerminalTransport::new(app, runtime);
    wegent_terminal::resize(&transport, session, context.id(), data).await
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
    let transport = SocketTerminalTransport::new(app, runtime);
    wegent_terminal::close(app.redis.as_ref(), &transport, session, context.id(), data).await
}
