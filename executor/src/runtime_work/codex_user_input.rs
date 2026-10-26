// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::util::{item_id, item_type, now_ms, string_field};

pub(super) const APPROVAL_SETTLED_METHOD: &str = "wegent/approval/settled";

/// Native timeline pages may omit an unanswered blocking tool call. Keep the
/// actual server request identity so a refreshed card answers its live waiter.
pub(super) fn request_item(message: &Value) -> Option<Value> {
    let request_id = message.get("id")?;
    let method = message["method"].as_str()?;
    let params = message.get("params")?;
    let (id, mut payload) = if method == "item/tool/requestUserInput" {
        let id = request_id
            .as_str()
            .map(str::to_owned)
            .or_else(|| request_id.is_number().then(|| request_id.to_string()))?;
        let payload = params.clone();
        payload.get("questions")?.as_array()?;
        (format!("request-user-input-{id}"), payload)
    } else {
        let approval_method = if method == APPROVAL_SETTLED_METHOD {
            params["approvalMethod"].as_str()?
        } else {
            method
        };
        super::events::codex_approval_render_payload(approval_method, params, Some(request_id))?
    };
    payload["kind"] = json!("request_user_input");
    payload["requestId"] = request_id.clone();
    payload["interactionScope"] = payload.get("turnId")?.clone();
    if payload.get("interactionStatus").is_none() {
        payload["interactionStatus"] = json!("pending");
    }
    Some(json!({
        "id": id,
        "type": "userInputRequest", "renderPayload": payload, "createdAt": now_ms(),
    }))
}

pub(super) fn interaction_block(item: &Value, terminal: bool) -> Value {
    let mut payload = item["renderPayload"].clone();
    if payload["interactionStatus"] == "pending" {
        let expired = payload["expiresAtUnixMs"]
            .as_i64()
            .is_some_and(|deadline| deadline <= now_ms());
        if terminal || expired {
            payload["interactionStatus"] = json!(if expired { "expired" } else { "cancelled" });
            payload["settledAtUnixMs"] = json!(now_ms());
        }
    }
    json!({
        "id": item["id"], "type": "tool", "tool_name": "request_user_input",
        "status": if payload["interactionStatus"] == "pending" { "pending" } else { "done" },
        "timestamp": item["createdAt"], "render_payload": payload,
    })
}

pub(crate) fn async_question_payload_from_item(params: &Value) -> Option<Value> {
    let item = params.get("item").unwrap_or(params);
    if item_type(item) != "agentmessage" {
        return None;
    }
    let questions = item.get("questions")?.as_array()?;
    let item_id = item_id(item, "request-user-input");
    async_question_render_payload(&item_id, questions)
}

/// A `request_user_input_async` question: one prompt plus suggested answers.
///
/// Codex uses the same shape in the live `agentMessage.questions` payload and in
/// the replayed `request_user_input_async` tool arguments, so both projections of
/// the interactive card normalize here. The answer to such a question is always
/// the next user message, never a runtime response.
pub(crate) fn async_question_render_payload(item_id: &str, questions: &[Value]) -> Option<Value> {
    let questions = questions
        .iter()
        .enumerate()
        .filter_map(|(index, question)| async_question(index, question))
        .collect::<Vec<_>>();
    if questions.is_empty() {
        return None;
    }
    Some(json!({
        "kind": "request_user_input",
        "delivery": "async",
        "itemId": item_id,
        "questions": questions,
    }))
}

fn async_question(index: usize, question: &Value) -> Option<Value> {
    let prompt = string_field(question, "title")
        .or_else(|| string_field(question, "question"))
        .unwrap_or_default()
        .trim()
        .to_owned();
    let options = question
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(option_label)
        .collect::<Vec<_>>();
    if prompt.is_empty() && options.is_empty() {
        return None;
    }
    Some(json!({
        "id": format!("question_{}", index + 1),
        "question": prompt,
        "options": options,
        // Codex accepts a free-text answer next to the suggested options.
        "is_other": true,
    }))
}

fn option_label(option: &Value) -> Option<Value> {
    let label = option
        .as_str()
        .map(str::to_owned)
        .or_else(|| string_field(option, "label"))
        .unwrap_or_default();
    let label = label.trim();
    (!label.is_empty()).then(|| json!({ "label": label }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_title_and_plain_string_options() {
        let payload = async_question_render_payload(
            "call-1",
            &[json!({
                "title": "Which state jitters?",
                "options": ["Following", "Reading", "Both"],
            })],
        )
        .expect("payload");

        assert_eq!(payload["kind"], "request_user_input");
        assert_eq!(payload["delivery"], "async");
        assert_eq!(payload["itemId"], "call-1");
        assert_eq!(payload["questions"][0]["id"], "question_1");
        assert_eq!(payload["questions"][0]["question"], "Which state jitters?");
        assert_eq!(payload["questions"][0]["is_other"], true);
        assert_eq!(payload["questions"][0]["options"][0]["label"], "Following");
        assert_eq!(payload["questions"][0]["options"][2]["label"], "Both");
    }

    #[test]
    fn drops_blank_questions_and_blank_options() {
        let payload = async_question_render_payload(
            "call-2",
            &[
                json!({"title": "   "}),
                json!({"title": "Pick one", "options": ["  ", "Second"]}),
            ],
        )
        .expect("payload");

        let questions = payload["questions"].as_array().expect("questions");
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0]["question"], "Pick one");
        assert_eq!(questions[0]["options"].as_array().map(Vec::len), Some(1));
        assert_eq!(questions[0]["options"][0]["label"], "Second");
    }

    #[test]
    fn rejects_questions_without_prompt_or_options() {
        assert!(async_question_render_payload("call-3", &[json!({"title": ""})]).is_none());
        assert!(async_question_render_payload("call-4", &[]).is_none());
    }
}
