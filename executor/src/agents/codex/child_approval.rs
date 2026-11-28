//! Deliver subagent approval decisions directly to the originating app-server request.
use super::*;

impl CodexAppServerClient {
    pub(crate) async fn answer_child_approval(
        &self,
        request_id: &Value,
        response: &Value,
        child_policy: impl FnOnce(&str) -> Option<bool>,
    ) -> Result<Option<bool>, String> {
        let Ok(transport) = self.existing_process().await else {
            return Ok(None);
        };
        let request = transport
            .notifications
            .pending_server_interactions
            .lock()
            .unwrap()
            .get(&request_id.to_string())
            .map(|pending| pending.request.clone());
        let Some(mut request) = request else {
            return Ok(None);
        };
        let method = request["method"].as_str().unwrap_or_default();
        let native_approval = is_codex_approval_request_method(method);
        let params = message_params(&request);
        let Some(turn_id) = response["interactionScope"].as_str() else {
            return Ok(None);
        };
        if (!native_approval && !is_mcp_tool_call_approval(params))
            || params["turnId"].as_str() != Some(turn_id)
        {
            return Ok(None);
        }
        let Some(single_approval) = params["threadId"].as_str().and_then(child_policy) else {
            return Ok(None);
        };
        if single_approval {
            restrict_stand_in_approval(&mut request);
        }
        if elicitation::remaining(&request).is_zero() || !valid_decision(&request, response) {
            return Ok(Some(false));
        }
        let (result, status) = if native_approval {
            (codex_approval_result(&request, response)?, "answered")
        } else {
            let result = mcp_server_elicitation_response(&request, Some(response))?;
            let status = elicitation::response_status(&result);
            (result, status)
        };
        if !transport
            .answer_server_interaction(request_id, result)
            .await?
        {
            return Ok(Some(false));
        }
        transport
            .notifications
            .send_runtime(elicitation::settled(&request, status, Some(response)).into())
            .await;
        Ok(Some(true))
    }
}

fn valid_decision(request: &Value, response: &Value) -> bool {
    let Some(answers) = response["answers"].as_object() else {
        return false;
    };
    if answers.is_empty() {
        return true;
    }
    let method = request["method"].as_str().unwrap_or_default();
    let params = message_params(request);
    let (question_id, payload) = if is_codex_approval_request_method(method) {
        (
            CODEX_APPROVAL_QUESTION_ID,
            crate::runtime_work::codex_approval_render_payload(method, params, request.get("id"))
                .map(|(_, payload)| payload),
        )
    } else {
        (
            MCP_ELICITATION_APPROVAL_QUESTION_ID,
            mcp_server_elicitation_request_user_input_params(params),
        )
    };
    let Some(answer) = answers
        .get(question_id)
        .and_then(|answer| answer["answers"].as_array())
    else {
        return false;
    };
    let [answer] = answer.as_slice() else {
        return false;
    };
    answers.len() == 1
        && payload.is_some_and(|payload| {
            payload["questions"][0]["options"]
                .as_array()
                .is_some_and(|options| options.iter().any(|option| &option["label"] == answer))
        })
}
