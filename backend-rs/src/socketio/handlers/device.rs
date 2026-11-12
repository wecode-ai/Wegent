// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/device_namespace.py::DeviceNamespace` inbound event exports.

use std::sync::Arc;

use brz_socket_io::__private::AckContext;
use brz_socket_io::adapter::LocalAdapter;
use brz_socket_io::extract::{Event, SocketRef, TryData};
use brz_socket_io::{ClientError, ConnectionContext, Reply};
use serde_json::Value;

use super::AuthenticatedUser;
use crate::socketio::device_heartbeat;
use crate::socketio::device_lifecycle;
use crate::socketio::device_responses;
use crate::socketio::device_runtime_event;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::runtime_event_order::Turn;
use crate::socketio::session::{DeviceSession, SessionSnapshot};
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

/// `on_device_status`.
#[brz_socket_io::event("device:status", namespace = "/local-executor")]
async fn status(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::device_status::status(
            app,
            runtime,
            &session.snapshot(),
            context.id(),
            &data,
        )
        .await,
    ))
}

/// `on_device_upgrade_status`.
#[brz_socket_io::event("device:upgrade_status", namespace = "/local-executor")]
async fn upgrade_status(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::device_status::upgrade_status(
            app,
            runtime,
            &session.snapshot(),
            context.id(),
            &data,
        )
        .await,
    ))
}
/// `on_runtime_event`: the relay has no callback, so the reply only carries the
/// source's error shapes when the session is incomplete.
///
/// Registered by hand (see the registration below) because the frame's
/// per-session order must be taken in the handler closure's synchronous
/// section, before the transport spawns the frame's future. The generated
/// `#[brz_socket_io::event]` wrapper takes it inside the spawned future, where
/// arrival order is already lost.
async fn runtime_event(
    data: Value,
    session: &DeviceSession,
    app: &AppState,
    runtime: &Arc<SocketRuntime>,
    turn: Turn,
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
    turn.wait().await;
    let forwarded = device_runtime_event::forward(
        app,
        runtime,
        snapshot.user_id,
        &device_id,
        &logical_device_id,
        &data,
    )
    .await;
    // Release the session's next frame as soon as this frame's whole forward
    // settled; the framework ACK stays outside the serialised region, exactly
    // as it was outside the source lock.
    drop(turn);
    match forwarded {
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

/// The `runtime:event` export, written by hand to use the synchronous part of
/// the handler closure.
///
/// `brz-socketioxide` 0.18.7-brz.1 (`handler/message.rs::call`) runs
/// `let fut = (self.clone())(extractors...); tokio::spawn(fut);`, and the
/// generated `#[brz_socket_io::event]` closure only clones state before
/// returning its `async move` future. Taking the arrival position in that
/// synchronous section is the only way to order a session's frames, so this
/// export keeps the generated wrapper's contract by hand: typed session
/// extraction at the synchronous receive point, handler metrics, and the
/// framework ACK/reply guards. The session is captured before the spawned
/// future can lose a following namespace DISCONNECT, so an event accepted
/// before the close still performs its business side effects while ACK and
/// room mutations remain guarded by `complete_event`.
const _: () = {
    brz_socket_io::__private::inventory::submit! {
        crate::__socket_registry_socket_apis::Event(
            brz_socket_io::__private::EventRegistration {
                namespace: "/local-executor",
                event: Some(device_runtime_event::RUNTIME_EVENT),
                requires: || brz_socket_io::__private::StateTypes {
                    auth: None,
                    session: Some(brz_socket_io::__private::state_type::<DeviceSession>()),
                },
                register: |socket, dependencies, metrics| {
                    // One session identity per connection, so the FIFO key does
                    // not allocate per frame.
                    let session: Arc<str> = socket.id.to_string().into();
                    socket.on(
                        device_runtime_event::RUNTIME_EVENT,
                        move |socket: SocketRef<LocalAdapter>,
                              ack: AckContext<LocalAdapter>,
                              raw: TryData<Value>| {
                            // Synchronous receive point: the FIFO position and
                            // the accepted session context are fixed here, before
                            // the socketioxide dispatcher can process a following
                            // namespace DISCONNECT packet. The spawned handler must
                            // still run its business effects after that disconnect;
                            // framework ACK/room mutations stay guarded by
                            // `complete_event`/`apply_reply`.
                            let turn = dependencies
                                .runtime
                                .runtime_event_order()
                                .enter(&session);
                            let accepted_session = brz_socket_io::__private::session::<
                                DeviceSession,
                                _,
                            >(&socket);
                            let dependencies = dependencies.clone();
                            async move {
                                let observation = metrics.handler.start();
                                let result: Result<Reply<Value>, ClientError> = async {
                                    let session = accepted_session?;
                                    let data = brz_socket_io::__private::payload(raw.0)?;
                                    runtime_event(
                                        data,
                                        &session,
                                        &dependencies.app,
                                        &dependencies.runtime,
                                        turn,
                                    )
                                    .await
                                }
                                .await;
                                observation.finish(result.is_ok());
                                brz_socket_io::__private::complete_event(
                                    &socket, ack, result, metrics,
                                );
                            }
                        },
                    );
                },
            },
        )
    }
};
/// A `plugin.auth.*` export whose body is `plugin_auth_broker.exchange`.
macro_rules! plugin_auth {
    ($event:literal, $name:ident, $operation:expr) => {
        #[brz_socket_io::event($event, namespace = "/local-executor")]
        async fn $name(
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
                    $operation,
                    &data,
                )
                .await?,
            ))
        }
    };
}

