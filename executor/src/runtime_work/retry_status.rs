use serde_json::{json, Value};

use super::{
    emit_response_event, now_ms, string_field, CodexNotificationEventMapper, EventEmitContext,
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
    let info = params.pointer("/error/codexErrorInfo");
    if info.and_then(Value::as_str) == Some("rateLimitExceeded")
        || info.is_some_and(|info| {
            info.as_object().is_some_and(|variants| {
                variants
                    .values()
                    .any(|value| value.get("httpStatusCode").and_then(Value::as_u64) == Some(429))
            })
        })
    {
        "rate_limit"
    } else {
        "connection"
    }
}

impl CodexNotificationEventMapper {
    pub(super) fn emit_reconnecting(&mut self, context: &EventEmitContext<'_>, params: &Value) {
        let tool_input = json!({
            "message": params.pointer("/error/message").or_else(|| params.get("message"))
                .and_then(Value::as_str).unwrap_or("Reconnecting"),
            "model_kind": string_field(&context.request.model_config, "wework_model_kind")
                .or_else(|| string_field(&context.request.model_config, "weworkModelKind")),
            "retry_reason": retry_reason(params),
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
        for info in [
            Value::Null,
            json!("serverOverloaded"),
            json!({"httpConnectionFailed": {"httpStatusCode": 503}}),
        ] {
            assert_eq!(
                retry_reason(&json!({"error": {"codexErrorInfo": info, "message": "429"}})),
                "connection"
            );
        }
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
}
