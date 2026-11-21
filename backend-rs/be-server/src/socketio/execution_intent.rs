// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `LoopItemExecution`'s persisted intent envelope.
//!
//! Source: `app/models/loop_item_execution.py`'s `execution_intent`,
//! `runtime_selection` and `runtime_origin_context` properties plus
//! `_serialize_execution_intent` / `execution_runtime_task_id`. A V1 row
//! stored the Runtime selection dictionary directly, so the selection
//! property falls back to the whole decoded payload.
//!
//! Callers pass the stored `execution_payload`; the envelope is only read.

use serde_json::{Value, json};

use crate::json_compat::{python_str, python_truthy};

/// `RUNTIME_TASK_ID_PREFIX` for a retry attempt without a thread to resume.
const RUNTIME_TASK_ID_PREFIX: &str = "codex-queue";

/// `LoopItemExecution.execution_intent`: the stored envelope when it decodes
/// to a JSON object, otherwise `{}`.
pub(super) fn execution_intent(payload: Option<&str>) -> Value {
    let Some(payload) = payload.filter(|payload| !payload.is_empty()) else {
        return json!({});
    };
    match serde_json::from_str::<Value>(payload) {
        Ok(value @ Value::Object(_)) => value,
        _ => json!({}),
    }
}

/// `LoopItemExecution.runtime_selection`: the nested selection when it is an
/// object, and otherwise the whole intent value (V1 rows stored the selection
/// dictionary directly).
pub(super) fn runtime_selection(intent: &Value) -> Value {
    match intent.get("runtime_selection") {
        Some(selection @ Value::Object(_)) => selection.clone(),
        _ => intent.clone(),
    }
}

/// `LoopItemExecution.runtime_origin_context`: an object or `{}`.
pub(super) fn runtime_origin_context(intent: &Value) -> Value {
    intent
        .get("origin_context")
        .filter(|context| context.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}))
}

/// `_serialize_execution_intent(runtime_selection=..., origin_context=...)`
/// over the previous attempt's stored intent.
pub(super) fn retry_execution_payload(payload: Option<&str>) -> String {
    let intent = execution_intent(payload);
    format!(
        "{{\"schema_version\":2,\"runtime_selection\":{},\"origin_context\":{}}}",
        runtime_selection(&intent),
        runtime_origin_context(&intent)
    )
}

/// `execution_runtime_task_id`: `str(origin.comment_continue_task_id or
/// runtime_task_id_for(id))`, so any truthy reported value is converted with
/// Python's `str`.
pub(super) fn retry_runtime_task_id(payload: Option<&str>, retry_id: i64) -> String {
    let intent = execution_intent(payload);
    runtime_origin_context(&intent)
        .get("comment_continue_task_id")
        .filter(|value| python_truthy(value))
        .map(python_str)
        .unwrap_or_else(|| format!("{RUNTIME_TASK_ID_PREFIX}-{retry_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_intents_keep_the_whole_selection_and_reject_non_objects() {
        // V1 rows stored the selection dictionary directly at the top level.
        let payload = Some(r#"{"executor_kind":"local","device_id":"device-1"}"#);
        let parsed: Value = serde_json::from_str(&retry_execution_payload(payload)).unwrap();
        assert_eq!(
            parsed,
            json!({
                "schema_version": 2,
                "runtime_selection": {"executor_kind": "local", "device_id": "device-1"},
                "origin_context": {},
            })
        );
        for (payload, expected_selection) in [
            (Some("[1,2]"), json!({})),
            (Some("not-json"), json!({})),
            (Some("null"), json!({})),
            (None, json!({})),
            (
                Some(r#"{"runtime_selection":null,"origin_context":{"keep":1}}"#),
                json!({"runtime_selection": null, "origin_context": {"keep": 1}}),
            ),
        ] {
            let intent = execution_intent(payload);
            assert_eq!(
                runtime_selection(&intent),
                expected_selection,
                "{payload:?}"
            );
        }
        assert_eq!(
            runtime_origin_context(&execution_intent(Some(r#"{"origin_context":[1]}"#))),
            json!({})
        );
        assert_eq!(
            runtime_origin_context(&execution_intent(Some(r#"{"origin_context":{"a":1}}"#))),
            json!({"a": 1})
        );
    }

    #[test]
    fn retry_payload_preserves_the_intent_shape() {
        let payload = Some(
            r#"{"schema_version":2,"runtime_selection":{"executor_kind":"local"},"origin_context":{"comment_continue_task_id":"thread-1"}}"#,
        );
        assert_eq!(
            retry_execution_payload(payload),
            r#"{"schema_version":2,"runtime_selection":{"executor_kind":"local"},"origin_context":{"comment_continue_task_id":"thread-1"}}"#
        );
        assert_eq!(retry_runtime_task_id(payload, 9), "thread-1");
        assert_eq!(
            retry_runtime_task_id(Some(r#"{"schema_version":2,"origin_context":{}}"#), 9),
            "codex-queue-9"
        );
        // `str(value or canonical)`: a truthy non-string reported thread id is
        // converted with Python's `str`.
        assert_eq!(
            retry_runtime_task_id(
                Some(r#"{"origin_context":{"comment_continue_task_id":77}}"#),
                9
            ),
            "77"
        );
    }
}