plugin_auth!(
    "plugin.auth.local_lifecycle",
    local_lifecycle,
    crate::plugin_account_auth::LOCAL_LIFECYCLE
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
        .await?,
    ))
}
plugin_auth!(
    "plugin.auth.prepare",
    prepare,
    crate::plugin_account_auth::PREPARE
);
plugin_auth!(
    "plugin.auth.transfer.stage",
    transfer_stage,
    crate::plugin_account_auth::TRANSFER_STAGE
);
plugin_auth!(
    "plugin.auth.transfer.prepare",
    transfer_prepare,
    crate::plugin_account_auth::TRANSFER_PREPARE
);
plugin_auth!(
    "plugin.auth.transfer.finish",
    transfer_finish,
    crate::plugin_account_auth::TRANSFER_FINISH
);
plugin_auth!(
    "plugin.auth.transfer.abort",
    transfer_abort,
    crate::plugin_account_auth::TRANSFER_ABORT
);
plugin_auth!(
    "plugin.auth.execute",
    execute,
    crate::plugin_account_auth::EXECUTE
);
plugin_auth!(
    "plugin.auth.oauth.begin",
    oauth_begin,
    crate::plugin_account_auth::OAUTH_BEGIN
);
plugin_auth!(
    "plugin.auth.oauth.finish",
    oauth_finish,
    crate::plugin_account_auth::OAUTH_FINISH
);
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
        .await?,
    ))
}
plugin_auth!(
    "plugin.auth.oauth.revoke_begin",
    oauth_revoke_begin,
    crate::plugin_account_auth::OAUTH_REVOKE_BEGIN
);
plugin_auth!(
    "plugin.auth.oauth.revoke_finish",
    oauth_revoke_finish,
    crate::plugin_account_auth::OAUTH_REVOKE_FINISH
);
plugin_auth!(
    "plugin.auth.enroll",
    enroll,
    crate::plugin_account_auth::ENROLL
);
plugin_auth!("plugin.auth.read", read, crate::plugin_account_auth::READ);
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
/// `on_runtime_tasks_accept`: record the Executor's response to a pulled run.
#[brz_socket_io::event("runtime.tasks.accept", namespace = "/local-executor")]
async fn accept_tasks(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::device_runtime_tasks::accept(app, runtime, &session.snapshot(), &data)
            .await?,
    ))
}
/// `on_runtime_workspace_cleanup_claim`: claim one cleanup desired-state
/// version before the executor mutates local state.
#[brz_socket_io::event("runtime.workspace_cleanup.claim", namespace = "/local-executor")]
async fn claim_cleanup(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::workspace_cleanup_intents::claim(app, &session.snapshot(), &data).await?,
    ))
}
/// `on_runtime_workspace_cleanup_accept`: acknowledge one applied cleanup
/// version.
#[brz_socket_io::event("runtime.workspace_cleanup.accept", namespace = "/local-executor")]
async fn accept_cleanup(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::workspace_cleanup_intents::accept(app, &session.snapshot(), &data).await?,
    ))
}
/// `on_runtime_task_updated`: project a terminal watcher update into the
/// project chat.
#[brz_socket_io::event("runtime.tasks.updated", namespace = "/local-executor")]
async fn tasks_updated(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<crate::socketio::runtime::SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::device_runtime_tasks::updated(app, runtime, &session.snapshot(), &data)
            .await?,
    ))
}
/// `on_terminal_output`: forward executor PTY output to the browser terminal
/// namespace.
#[brz_socket_io::event("terminal:output", namespace = "/local-executor")]
async fn terminal_output(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<crate::socketio::runtime::SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::terminal_device::relay_device_event(
            app,
            runtime,
            &session.snapshot(),
            context.id(),
            &data,
            true,
        )
        .await?,
    ))
}
/// `on_terminal_exit`: forward executor PTY exit and remove the terminal
/// session record.
#[brz_socket_io::event("terminal:exit", namespace = "/local-executor")]
async fn terminal_exit(
    #[payload] data: Value,
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<crate::socketio::runtime::SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    Ok(Reply::payload(
        crate::socketio::terminal_device::relay_device_event(
            app,
            runtime,
            &session.snapshot(),
            context.id(),
            &data,
            false,
        )
        .await?,
    ))
}

