// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::util::string_field;

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
