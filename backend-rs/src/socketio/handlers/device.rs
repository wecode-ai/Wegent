// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/device_namespace.py::DeviceNamespace` inbound event exports.

use std::sync::Arc;

use brz_socket_io::{ClientError, ConnectionContext, Reply};
use serde_json::Value;

use super::{AuthenticatedUser, placeholder};
use crate::socketio::device_heartbeat;
use crate::socketio::device_lifecycle;
use crate::socketio::device_runtime_event;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::session::DeviceSession;
use crate::state::AppState;

/// `on_device_register` -> `_register_device_session`.
#[brz_socket_io::event("device:register", namespace = "/local-executor")]
async fn register(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    device_lifecycle::register(app, runtime, session, context.id(), data).await
}

/// `on_device_heartbeat`.
#[brz_socket_io::event("device:heartbeat", namespace = "/local-executor")]
async fn heartbeat(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    device_heartbeat::heartbeat(app, runtime, session, context.id(), data).await
}

placeholder!("/local-executor", "device:status", status);
placeholder!("/local-executor", "device:upgrade_status", upgrade_status);
/// `on_runtime_event`: the relay has no callback, so the reply only carries the
/// source's error shapes when the session is incomplete.
#[brz_socket_io::event("runtime:event", namespace = "/local-executor")]
async fn runtime_event(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    let snapshot = session.snapshot();
    let Some(device_id) = snapshot.device.device_id.clone() else {
        return Ok(Reply::payload(device_runtime_event::unauthenticated()));
    };
    let Value::Object(data) = data else {
        return Ok(Reply::payload(device_runtime_event::invalid_payload()));
    };
    let logical_device_id = snapshot
        .device
        .logical_device_id
        .clone()
        .unwrap_or_else(|| device_id.clone());
    // `_forward_runtime_event` runs under `_get_runtime_event_lock(sid)`.
    let lock = runtime.runtime_event_lock(context.id());
    let _guard = lock.lock().await;
    match device_runtime_event::forward(
        app,
        runtime,
        snapshot.user_id,
        &device_id,
        &logical_device_id,
        &data,
    )
    .await
    {
        Ok(reply) => Ok(Reply::payload(reply)),
        Err(error) => {
            tracing::error!(%error, user_id = snapshot.user_id, device_id, "runtime:event failed");
            Err(ClientError::new(
                "RUNTIME_EVENT_FAILED",
                "Runtime event forwarding failed",
            ))
        }
    }
}
placeholder!(
    "/local-executor",
    "plugin.auth.local_lifecycle",
    local_lifecycle
);
/// `on_plugin_auth_automatic`: `exchange(operation="automatic")`.
#[brz_socket_io::event("plugin.auth.automatic", namespace = "/local-executor")]
async fn automatic(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::plugin_account_auth::exchange(
            app,
            &session.snapshot(),
            context.id(),
            crate::plugin_account_auth::AUTOMATIC,
            &data,
        )
        .await,
    ))
}
placeholder!("/local-executor", "plugin.auth.prepare", prepare);
placeholder!(
    "/local-executor",
    "plugin.auth.transfer.stage",
    transfer_stage
);
placeholder!(
    "/local-executor",
    "plugin.auth.transfer.prepare",
    transfer_prepare
);
placeholder!(
    "/local-executor",
    "plugin.auth.transfer.finish",
    transfer_finish
);
placeholder!(
    "/local-executor",
    "plugin.auth.transfer.abort",
    transfer_abort
);
placeholder!("/local-executor", "plugin.auth.execute", execute);
placeholder!("/local-executor", "plugin.auth.oauth.begin", oauth_begin);
placeholder!("/local-executor", "plugin.auth.oauth.finish", oauth_finish);
/// `on_plugin_auth_oauth_revocations`: `exchange(operation="oauth_revocations")`.
#[brz_socket_io::event("plugin.auth.oauth.revocations", namespace = "/local-executor")]
async fn oauth_revocations(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::plugin_account_auth::exchange(
            app,
            &session.snapshot(),
            context.id(),
            crate::plugin_account_auth::OAUTH_REVOCATIONS,
            &data,
        )
        .await,
    ))
}
placeholder!(
    "/local-executor",
    "plugin.auth.oauth.revoke_begin",
    oauth_revoke_begin
);
placeholder!(
    "/local-executor",
    "plugin.auth.oauth.revoke_finish",
    oauth_revoke_finish
);
placeholder!("/local-executor", "plugin.auth.enroll", enroll);
placeholder!("/local-executor", "plugin.auth.read", read);
/// `on_runtime_tasks_pull`: one Executor-owned execution claim plus its due
/// workspace cleanup intents.
#[brz_socket_io::event("runtime.tasks.pull", namespace = "/local-executor")]
async fn pull_tasks(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::device_pull::pull(app, &session.snapshot(), &data).await?,
    ))
}
placeholder!("/local-executor", "runtime.tasks.accept", accept_tasks);
placeholder!(
    "/local-executor",
    "runtime.workspace_cleanup.claim",
    claim_cleanup
);
placeholder!(
    "/local-executor",
    "runtime.workspace_cleanup.accept",
    accept_cleanup
);
placeholder!("/local-executor", "runtime.tasks.updated", tasks_updated);
placeholder!("/local-executor", "terminal:output", terminal_output);
placeholder!("/local-executor", "terminal:exit", terminal_exit);

/// The source admits Responses API names and task-addressed dynamic events.
/// This classification belongs here; the framework only provides fallback.
#[brz_socket_io::event(fallback, namespace = "/local-executor")]
async fn responses(
    #[event_name] name: &str,
    #[payload] input: Value,
    #[auth] _user: &AuthenticatedUser,
) -> Result<Value, ClientError> {
    if is_responses_event(name, &input) {
        super::not_implemented()
    } else {
        Err(ClientError::new(
            "UNSUPPORTED_EVENT",
            "Unsupported executor event",
        ))
    }
}

fn is_responses_event(name: &str, input: &Value) -> bool {
    ["response.", "error", "image_generation."]
        .into_iter()
        .any(|prefix| name.starts_with(prefix))
        || (input.get("data").is_some_and(Value::is_object)
            && ["task_id", "subtask_id", "local_task_id"]
                .into_iter()
                .any(|key| input.get(key).is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dynamic_responses_keep_open_event_names() {
        for event in ["response.new_event", "error", "image_generation.progress"] {
            assert!(is_responses_event(event, &Value::Null));
        }
        assert!(is_responses_event(
            "future.runtime.event",
            &json!({"data": {}, "task_id": 7})
        ));
        assert!(!is_responses_event("unrelated", &json!({"task_id": 7})));
        assert!(!is_responses_event("unrelated", &json!({"data": {}})));
    }
}