/// Reserve the subtask's position in the synchronous receive closure, before
/// Socket.IO spawns the event future and the scheduler can reorder frames.
const _: () = {
    brz_socket_io::__private::inventory::submit! {
        crate::__socket_registry_socket_apis::Event(
            brz_socket_io::__private::EventRegistration {
                namespace: "/local-executor",
                event: None,
                requires: || brz_socket_io::__private::StateTypes {
                    auth: Some(brz_socket_io::__private::state_type::<AuthenticatedUser>()),
                    session: Some(brz_socket_io::__private::state_type::<DeviceSession>()),
                },
                register: |socket, dependencies, metrics| {
                    socket.on_fallback(
                        move |socket: SocketRef<LocalAdapter>,
                              ack: AckContext<LocalAdapter>,
                              Event(name): Event,
                              raw: TryData<Value>| {
                            let accepted = (|| {
                                brz_socket_io::__private::ensure_active(&socket)?;
                                let input = brz_socket_io::__private::payload(raw.0)?;
                                let session = brz_socket_io::__private::session::<DeviceSession, _>(
                                    &socket,
                                )?.snapshot();
                                brz_socket_io::__private::auth::<AuthenticatedUser, _>(&socket)?;
                                let turn = reserve_response_turn(
                                    &dependencies.runtime, &session, &name, &input,
                                )?;
                                Ok::<_, ClientError>((session, input, turn))
                            })();
                            let dependencies = dependencies.clone();
                            async move {
                                let observation = metrics.handler.start();
                                let result = match accepted {
                                    Ok((session, input, turn)) => {
                                        if let Some(turn) = &turn {
                                            turn.wait().await;
                                        }
                                        let reply = device_responses::handle(
                                            &dependencies.app, &dependencies.runtime,
                                            &session, &name, input,
                                        ).await;
                                        drop(turn);
                                        Ok(Reply::payload(reply))
                                    }
                                    Err(error) => Err(error),
                                };
                                observation.finish(result.is_ok());
                                brz_socket_io::__private::complete_event(
                                    &socket, ack, result, metrics,
                                );
                            }
                        },
                    );
                },
            },
        )
    }
};

fn reserve_response_turn(
    runtime: &SocketRuntime,
    session: &SessionSnapshot,
    name: &str,
    input: &Value,
) -> Result<Option<Turn<i64>>, ClientError> {
    if !is_responses_event(name, input) {
        return Err(ClientError::new(
            "UNSUPPORTED_EVENT",
            "Unsupported executor event",
        ));
    }
    Ok(device_responses::response_subtask_id(input, session)
        .map(|subtask_id| runtime.response_event_order().enter(&subtask_id)))
}

