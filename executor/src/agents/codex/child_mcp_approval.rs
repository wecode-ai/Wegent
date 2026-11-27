//! Deliver subagent approval decisions directly to the originating app-server request.
use super::*;

impl CodexAppServerClient {
    pub(crate) async fn answer_child_mcp_approval(
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
            .pending_mcp_elicitations
            .lock()
            .unwrap()
            .get(&request_id.to_string())
            .map(|pending| pending.request.clone());
        let Some(mut request) = request else {
            return Ok(None);
        };
        let params = message_params(&request);
        let Some(turn_id) = response["interactionScope"].as_str() else {
            return Ok(None);
        };
        if !is_mcp_tool_call_approval(params) || params["turnId"].as_str() != Some(turn_id) {
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
        let result = mcp_server_elicitation_response(&request, Some(response))?;
        let status = elicitation::response_status(&result);
        if !transport.answer_mcp_elicitation(request_id, result).await? {
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
    let Some(answer) = answers
        .get(MCP_ELICITATION_APPROVAL_QUESTION_ID)
        .and_then(|answer| answer["answers"].as_array())
    else {
        return false;
    };
    let [answer] = answer.as_slice() else {
        return false;
    };
    answers.len() == 1
        && mcp_server_elicitation_request_user_input_params(message_params(request)).is_some_and(
            |payload| {
                payload["questions"][0]["options"]
                    .as_array()
                    .is_some_and(|options| options.iter().any(|option| &option["label"] == answer))
            },
        )
}
