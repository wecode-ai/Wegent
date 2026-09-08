// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl<T, R> LocalBackendRunner<T, R>
where
    T: LocalBackendTransport,
    R: TaskRunner,
{
    pub(super) fn task_handler(&self) -> EventHandler {
        let runner = self.runner.clone();
        let config = Arc::clone(&self.client.config);
        let cancellations = self.cancellations.clone();
        Arc::new(move |payload| {
            let runner = runner.clone();
            let config = Arc::clone(&config);
            let cancellations = cancellations.clone();
            Box::pin(async move {
                write_executor_log_line(&format_executor_log(
                    "task:execute received",
                    &[(
                        "payload_keys",
                        payload
                            .as_object()
                            .map(|object| object.len().to_string())
                            .unwrap_or_else(|| "non-object".to_owned()),
                    )],
                ));
                let Ok(mut request) = serde_json::from_value::<ExecutionRequest>(payload) else {
                    write_executor_log_line(
                        "task:execute parse failed (unsupported execution request shape)",
                    );
                    return None;
                };
                write_executor_log_line(&format_executor_log(
                    "task:execute parsed",
                    &[
                        ("task_id", request.task_id.clone()),
                        (
                            "shell",
                            request
                                .resolved_shell_type()
                                .unwrap_or_else(|| "none".to_owned()),
                        ),
                        ("cwd", request.cwd().unwrap_or("<missing>").to_owned()),
                    ],
                ));
                normalize_local_task_request(&mut request, &config);
                cancellations.register_task(&request);
                let result = runner.submit(request).await;
                write_executor_log_line(&format_executor_log(
                    "task:execute submit result",
                    &[
                        ("status", format!("{:?}", result.status)),
                        ("message", result.message.unwrap_or_default()),
                    ],
                ));
                None
            })
        })
    }

    pub(super) fn cancel_handler(&self) -> EventHandler {
        let cancellations = self.cancellations.clone();
        let task_controller = self.task_controller.clone();
        Arc::new(move |payload| {
            let cancellations = cancellations.clone();
            let task_controller = task_controller.clone();
            Box::pin(async move {
                let task_id = id_field(&payload, "task_id")?;
                let subtask_id = payload.get("subtask_id").and_then(id_value_string);
                cancellations.cancel_task(task_id.clone(), subtask_id.clone());
                if let Some(controller) = task_controller {
                    let _ = controller.cancel_task(task_id, subtask_id).await;
                }
                None
            })
        })
    }

    pub(super) fn close_session_handler(&self) -> EventHandler {
        let task_controller = self.task_controller.clone();
        let client = self.client.clone();
        Arc::new(move |payload| {
            let task_controller = task_controller.clone();
            let client = client.clone();
            Box::pin(async move {
                let Some(task_id) = id_field(&payload, "task_id") else {
                    return Some(json!({"success": false, "error": "task_id is required"}));
                };
                if let Some(controller) = task_controller {
                    let _ = controller.close_task_session(task_id).await;
                    client.set_running_task_ids(controller.running_task_ids());
                }
                let _ = client.send_heartbeat(client.config.heartbeat_timeout).await;
                Some(json!({"success": true}))
            })
        })
    }

    pub(super) fn device_command_handler(&self) -> EventHandler {
        let command_handler = Arc::clone(&self.command_handler);
        Arc::new(move |payload| {
            let command_handler = Arc::clone(&command_handler);
            Box::pin(async move {
                if let Some(command_key) = payload.get("command_key").and_then(Value::as_str) {
                    if is_workspace_file_command(command_key) {
                        let path = payload
                            .get("cwd")
                            .or_else(|| payload.get("path"))
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        let args = payload
                            .get("args")
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_default();
                        let env = payload
                            .get("env")
                            .and_then(Value::as_object)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(|(key, value)| {
                                        value.as_str().map(|value| (key.clone(), value.to_owned()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let result =
                            execute_workspace_file_command(command_key, path, args, env).await;
                        return Some(serde_json::to_value(result).unwrap_or_else(
                            |error| json!({"success": false, "error": error.to_string()}),
                        ));
                    }
                }
                let result = command_handler
                    .handle_execute_command(CommandRequest::from_value(payload))
                    .await;
                Some(serde_json::to_value(result).unwrap_or_else(|error| {
                    json!({
                        "success": false,
                        "exit_code": null,
                        "stdout": "",
                        "stderr": "",
                        "duration": 0.0,
                        "timed_out": false,
                        "error": error.to_string(),
                    })
                }))
            })
        })
    }

    pub(super) fn runtime_rpc_handler(&self) -> EventHandler {
        let runtime_work_handler = self.runtime_work_handler.clone();
        Arc::new(move |payload| {
            let runtime_work_handler = runtime_work_handler.clone();
            Box::pin(async move {
                let method = payload
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>")
                    .to_owned();
                let request_id = payload
                    .get("request_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("-")
                    .to_owned();
                write_executor_log_line(&format_executor_log(
                    "runtime:rpc received",
                    &[
                        ("request_id", request_id.clone()),
                        ("method", method.clone()),
                    ],
                ));
                let response = if let Some(handler) = runtime_work_handler {
                    match handler.handle_runtime_rpc(payload).await {
                        Ok(result) => result,
                        Err(error) => runtime_error_response(error),
                    }
                } else {
                    runtime_error_response(AppIpcError::new(
                        "runtime_unavailable",
                        "Runtime work handler is not available",
                    ))
                };
                write_executor_log_line(&format_executor_log(
                    "runtime:rpc responded",
                    &[
                        ("request_id", request_id),
                        ("method", method.clone()),
                        (
                            "ok",
                            response
                                .get("success")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                .to_string(),
                        ),
                        (
                            "error",
                            response
                                .get("error")
                                .map(|v| v.to_string())
                                .unwrap_or_default(),
                        ),
                    ],
                ));
                Some(encode_runtime_rpc_response(&method, response))
            })
        })
    }

    pub(super) fn runtime_tasks_available_handler(&self) -> EventHandler {
        let client = self.client.clone();
        let runtime_work_handler = self.runtime_work_handler.clone();
        let runtime_pull_lock = Arc::clone(&self.runtime_pull_lock);
        Arc::new(move |_| {
            let client = client.clone();
            let runtime_work_handler = runtime_work_handler.clone();
            let runtime_pull_lock = Arc::clone(&runtime_pull_lock);
            Box::pin(async move {
                if let Some(handler) = runtime_work_handler {
                    tokio::spawn(poll_available_runtime_work(
                        client,
                        handler,
                        runtime_pull_lock,
                    ));
                }
                Some(json!({"success": true}))
            })
        })
    }

    pub(super) fn capability_sync_handler(&self) -> EventHandler {
        let capability_sync_handler = self.capability_sync_handler.clone();
        Arc::new(move |payload| {
            let capability_sync_handler = capability_sync_handler.clone();
            Box::pin(async move {
                let started_at = Instant::now();
                write_executor_log_line(&format_executor_log(
                    "device capability sync started",
                    &[(
                        "mode",
                        payload
                            .get("mode")
                            .and_then(Value::as_str)
                            .unwrap_or("merge")
                            .to_owned(),
                    )],
                ));
                let response = match capability_sync_handler {
                    Some(handler) => handler.handle_sync_capabilities(payload).await,
                    None => json!({
                        "success": false,
                        "error": "Capability sync handler is not available",
                    }),
                };
                write_executor_log_line(&format_executor_log(
                    "device capability sync finished",
                    &[
                        ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                        (
                            "ok",
                            response
                                .get("success")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                .to_string(),
                        ),
                        (
                            "error",
                            response
                                .get("error")
                                .map(Value::to_string)
                                .unwrap_or_default(),
                        ),
                    ],
                ));
                Some(response)
            })
        })
    }

    pub(super) fn session_start_handler(&self, session_type: SessionType) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(json!({
                        "success": false,
                        "error": "Session handler is not available",
                    }));
                };
                let request = match session_start_request(payload, session_type) {
                    Ok(request) => request,
                    Err(error) => return Some(json!({"success": false, "error": error})),
                };
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_start_session(request);
                Some(session_result_payload(result))
            })
        })
    }

    pub(super) fn terminal_input_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let consumer_id = value_string(payload.get("consumer_id"));
                let Some(data) = payload
                    .get("data")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    return Some(json!({"success": false, "error": "data is required"}));
                };
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_input(&session_id, consumer_id.as_deref(), &data);
                Some(session_result_payload(result))
            })
        })
    }

    pub(super) fn terminal_attach_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let protocol_version = match payload.get("protocol_version") {
                    None => 1,
                    Some(version) => match version.as_u64() {
                        Some(version @ (1 | 2)) => version,
                        _ => {
                            return Some(
                                json!({"success": false, "error": "protocol_version must be 1 or 2"}),
                            )
                        }
                    },
                };
                if protocol_version == 1 {
                    let result = handler
                        .lock()
                        .expect("session handler lock")
                        .handle_legacy_terminal_attach(&session_id);
                    return Some(terminal_attach_result_payload(result, 1));
                }
                let Some(consumer_id) = value_string(payload.get("consumer_id")) else {
                    return Some(json!({"success": false, "error": "consumer_id is required"}));
                };
                let last_acked_sequence = match non_negative_u64(payload.get("last_acked_sequence"))
                {
                    Ok(sequence) => sequence,
                    Err(error) => return Some(json!({"success": false, "error": error})),
                };
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_attach(&session_id, &consumer_id, last_acked_sequence);
                Some(terminal_attach_result_payload(result, 2))
            })
        })
    }

    pub(super) fn terminal_ack_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let Some(consumer_id) = value_string(payload.get("consumer_id")) else {
                    return Some(json!({"success": false, "error": "consumer_id is required"}));
                };
                let sequence = match positive_u64(payload.get("sequence")) {
                    Ok(sequence) => sequence,
                    Err(error) => return Some(json!({"success": false, "error": error})),
                };
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_ack(&session_id, &consumer_id, sequence);
                Some(session_result_payload(result))
            })
        })
    }

    pub(super) fn terminal_resize_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let consumer_id = value_string(payload.get("consumer_id"));
                let rows = value_u16(payload.get("rows")).unwrap_or(24);
                let cols = value_u16(payload.get("cols")).unwrap_or(80);
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_resize(&session_id, consumer_id.as_deref(), rows, cols);
                Some(session_result_payload(result))
            })
        })
    }

    pub(super) fn terminal_close_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let consumer_id = value_string(payload.get("consumer_id"));
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_close(&session_id, consumer_id.as_deref());
                Some(session_result_payload(result))
            })
        })
    }

    pub(super) fn upgrade_handler(&self) -> EventHandler {
        let upgrade_handler = self.upgrade_handler.clone().or_else(|| {
            self.upgrade_service.as_ref().map(|service| {
                Arc::new(LocalDeviceUpgradeHandler::with_service_arc(
                    self.client.clone(),
                    self.task_controller.clone(),
                    self.client.config.update.clone(),
                    Arc::clone(service),
                )) as Arc<dyn DeviceUpgradeHandler>
            })
        });
        Arc::new(move |payload| {
            let upgrade_handler = upgrade_handler.clone();
            Box::pin(async move {
                let Some(handler) = upgrade_handler else {
                    return Some(json!({
                        "success": false,
                        "error": "Upgrade handler is not available",
                    }));
                };
                Some(handler.handle_upgrade(payload).await)
            })
        })
    }

    pub(super) fn extension_handler(&self) -> EventHandler {
        let extension_handler = self.extension_handler.clone();
        Arc::new(move |payload| {
            let extension_handler = extension_handler.clone();
            Box::pin(async move {
                let Some(handler) = extension_handler else {
                    return Some(json!({
                        "success": false,
                        "message": "Extension handler is not available",
                    }));
                };
                Some(handler.handle_run_extension(payload).await)
            })
        })
    }
}

fn terminal_attach_result_payload(
    result: crate::local::session::SessionResult,
    version: u64,
) -> Value {
    let success = result.success;
    let mut payload = session_result_payload(result);
    if success {
        payload["protocol_version"] = json!(version);
    }
    payload
}

fn non_negative_u64(value: Option<&Value>) -> Result<u64, &'static str> {
    value
        .and_then(Value::as_u64)
        .ok_or("last_acked_sequence must be a non-negative JSON integer")
}

fn positive_u64(value: Option<&Value>) -> Result<u64, &'static str> {
    value
        .and_then(Value::as_u64)
        .filter(|sequence| *sequence > 0)
        .ok_or("sequence must be a positive JSON integer")
}
