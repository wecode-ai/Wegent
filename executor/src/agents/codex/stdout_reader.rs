// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) async fn read_persistent_codex_app_server_stdout(
    mut stdout: CodexStdout,
    transport: CodexAppServerHandle,
) {
    let pending = Arc::clone(&transport.pending);
    let notifications = transport.notifications.clone();
    loop {
        let mut line = String::new();
        let message = match stdout.read_line(&mut line).await {
            Ok(0) => {
                notify_shared_process_closed(
                    &notifications,
                    "codex app-server exited while shared process was running",
                )
                .await;
                fail_all_pending(
                    &pending,
                    "codex app-server exited while shared process was running".to_owned(),
                )
                .await;
                break;
            }
            Ok(_) => match serde_json::from_str::<Value>(&line) {
                Ok(message) => message,
                Err(error) => {
                    notify_shared_process_closed(
                        &notifications,
                        &format!("failed to parse codex JSON-RPC message: {error}"),
                    )
                    .await;
                    fail_all_pending(
                        &pending,
                        format!("failed to parse codex JSON-RPC message: {error}"),
                    )
                    .await;
                    break;
                }
            },
            Err(error) => {
                notify_shared_process_closed(
                    &notifications,
                    &format!("failed to read codex JSON-RPC message: {error}"),
                )
                .await;
                fail_all_pending(
                    &pending,
                    format!("failed to read codex JSON-RPC message: {error}"),
                )
                .await;
                break;
            }
        };

        if is_json_rpc_response(&message) {
            if let Some(request_id) = response_id(&message) {
                if let Some(request) = pending.lock().await.remove(&request_id) {
                    let result = response_result(
                        message,
                        &request.method,
                        CodexRpcOrigin::Shared(Some(notifications.process_generation)),
                    );
                    if let (Some(context), Ok(response)) = (&request.native_request, &result) {
                        notifications.update_native_activity(|activity| {
                            activity.observe_response(context, response)
                        });
                    }
                    let _ = request.sender.send(result);
                    notifications.thread_activity_changed.notify_waiters();
                    continue;
                }
            }
        }

        let timing = if env::var("VITE_WEWORK_E2E").as_deref() == Ok("true") {
            command_lifecycle_fields(&message, notifications.process_generation)
        } else {
            None
        };
        let dispatch_started = Instant::now();
        if let Some(fields) = &timing {
            log_executor_event(
                "codex command lifecycle received",
                &[("details", fields.to_string())],
            );
        }
        log_codex_mcp_startup_status(&message, notifications.process_generation);

        let message = external_work::project_review_notification(message);
        transport.track_mcp_elicitation(&message);
        notifications.send(message).await;
        if let Some(mut fields) = timing {
            fields["dispatch_elapsed_ms"] = json!(dispatch_started.elapsed().as_millis());
            fields["dispatched_at_ms"] = json!(now_ms());
            log_executor_event(
                "codex command lifecycle dispatched",
                &[("details", fields.to_string())],
            );
        }
    }
    notifications.thread_activity_changed.notify_waiters();
}

fn log_codex_mcp_startup_status(message: &Value, process_generation: u64) {
    if message.get("method").and_then(Value::as_str) != Some("mcpServer/startupStatus/updated") {
        return;
    }
    let params = message.get("params").unwrap_or(message);
    log_executor_event(
        "codex MCP startup status",
        &[
            ("process_generation", process_generation.to_string()),
            (
                "thread_id",
                params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
            (
                "server_name",
                params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
            (
                "status",
                params
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
            (
                "error_present",
                params
                    .get("error")
                    .is_some_and(|value| !value.is_null())
                    .to_string(),
            ),
            (
                "failure_reason_present",
                params
                    .get("failureReason")
                    .is_some_and(|value| !value.is_null())
                    .to_string(),
            ),
            (
                "failure_reason",
                params["failureReason"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            ),
            (
                "error",
                diagnostics::redact_diagnostic_text(params["error"].as_str().unwrap_or_default()),
            ),
        ],
    );
}

fn now_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn diagnostic_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_ .".contains(&byte))
    })
}

fn command_lifecycle_fields(message: &Value, process_generation: u64) -> Option<Value> {
    let method = message["method"].as_str()?;
    if !matches!(method, "item/started" | "item/completed") {
        return None;
    }
    let params = &message["params"];
    let item = &params["item"];
    if item["type"].as_str() != Some("commandExecution") {
        return None;
    }
    Some(json!({
        "method": method,
        "thread_id": diagnostic_id(&params["threadId"]),
        "turn_id": diagnostic_id(&params["turnId"]),
        "item_id": diagnostic_id(&item["id"]),
        "native_started_at_ms": params["startedAtMs"].as_u64(),
        "native_completed_at_ms": params["completedAtMs"].as_u64(),
        "native_duration_ms": item["durationMs"].as_u64(),
        "observed_at_ms": now_ms(),
        "process_scope": "shared",
        "process_generation": process_generation,
        "executor_pid": std::process::id(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_timing_preserves_missing_clocks_without_logging_command_content() {
        let message = json!({"method":"item/completed", "params":{
            "threadId":"thread-1", "turnId":"unsafe/token", "item":{
                "type":"commandExecution", "id":"item-1", "durationMs":8001,
                "command":"secret-command", "aggregatedOutput":"secret-output",
                "cwd":"/private/path"
            }
        }});
        let fields = command_lifecycle_fields(&message, 7).unwrap();
        assert_eq!(fields["native_duration_ms"], 8001);
        assert_eq!(fields["process_generation"], 7);
        assert_eq!(fields["thread_id"], "thread-1");
        assert!(fields["turn_id"].is_null());
        assert!(fields["native_started_at_ms"].is_null());
        assert!(fields["native_completed_at_ms"].is_null());
        assert!(!fields.to_string().contains("secret"));
        assert!(!fields.to_string().contains("private"));
        let mut timestamped = message.clone();
        timestamped["params"]["completedAtMs"] = json!(123456);
        assert_eq!(
            command_lifecycle_fields(&timestamped, 7).unwrap()["native_completed_at_ms"],
            123456
        );
        assert!(
            command_lifecycle_fields(&json!({"method":"item/agentMessage/delta"}), 7).is_none()
        );
    }
}
