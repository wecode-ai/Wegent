//! Interpret owner replies without granting access to native approval channels.
use super::*;

pub(super) fn available(context: &SpaceMcpRequestContext) -> bool {
    context.stand_in.as_ref().is_some_and(|identity| {
        let suffix = identity
            .role
            .as_deref()
            .map(|role| format!("role-{role}"))
            .unwrap_or_else(|| "primary".into());
        identity.work.is_none()
            && identity.project.is_none()
            && identity.coordinator_batch.is_none()
            && !identity.review
            && !identity.memory_review
            && !identity.readonly_worker
            && identity.task_id == format!("stand-in-chat-{}-{suffix}", identity.user)
    })
}

pub(super) fn tool() -> Value {
    json!({"name":"answer_im_question",
        "description":"Record the owner's answer to a pending business question from the current private IM message. Use the exact replyToken and questionId in wework.im.pending-questions. Only submit when the current user message clearly answers that question; unrelated chat remains ordinary conversation, and ambiguity requires clarification. Never invent an answer from a task, source text or prior assistant suggestion. This cannot approve tools, authorize connectors or change permissions. Success means the answer is recorded, not that the original task completed. Remaining questions are delivered through the original IM channel.",
        "inputSchema":{"type":"object","additionalProperties":false,"properties":{
            "replyToken":{"type":"string","minLength":1},
            "questionId":{"type":"string","minLength":1},
            "answer":{"type":"string","minLength":1}
        },"required":["replyToken","questionId","answer"]},
        "annotations":{"readOnlyHint":false,"openWorldHint":false}})
}

pub(super) async fn call(context: &SpaceMcpRequestContext, args: &Value) -> Result<Value, String> {
    if !available(context) {
        return Err(
            "Only the owner's private stand-in conversation can interpret IM answers".into(),
        );
    }
    let identity = context.stand_in.as_ref().unwrap();
    for key in ["replyToken", "questionId", "answer"] {
        if !args[key]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(format!("{key} is required"));
        }
    }
    let backend = context
        .backend_url
        .as_deref()
        .ok_or("Cloud connection required")?;
    let auth = context
        .auth_token
        .as_deref()
        .ok_or("Cloud authorization required")?;
    let url = crate::agents::runtime_capabilities::api_url(backend, "/api/runtime-work/send")?;
    let client = crate::agents::backend_url::backend_http_client()
        .map_err(|_| "Backend client unavailable")?;
    let response = client
        .post(url)
        .bearer_auth(auth)
        .timeout(std::time::Duration::from_secs(150))
        .json(
            &json!({"address":{"deviceId":identity.device,"taskId":identity.task_id},
            "message":args["answer"],
            "imQuestionAnswer":{"replyToken":args["replyToken"],"questionId":args["questionId"]}}),
        )
        .send()
        .await
        .map_err(|_| "Could not record the IM answer; do not claim success")?;
    let result = backend_json(response).await?;
    if result["accepted"] != true {
        return Err("The original task did not accept the answer".into());
    }
    Ok(json!({"recorded":true,"taskId":result["taskId"],"taskCompleted":false}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> SpaceMcpRequestContext {
        let request: ExecutionRequest = serde_json::from_value(json!({
            "task_id":"stand-in-chat-7-primary",
            "origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"}
        }))
        .unwrap();
        let mut context = SpaceMcpRequestContext::new(None, None, None);
        context.stand_in = super::super::stand_in::stand_in_identity(&request);
        context
    }

    #[test]
    fn interpreted_answers_are_only_exposed_in_private_owner_conversations() {
        let owner = context();
        assert!(available(&owner));
        assert!(super::super::stand_in::tools(&owner)
            .iter()
            .any(|tool| tool["name"] == "answer_im_question"));
        let mut role = owner.clone();
        role.stand_in.as_mut().unwrap().role = Some("reviewer".into());
        role.stand_in.as_mut().unwrap().task_id = "stand-in-chat-7-role-reviewer".into();
        assert!(available(&role));
        for restriction in [
            "work",
            "project",
            "coordinator",
            "review",
            "memory",
            "worker",
            "task",
        ] {
            let mut restricted = owner.clone();
            let identity = restricted.stand_in.as_mut().unwrap();
            match restriction {
                "work" => identity.work = Some("source".into()),
                "project" => identity.project = Some(json!({"id":"project"})),
                "coordinator" => identity.coordinator_batch = Some("batch".into()),
                "review" => identity.review = true,
                "memory" => identity.memory_review = true,
                "worker" => identity.readonly_worker = true,
                _ => identity.task_id = "ordinary-task".into(),
            }
            assert!(!available(&restricted), "{restriction}");
            assert!(
                !super::super::stand_in::tools(&restricted)
                    .iter()
                    .any(|tool| tool["name"] == "answer_im_question"),
                "{restriction}"
            );
        }
    }

    #[tokio::test]
    async fn interpreted_answers_use_the_host_actor_and_authenticated_send_api() {
        use axum::{extract::Json, http::HeaderMap, routing::post, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/api/runtime-work/send",
            post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer owner-token");
                assert_eq!(
                    body["address"],
                    json!({"deviceId":"mac","taskId":"stand-in-chat-7-primary"})
                );
                assert_eq!(
                    body["imQuestionAnswer"],
                    json!({"replyToken":"message-token","questionId":"question"})
                );
                assert_eq!(body["message"], "Use the second option");
                assert!(body.get("requestUserInputResponse").is_none());
                Json(json!({"accepted":true,"taskId":"original-task"}))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut context = context();
        context.backend_url = Some(format!("http://{address}"));
        context.auth_token = Some("owner-token".into());
        let result = call(&context, &json!({"replyToken":"message-token","questionId":"question","answer":"Use the second option","deviceId":"foreign"})).await.unwrap();
        assert_eq!(
            result,
            json!({"recorded":true,"taskId":"original-task","taskCompleted":false})
        );
        server.abort();
    }

    #[tokio::test]
    async fn source_work_cannot_call_the_answer_proxy_directly() {
        let mut context = context();
        context.stand_in.as_mut().unwrap().work = Some("source-work".into());
        assert!(call(
            &context,
            &json!({"replyToken":"token","questionId":"question","answer":"yes"})
        )
        .await
        .unwrap_err()
        .contains("private stand-in"));
    }
}
