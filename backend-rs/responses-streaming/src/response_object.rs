// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `ResponseObject` for the create flow
//! (`app/schemas/openapi_response.py:ResponseObject` +
//! `app/services/openapi/output_builder.py`).
//!
//! The recorded `queued` body pins the field order and values:
//! `{"id": "resp_<task_id>", "object": "response", "created_at": <unix>,
//! "status": "queued", "error": null, "model": "<request model>", "output": [],
//! "pending_user_input": null, "pending_user_input_payload": null,
//! "previous_response_id": null}`.
use serde::Serialize;
use serde_json::Value;

/// `ResponseObject` (OpenAI Responses API shape). The keys serialize in the
/// recorded order.
#[derive(Debug, Clone, Serialize)]
pub struct ResponseObject {
    pub id: String,
    pub object: &'static str,
    pub created_at: i64,
    pub status: &'static str,
    pub error: Option<Value>,
    pub model: String,
    pub output: Vec<Value>,
    pub pending_user_input: Option<bool>,
    pub pending_user_input_payload: Option<Value>,
    pub previous_response_id: Option<String>,
}

impl ResponseObject {
    /// The non-SSE executor response: `id = f"resp_{task_id}"`, `status
    /// "queued"`, the built `output`, and the always-null pending-input fields.
    pub fn queued(
        task_id: i64,
        created_at: i64,
        model: &str,
        output: Vec<Value>,
        previous_response_id: Option<String>,
    ) -> Self {
        let (pending_user_input, pending_user_input_payload) = extract_pending_user_input_state();
        Self {
            id: format!("resp_{task_id}"),
            object: "response",
            created_at,
            status: "queued",
            error: None,
            model: model.to_string(),
            output,
            // `pending_user_input or None` / `pending_user_input_payload`.
            pending_user_input: pending_user_input.then_some(true),
            pending_user_input_payload,
            previous_response_id,
        }
    }
}

/// `extract_pending_user_input_state`: the Responses API never exposes the
/// legacy pending-user-input state, so this is always `(false, None)`.
pub fn extract_pending_user_input_state() -> (bool, Option<Value>) {
    (false, None)
}

impl ResponseObject {
    /// The streaming `response.created` / `response.in_progress` body
    /// (`output_builder`'s `status="in_progress"`, empty output).
    pub fn in_progress(
        task_id: i64,
        created_at: i64,
        model: &str,
        previous_response_id: Option<String>,
    ) -> Self {
        Self {
            id: format!("resp_{task_id}"),
            object: "response",
            created_at,
            status: "in_progress",
            error: None,
            model: model.to_string(),
            output: Vec::new(),
            pending_user_input: None,
            pending_user_input_payload: None,
            previous_response_id,
        }
    }
}

/// One subtask row as the output builder reads it.
#[derive(Debug, Clone)]
pub struct OutputSubtask {
    pub id: i64,
    pub role: String,
    /// The parsed `subtasks.result` JSON (the DB stores it as text; a fresh
    /// subtask carries `"null"`).
    pub result: Value,
}

/// `build_response_output(subtasks, active_assistant_subtask_id=…,
/// active_assistant_status="in_progress", content_override="")`.
///
/// Only the reachable branch is ported: a non-`ASSISTANT` row emits nothing, an
/// assistant row whose `result` carries a list `output_items` passes those
/// through, and a row with neither `output_items` nor text/reasoning emits
/// nothing — the just-created assistant subtask carries `result = null`, so the
/// non-SSE `queued` output is `[]`. The message-chain and block builders
/// (`_build_items_from_messages_chain`, `_build_items_from_blocks`) are
/// **unexercised by the recording** and are intentionally not implemented.
pub fn build_response_output(subtasks: &[OutputSubtask]) -> Vec<Value> {
    let mut output = Vec::new();
    for subtask in subtasks {
        if subtask.role != "ASSISTANT" {
            continue;
        }
        if let Some(items) = subtask.result.get("output_items").and_then(Value::as_array) {
            output.extend(items.iter().cloned());
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn queued_object_matches_the_recorded_shape_and_order() {
        let object = ResponseObject::queued(
            801_406_538_446_277,
            1_791_613_442,
            "ns-a#team-alpha",
            Vec::new(),
            None,
        );
        assert_eq!(
            serde_json::to_value(&object).expect("serialize"),
            json!({
                "id": "resp_801406538446277",
                "object": "response",
                "created_at": 1_791_613_442_i64,
                "status": "queued",
                "error": null,
                "model": "ns-a#team-alpha",
                "output": [],
                "pending_user_input": null,
                "pending_user_input_payload": null,
                "previous_response_id": null,
            })
        );
    }

    #[test]
    fn a_fresh_assistant_subtask_emits_no_output() {
        let subtasks = vec![
            OutputSubtask {
                id: 801_406_538_446_279,
                role: "USER".to_string(),
                result: Value::Null,
            },
            OutputSubtask {
                id: 801_406_538_446_280,
                role: "ASSISTANT".to_string(),
                result: Value::Null,
            },
        ];
        assert!(build_response_output(&subtasks).is_empty());
    }

    #[test]
    fn an_assistant_output_items_list_passes_through() {
        let subtasks = vec![OutputSubtask {
            id: 1,
            role: "ASSISTANT".to_string(),
            result: json!({"output_items": [{"type": "message", "id": "msg_1"}]}),
        }];
        assert_eq!(
            build_response_output(&subtasks),
            vec![json!({"type": "message", "id": "msg_1"})]
        );
        // A user row with the same result still emits nothing.
        let user = vec![OutputSubtask {
            id: 2,
            role: "USER".to_string(),
            result: json!({"output_items": [{"type": "message"}]}),
        }];
        assert!(build_response_output(&user).is_empty());
    }

    #[test]
    fn pending_user_input_state_is_always_empty() {
        assert_eq!(extract_pending_user_input_state(), (false, None));
    }
}
