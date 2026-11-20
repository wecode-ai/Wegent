use serde_json::{json, Value};

use super::{
    emit_response_event, now_ms, stream_thread_id, string_field, CodexNotificationEventMapper,
    EventEmitContext,
};

pub(super) fn codex_error_will_retry(params: &Value) -> bool {
    params
        .get("willRetry")
        .or_else(|| params.get("will_retry"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(super) fn codex_notification_resumes_turn(method: &str) -> bool {
    method.starts_with("item/") || method.starts_with("turn/")
}

fn retry_reason(params: &Value) -> &'static str {
    match params
        .get("error")
        .and_then(crate::agents::codex_error_type)
    {
        Some("rate_limit") => "rate_limit",
        Some("server_overloaded") => "overload",
        Some("network_error") => "connection",
        _ => "unknown",
    }
}

impl CodexNotificationEventMapper {
    pub(super) fn clear_resumed_native_retry(
        &mut self,
        context: &EventEmitContext<'_>,
        params: &Value,
    ) {
        let thread_id = stream_thread_id(params).unwrap_or_default();
        let scoped_resumed = self.native_retry_waits.remove(&thread_id).is_some();
        let unscoped_resumed =
            !self.is_subagent_delta(params) && self.native_retry_waits.remove("").is_some();
        if scoped_resumed || unscoped_resumed {
            self.refresh_reconnecting(context);
        }
    }

    /// Finish the retry status when the root turn completes.
    ///
    /// A proxy retry wait normally clears itself when the request stops
    /// waiting, but that notification is lost when the request is cancelled
    /// with the turn. A completed root turn cannot still be waiting for a model
    /// retry, so finish the block instead of leaving it streaming forever.
    pub(super) fn clear_completed_turn_retry_waits(
        &mut self,
        context: &EventEmitContext<'_>,
        params: &Value,
    ) {
        if let (Some(root_thread_id), Some(thread_id)) =
            (self.root_thread_id.as_deref(), stream_thread_id(params))
        {
            if root_thread_id != thread_id {
                return;
            }
        }
        if self.proxy_retry_wait_ids.is_empty() {
            return;
        }
        self.proxy_retry_wait_ids.clear();
        self.refresh_reconnecting(context);
    }

    pub(super) fn refresh_reconnecting(&mut self, context: &EventEmitContext<'_>) {
        let params = if !self.proxy_retry_wait_ids.is_empty() {
            Some(json!({"error": {"codexErrorInfo": "rateLimitExceeded"}}))
        } else {
            self.native_retry_waits
                .values()
                .find(|params| retry_reason(params) == "rate_limit")
                .or_else(|| {
                    self.native_retry_waits
                        .values()
                        .find(|params| retry_reason(params) == "overload")
                })
                .or_else(|| self.native_retry_waits.values().next())
                .cloned()
        };
        if let Some(params) = params {
            self.emit_reconnecting(context, &params);
        } else {
            self.clear_reconnecting(context);
        }
    }

    pub(super) fn emit_reconnecting(&mut self, context: &EventEmitContext<'_>, params: &Value) {
        let tool_input = json!({
            "message": params.pointer("/error/message").or_else(|| params.get("message"))
                .and_then(Value::as_str).unwrap_or("Reconnecting"),
            "model_kind": string_field(&context.request.model_config, "wework_model_kind")
                .or_else(|| string_field(&context.request.model_config, "weworkModelKind")),
            "retry_reason": retry_reason(params),
            "retry_at": params.get("retryAt"),
            "retry_attempt": params.get("retryAttempt"),
            "retry_max_attempts": params.get("retryMaxAttempts"),
        });
        let (event, data) = if let Some(id) = self.reconnecting_block_id.as_ref() {
            (
                "response.block.updated",
                json!({
                    "block_id": id,
                    "updates": { "tool_input": tool_input },
                }),
            )
        } else {
            let id = format!(
                "reconnecting-{}-{}",
                context.local_task_id, context.request.subtask_id
            );
            self.reconnecting_block_id = Some(id.clone());
            (
                "response.block.created",
                json!({
                    "block": {
                        "id": id,
                        "type": "tool",
                        "tool_name": "runtime_reconnecting",
                        "tool_input": tool_input,
                        "status": "streaming",
                        "timestamp": now_ms(),
                    }
                }),
            )
        };
        crate::logging::log_executor_event(
            "runtime retry status published",
            &[
                ("local_task_id", context.local_task_id.to_owned()),
                ("subtask_id", context.request.subtask_id.clone()),
                ("event", event.to_owned()),
                (
                    "block_id",
                    self.reconnecting_block_id.clone().unwrap_or_default(),
                ),
                (
                    "proxy_wait_count",
                    self.proxy_retry_wait_ids.len().to_string(),
                ),
                (
                    "native_wait_count",
                    self.native_retry_waits.len().to_string(),
                ),
            ],
        );
        emit_response_event(
            context.event_tx,
            context.device_id,
            event,
            context.local_task_id,
            context.request,
            data,
        );
    }

    pub(super) fn clear_reconnecting(&mut self, context: &EventEmitContext<'_>) {
        let Some(id) = self.reconnecting_block_id.take() else {
            return;
        };
        crate::logging::log_executor_event(
            "runtime retry status cleared",
            &[
                ("local_task_id", context.local_task_id.to_owned()),
                ("subtask_id", context.request.subtask_id.clone()),
                ("block_id", id.clone()),
            ],
        );
        emit_response_event(
            context.event_tx,
            context.device_id,
            "response.block.updated",
            context.local_task_id,
            context.request,
            json!({ "block_id": id, "updates": { "status": "done" } }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ExecutionRequest;
    use tokio::sync::broadcast;

    #[test]
    fn classifies_rate_limits_from_structured_error_info_only() {
        for info in [
            json!("rateLimitExceeded"),
            json!({"httpConnectionFailed": {"httpStatusCode": 429}}),
            json!({"responseTooManyFailedAttempts": {"httpStatusCode": 429}}),
            json!({"responseStreamDisconnected": {"httpStatusCode": 429}}),
        ] {
            assert_eq!(
                retry_reason(&json!({"error": {"codexErrorInfo": info}})),
                "rate_limit"
            );
        }
        for (info, expected) in [
            (Value::Null, "unknown"),
            (json!("serverOverloaded"), "overload"),
            (
                json!({"httpConnectionFailed": {"httpStatusCode": 503}}),
                "connection",
            ),
        ] {
            assert_eq!(
                retry_reason(&json!({"error": {"codexErrorInfo": info, "message": "429"}})),
                expected
            );
        }
        assert_eq!(
            retry_reason(&json!({"error":{"codexErrorInfo":"serverOverloaded"}})),
            "overload"
        );
    }

    #[test]
    fn updates_one_retry_block_with_rate_limit_reason_and_clears_on_progress() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let request = ExecutionRequest::default();
        let mut mapper = CodexNotificationEventMapper::default();
        for info in [
            json!({"httpConnectionFailed": {"httpStatusCode": 503}}),
            json!({"responseTooManyFailedAttempts": {"httpStatusCode": 429}}),
        ] {
            mapper.map(
                &Some(event_tx.clone()),
                "device",
                "task",
                &request,
                json!({"method": "error", "params": {
                    "willRetry": true, "error": { "message": "Retrying", "codexErrorInfo": info }
                }}),
            );
        }
        let created = event_rx.try_recv().unwrap();
        let updated = event_rx.try_recv().unwrap();
        assert_eq!(
            created["payload"]["data"]["block"]["tool_input"]["retry_reason"],
            "connection"
        );
        assert_eq!(
            updated["payload"]["data"]["updates"]["tool_input"]["retry_reason"],
            "rate_limit"
        );
        assert_eq!(
            created["payload"]["data"]["block"]["id"],
            updated["payload"]["data"]["block_id"]
        );
        mapper.map(
            &Some(event_tx),
            "device",
            "task",
            &request,
            json!({"method": "turn/diff/updated", "params": {}}),
        );
        let cleared = event_rx.try_recv().unwrap();
        assert_eq!(cleared["payload"]["data"]["updates"]["status"], "done");
    }

    #[test]
    fn preserves_overload_reason_and_retry_progress() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let request = ExecutionRequest::default();
        let mut mapper = CodexNotificationEventMapper::default();
        mapper.map(&Some(event_tx), "device", "task", &request, json!({
            "method": "error", "params": {
                "willRetry": true, "retryAttempt": 2, "retryMaxAttempts": 5,
                "error": {"message": "connection interrupted", "codexErrorInfo": "serverOverloaded"}
            }
        }));
        let event = event_rx.try_recv().unwrap();
        let input = &event["payload"]["data"]["block"]["tool_input"];
        assert_eq!(input["retry_reason"], "overload");
        assert_eq!(input["retry_attempt"], 2);
        assert_eq!(input["retry_max_attempts"], 5);
    }

    #[test]
    fn terminal_rate_limit_errors_do_not_start_a_retry_wait() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        CodexNotificationEventMapper::default().map(
            &Some(event_tx),
            "device",
            "task",
            &ExecutionRequest::default(),
            json!({"method": "error", "params": {
                "willRetry": false, "error": { "codexErrorInfo": "rateLimitExceeded" }
            }}),
        );
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn proxy_retry_wait_uses_the_same_block_and_clears_on_recovery() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let mut mapper = CodexNotificationEventMapper::default();
        for waiting in [true, false] {
            mapper.map(
                &Some(event_tx.clone()),
                "device",
                "task",
                &ExecutionRequest::default(),
                json!({
                    "method": crate::server::local_model_proxy::retry_notifications::METHOD,
                    "params": {
                        "threadId": "thread",
                        "waitId": "request-1",
                        "waiting": waiting,
                        "error": { "codexErrorInfo": "rateLimitExceeded" },
                    },
                }),
            );
        }
        let created = event_rx.try_recv().unwrap();
        assert_eq!(
            created["payload"]["data"]["block"]["tool_input"]["retry_reason"],
            "rate_limit"
        );
        let cleared = event_rx.try_recv().unwrap();
        assert_eq!(cleared["payload"]["data"]["updates"]["status"], "done");
    }

    #[test]
    fn proxy_retry_wait_remains_until_every_subagent_has_resumed() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let mut mapper = CodexNotificationEventMapper::default();
        for (thread, waiting) in [("child-a", true), ("child-b", true), ("child-a", false)] {
            mapper.map(
                &Some(event_tx.clone()),
                "device",
                "task",
                &ExecutionRequest::default(),
                json!({
                    "method": crate::server::local_model_proxy::retry_notifications::METHOD,
                    "params": {
                        "threadId": thread,
                        "waitId": thread,
                        "waiting": waiting,
                        "error": { "codexErrorInfo": "rateLimitExceeded" },
                    },
                }),
            );
        }
        assert_eq!(
            event_rx.try_recv().unwrap()["event"],
            "response.block.created"
        );
        assert_eq!(
            event_rx.try_recv().unwrap()["event"],
            "response.block.updated"
        );
        let still_waiting = event_rx.try_recv().unwrap();
        assert_eq!(
            still_waiting["payload"]["data"]["updates"]["tool_input"]["retry_reason"],
            "rate_limit"
        );
        assert!(still_waiting["payload"]["data"]["updates"]["status"].is_null());
        mapper.map(
            &Some(event_tx.clone()),
            "device",
            "task",
            &ExecutionRequest::default(),
            json!({"method": "turn/diff/updated", "params": {"threadId": "parent"}}),
        );
        assert!(
            event_rx.try_recv().is_err(),
            "Parent progress cleared a child wait"
        );
        mapper.map(
            &Some(event_tx),
            "device",
            "task",
            &ExecutionRequest::default(),
            json!({
                "method": crate::server::local_model_proxy::retry_notifications::METHOD,
                "params": {"threadId": "child-b", "waitId": "child-b", "waiting": false},
            }),
        );
        assert_eq!(
            event_rx.try_recv().unwrap()["payload"]["data"]["updates"]["status"],
            "done"
        );
    }

    #[test]
    fn root_turn_completion_finishes_an_uncleared_proxy_retry_wait() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let mut mapper = CodexNotificationEventMapper::default();
        mapper.observe_root_thread_id("root");
        mapper.map(
            &Some(event_tx.clone()),
            "device",
            "task",
            &ExecutionRequest::default(),
            json!({
                "method": crate::server::local_model_proxy::retry_notifications::METHOD,
                "params": {
                    "threadId": "root",
                    "waitId": "request-1",
                    "waiting": true,
                    "error": { "codexErrorInfo": "rateLimitExceeded" },
                },
            }),
        );
        assert_eq!(
            event_rx.try_recv().unwrap()["event"],
            "response.block.created"
        );
        // The request's own clear notification was lost with the turn.
        mapper.map(
            &Some(event_tx),
            "device",
            "task",
            &ExecutionRequest::default(),
            json!({"method": "turn/completed", "params": {"threadId": "root"}}),
        );
        assert_eq!(
            event_rx.try_recv().unwrap()["payload"]["data"]["updates"]["status"],
            "done"
        );
    }

    #[test]
    fn child_turn_completion_keeps_the_root_retry_wait() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let mut mapper = CodexNotificationEventMapper::default();
        mapper.observe_root_thread_id("root");
        mapper.map(
            &Some(event_tx.clone()),
            "device",
            "task",
            &ExecutionRequest::default(),
            json!({
                "method": crate::server::local_model_proxy::retry_notifications::METHOD,
                "params": {
                    "threadId": "root",
                    "waitId": "request-1",
                    "waiting": true,
                    "error": { "codexErrorInfo": "rateLimitExceeded" },
                },
            }),
        );
        assert_eq!(
            event_rx.try_recv().unwrap()["event"],
            "response.block.created"
        );
        mapper.map(
            &Some(event_tx),
            "device",
            "task",
            &ExecutionRequest::default(),
            json!({"method": "turn/completed", "params": {"threadId": "child"}}),
        );
        assert!(
            event_rx.try_recv().is_err(),
            "A child turn completion cleared the root retry wait"
        );
    }

    fn proxy_wait(wait_id: &str, waiting: bool) -> Value {
        json!({
            "method": crate::server::local_model_proxy::retry_notifications::METHOD,
            "params": {"threadId": "thread", "waitId": wait_id, "waiting": waiting},
        })
    }

    #[test]
    fn concurrent_requests_in_one_thread_keep_independent_wait_lifetimes() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let mut mapper = CodexNotificationEventMapper::default();
        for message in [
            proxy_wait("first", true),
            proxy_wait("second", true),
            proxy_wait("first", false),
            proxy_wait("second", false),
        ] {
            mapper.map(
                &Some(event_tx.clone()),
                "device",
                "task",
                &ExecutionRequest::default(),
                message,
            );
        }
        for _ in 0..3 {
            let event = event_rx.try_recv().unwrap();
            assert!(event["payload"]["data"]["updates"]["status"].is_null());
        }
        assert_eq!(
            event_rx.try_recv().unwrap()["payload"]["data"]["updates"]["status"],
            "done"
        );
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn native_and_proxy_waits_resume_independently_in_either_order() {
        for proxy_resumes_first in [true, false] {
            let (event_tx, mut event_rx) = broadcast::channel(8);
            let mut mapper = CodexNotificationEventMapper::default();
            let native = json!({"method": "error", "params": {
                "threadId": "native", "willRetry": true,
                "error": {"codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 503}}}
            }});
            let progress = json!({"method": "turn/diff/updated", "params": {"threadId": "native"}});
            let (first, last, remaining_reason) = if proxy_resumes_first {
                (proxy_wait("proxy", false), progress, "connection")
            } else {
                (progress, proxy_wait("proxy", false), "rate_limit")
            };
            for message in [native, proxy_wait("proxy", true), first, last] {
                mapper.map(
                    &Some(event_tx.clone()),
                    "device",
                    "task",
                    &ExecutionRequest::default(),
                    message,
                );
            }
            assert_eq!(
                event_rx.try_recv().unwrap()["payload"]["data"]["block"]["tool_input"]
                    ["retry_reason"],
                "connection"
            );
            assert_eq!(
                event_rx.try_recv().unwrap()["payload"]["data"]["updates"]["tool_input"]
                    ["retry_reason"],
                "rate_limit"
            );
            let remaining = event_rx.try_recv().unwrap();
            assert_eq!(
                remaining["payload"]["data"]["updates"]["tool_input"]["retry_reason"],
                remaining_reason
            );
            assert!(remaining["payload"]["data"]["updates"]["status"].is_null());
            assert_eq!(
                event_rx.try_recv().unwrap()["payload"]["data"]["updates"]["status"],
                "done"
            );
        }
    }

    #[test]
    fn only_matching_thread_progress_or_terminal_error_clears_native_waits() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let mut mapper = CodexNotificationEventMapper::default();
        for message in [
            json!({"method": "error", "params": {"threadId": "child", "willRetry": true,
                "error": {"codexErrorInfo": "rateLimitExceeded"}}}),
            json!({"method": "turn/diff/updated", "params": {"threadId": "parent"}}),
            json!({"method": "error", "params": {"threadId": "child", "willRetry": false}}),
        ] {
            mapper.map(
                &Some(event_tx.clone()),
                "device",
                "task",
                &ExecutionRequest::default(),
                message,
            );
        }
        assert_eq!(
            event_rx.try_recv().unwrap()["event"],
            "response.block.created"
        );
        assert_eq!(
            event_rx.try_recv().unwrap()["payload"]["data"]["updates"]["status"],
            "done"
        );
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn unscoped_native_retry_clears_when_root_progress_has_a_thread_id() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let mut mapper = CodexNotificationEventMapper::default();
        for message in [
            json!({"method": "error", "params": {"willRetry": true,
                "error": {"codexErrorInfo": "rateLimitExceeded"}}}),
            json!({"method": "turn/diff/updated", "params": {"threadId": "root"}}),
        ] {
            mapper.map(
                &Some(event_tx.clone()),
                "device",
                "task",
                &ExecutionRequest::default(),
                message,
            );
        }
        assert_eq!(
            event_rx.try_recv().unwrap()["event"],
            "response.block.created"
        );
        assert_eq!(
            event_rx
                .try_recv()
                .expect("Root progress must end the unscoped wait")["payload"]["data"]["updates"]
                ["status"],
            "done"
        );
        assert!(mapper.native_retry_waits.is_empty());
    }

    #[test]
    fn child_progress_does_not_clear_unscoped_root_or_proxy_waits() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let mut mapper = CodexNotificationEventMapper {
            root_thread_id: Some("root".to_owned()),
            ..Default::default()
        };
        for message in [
            json!({"method": "error", "params": {"willRetry": true,
                "error": {"codexErrorInfo": "rateLimitExceeded"}}}),
            proxy_wait("proxy", true),
            json!({"method": "turn/diff/updated", "params": {"threadId": "child"}}),
        ] {
            mapper.map(
                &Some(event_tx.clone()),
                "device",
                "task",
                &ExecutionRequest::default(),
                message,
            );
        }
        assert_eq!(mapper.native_retry_waits.len(), 1);
        event_rx.try_recv().unwrap();
        event_rx.try_recv().unwrap();
        assert!(event_rx.try_recv().is_err());
        mapper.map(
            &Some(event_tx.clone()),
            "device",
            "task",
            &ExecutionRequest::default(),
            json!({"method": "turn/diff/updated", "params": {"threadId": "root"}}),
        );
        assert!(mapper.native_retry_waits.is_empty());
        let remaining = event_rx.try_recv().unwrap();
        assert_eq!(
            remaining["payload"]["data"]["updates"]["tool_input"]["retry_reason"],
            "rate_limit"
        );
        assert!(remaining["payload"]["data"]["updates"]["status"].is_null());
        mapper.map(
            &Some(event_tx),
            "device",
            "task",
            &ExecutionRequest::default(),
            proxy_wait("proxy", false),
        );
        assert_eq!(
            event_rx.try_recv().unwrap()["payload"]["data"]["updates"]["status"],
            "done"
        );
    }
}
