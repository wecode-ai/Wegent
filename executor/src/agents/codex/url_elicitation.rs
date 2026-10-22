use super::{
    elicitation, is_mcp_tool_call_approval, mcp_server_elicitation_request_user_input_params,
    mcp_server_elicitation_response, mcp_server_tool_call_approval_response, message_params,
    InteractionAnswerRouter,
};
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) struct ElicitationResult {
    pub result: Value,
    pub status: &'static str,
}

impl ElicitationResult {
    pub(super) fn from_result(result: Value) -> Self {
        let status = elicitation::response_status(&result);
        Self { result, status }
    }
}

pub(super) async fn shared_response(
    message: &Value,
    answers: Option<Arc<InteractionAnswerRouter>>,
    key: String,
    auto_approve: bool,
) -> Result<Option<ElicitationResult>, String> {
    let params = message_params(message);
    if auto_approve && is_mcp_tool_call_approval(params) {
        return mcp_server_tool_call_approval_response(message)
            .map(ElicitationResult::from_result)
            .map(Some);
    }
    // Never await an answer for a request the UI cannot display.
    if mcp_server_elicitation_request_user_input_params(params).is_none() {
        return mcp_server_elicitation_response(message, None)
            .map(ElicitationResult::from_result)
            .map(Some);
    }
    let Some(router) = answers else {
        return mcp_server_elicitation_response(message, None)
            .map(ElicitationResult::from_result)
            .map(Some);
    };
    let response =
        match tokio::time::timeout(elicitation::remaining(message), router.receive(key.clone()))
            .await
        {
            Ok(result) => result?,
            Err(_) => {
                router.expire(&key).await;
                elicitation::log_event("codex mcp elicitation timed out", message);
                return Ok(Some(ElicitationResult {
                    result: json!({"action": "cancel"}),
                    status: "expired",
                }));
            }
        };
    let Some(response) = response else {
        return Ok(None);
    };
    mcp_server_elicitation_response(message, Some(&response))
        .map(ElicitationResult::from_result)
        .map(Some)
}

pub(super) fn request_params(params: &Value) -> Option<Value> {
    let address = params.get("url")?.as_str()?;
    let url = url::Url::parse(address).ok()?;
    let is_loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && is_loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let elicitation_id = params.get("elicitationId")?.as_str()?;
    if elicitation_id.trim().is_empty() {
        return None;
    }
    Some(json!({
        "itemId": "mcp_server_elicitation",
        "interactionKind": "mcp_url",
        "mode": "url",
        "url": address,
        "elicitationId": elicitation_id,
        "serverName": params.get("serverName"),
        "message": params.get("message"),
        "questions": [],
    }))
}

pub(super) fn response_result(response: &Value) -> Value {
    let action = response
        .pointer("/answers/__mcp_url/answers/0")
        .and_then(Value::as_str);
    // Consent to opening the browser is not proof of successful authorization.
    json!({"action": match action {
        Some("accept") => "accept",
        Some("decline") => "decline",
        _ => "cancel",
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn form() -> Value {
        json!({"id": 0, "params": {
            "mode": "form", "threadId": "thread-1", "turnId": "turn-1",
            "serverName": "wegent-sites-interactions",
            "requestedSchema": {"type": "object", "properties": {
                "action": {"type": "string", "enum": ["production", "preview"]}
            }}
        }})
    }

    #[tokio::test(start_paused = true)]
    async fn mcp_elicitation_form_expires_after_five_minutes_without_accepting() {
        let (sender, receiver) = mpsc::channel(1);
        let router = InteractionAnswerRouter::new(receiver);
        let task_router = router.clone();
        let task = tokio::spawn(async move {
            shared_response(&form(), Some(task_router), "0".to_owned(), false).await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_secs(299)).await;
        assert!(!task.is_finished());
        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        let outcome = task.await.unwrap().unwrap().unwrap();
        assert_eq!(outcome.status, "expired");
        assert_eq!(outcome.result, json!({"action": "cancel"}));
        sender
            .send(json!({"requestId": 0, "answers": {"action": {"answers": ["production"]}}}))
            .await
            .unwrap();
        tokio::task::yield_now().await;
        assert!(router.receive("0".to_owned()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mcp_elicitation_form_normal_answer_and_cancel_settle_explicitly() {
        for (answer, expected_action, expected_status) in [
            (
                json!({"action": {"answers": ["production"]}}),
                "accept",
                "answered",
            ),
            (json!({}), "cancel", "cancelled"),
        ] {
            let (sender, receiver) = mpsc::channel(1);
            let router = InteractionAnswerRouter::new(receiver);
            sender
                .send(json!({"requestId": 0, "answers": answer}))
                .await
                .unwrap();
            let outcome = shared_response(&form(), Some(router), "0".to_owned(), false)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(outcome.result["action"], expected_action);
            assert_eq!(outcome.status, expected_status);
        }
    }
}
