// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn record_active_codex_text_delta(
        &self,
        local_task_id: &str,
        turn_id: &str,
        params: &Value,
        text_item_type: &str,
    ) {
        let Some(item_id) = string_field(params, "itemId")
            .or_else(|| string_field(params, "item_id"))
            .filter(|item_id| !item_id.is_empty())
        else {
            return;
        };
        let Some(delta) = raw_string_field(params, "delta").filter(|delta| !delta.is_empty())
        else {
            return;
        };
        let Ok(mut active_items) = self.active_codex_transcript_items.lock() else {
            return;
        };
        let Some(transcript) = active_items.get_mut(local_task_id) else {
            return;
        };
        if transcript.turn_id != turn_id {
            return;
        }
        if let Some(existing) = transcript
            .items
            .iter_mut()
            .find(|existing| string_field(existing, "id").as_deref() == Some(item_id.as_str()))
        {
            if string_field(existing, "type").as_deref() != Some(text_item_type) {
                return;
            }
            if let Some(object) = existing.as_object_mut() {
                match object.entry("text").or_insert_with(|| json!("")) {
                    Value::String(text) => text.push_str(&delta),
                    text => *text = Value::String(delta),
                }
                object.insert("status".to_owned(), Value::String("inProgress".to_owned()));
            }
            return;
        }
        transcript.items.push(json!({
            "id": item_id,
            "type": text_item_type,
            "text": delta,
            "status": "inProgress",
            "createdAt": now_ms(),
        }));
    }
}