fn is_responses_event(name: &str, input: &Value) -> bool {
    if ["response.", "error", "image_generation."]
        .into_iter()
        .any(|prefix| name.starts_with(prefix))
    {
        return true;
    }
    // `_is_responses_api_event` also requires a dict payload whose `data`
    // member is a dict, then accepts any task-addressed envelope.
    let Some(object) = input.as_object() else {
        return false;
    };
    if !object.get("data").is_some_and(Value::is_object) {
        return false;
    }
    ["task_id", "subtask_id", "local_task_id"]
        .into_iter()
        .any(|key| object.contains_key(key))
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
        // The Source's payload branch needs a dict `data` member.
        assert!(!is_responses_event(
            "unrelated",
            &json!({"data": null, "task_id": 7})
        ));
        assert!(!is_responses_event(
            "unrelated",
            &json!({"data": "text", "subtask_id": 7})
        ));
        assert!(is_responses_event(
            "unrelated",
            &json!({"data": {}, "local_task_id": "local"})
        ));
    }

    #[test]
    fn the_dynamic_fallback_keeps_the_device_session_binding() {
        let entry = brz_socket_io::__private::inventory::iter::<
            crate::__socket_registry_socket_apis::Event,
        >
            .into_iter()
            .find(|entry| entry.0.namespace == "/local-executor" && entry.0.event.is_none())
            .expect("the dynamic fallback is registered");
        let requires = (entry.0.requires)();
        assert_eq!(
            requires.session.map(|state| state.id),
            Some(std::any::TypeId::of::<DeviceSession>())
        );
        assert!(requires.auth.is_some());
    }

    #[tokio::test]
    async fn responses_follow_receive_order_when_completion_is_polled_first() {
        use std::task::Poll;

        let (runtime, _workers) = SocketRuntime::new();
        let session = SessionSnapshot {
            user_id: 7,
            user_name: "test-user".into(),
            auth_type: "jwt",
            client_ip: None,
            device: crate::socketio::session::DeviceSessionState {
                device_id: Some("test-device".into()),
                ..Default::default()
            },
        };
        let receive = |event, payload: Value| {
            reserve_response_turn(&runtime, &session, event, &payload)
                .expect("supported Responses event")
                .expect("subtask receive-order position")
        };
        let first = receive(
            "response.output_text.delta",
            json!({"task_id": 1, "subtask_id": 2, "data": {"delta": "first", "offset": 0}}),
        );
        let second = receive(
            "response.output_text.delta",
            json!({"task_id": 1, "subtask_id": "2", "data": {"delta": "second", "offset": 5}}),
        );
        let completed = receive(
            "response.completed",
            json!({"task_id": 1, "subtask_id": 2, "data": {"response": {"output": []}}}),
        );
        let independent = receive(
            "response.output_text.delta",
            json!({"task_id": 1, "subtask_id": 3, "data": {"delta": "independent"}}),
        );

        // Poll the futures in reverse order to reproduce the scheduler race
        // without depending on timing or a particular worker assignment.
        {
            let mut completion = std::pin::pin!(completed.wait());
            let mut next_delta = std::pin::pin!(second.wait());
            assert_eq!(futures_util::poll!(&mut completion), Poll::Pending);
            assert_eq!(futures_util::poll!(&mut next_delta), Poll::Pending);
            assert_eq!(
                futures_util::poll!(std::pin::pin!(independent.wait())),
                Poll::Ready(())
            );
            assert_eq!(
                futures_util::poll!(std::pin::pin!(first.wait())),
                Poll::Ready(())
            );
            drop(first);
            assert_eq!(futures_util::poll!(&mut next_delta), Poll::Ready(()));
            assert_eq!(futures_util::poll!(&mut completion), Poll::Pending);
        }
        drop(second);
        assert_eq!(
            futures_util::poll!(std::pin::pin!(completed.wait())),
            Poll::Ready(())
        );
    }

    #[test]
    fn runtime_event_keeps_its_typed_session_binding() {
        let entry = brz_socket_io::__private::inventory::iter::<
            crate::__socket_registry_socket_apis::Event,
        >
            .into_iter()
            .find(|entry| {
                entry.0.namespace == "/local-executor"
                    && entry.0.event == Some(device_runtime_event::RUNTIME_EVENT)
            })
            .expect("runtime:event is registered");
        let requires = (entry.0.requires)();
        assert_eq!(
            requires.session.map(|state| state.id),
            Some(std::any::TypeId::of::<DeviceSession>())
        );
        assert!(requires.auth.is_none());
    }
}
