// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

const CLOUD_TRANSCRIPT_HANDLE_KEY: &str = "cloudTranscript";

impl RuntimeWorkRpcHandler {
    pub(super) fn transcript_sync_status(&self, payload: Value) -> Result<Value, AppIpcError> {
        let transcript_id = required_transcript_id(&payload)?;
        let local_task_id = local_transcript_task_id(&payload, &transcript_id);
        let Some(link) = self.local_task_link(&local_task_id) else {
            return Ok(sync_status(
                &local_task_id,
                &transcript_id,
                false,
                0,
                "task_missing",
            ));
        };
        if !is_codex_runtime(&link.runtime) {
            return Ok(sync_status(
                &local_task_id,
                &transcript_id,
                false,
                imported_through(&link),
                "unsupported_runtime",
            ));
        }
        if !transcript_matches(&link, &transcript_id) {
            return Ok(sync_status(
                &local_task_id,
                &transcript_id,
                false,
                imported_through(&link),
                "different_branch",
            ));
        }
        if link.thread_id.is_none() {
            return Ok(sync_status(
                &local_task_id,
                &transcript_id,
                true,
                imported_through(&link),
                "thread_pending",
            ));
        }
        if self.is_busy_local_task(&local_task_id) {
            return Ok(sync_status(
                &local_task_id,
                &transcript_id,
                false,
                imported_through(&link),
                "task_running",
            ));
        }
        Ok(sync_status(
            &local_task_id,
            &transcript_id,
            true,
            imported_through(&link),
            "ready",
        ))
    }

    pub(super) async fn import_transcript_turns(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let transcript_id = required_transcript_id(&payload)?;
        let local_task_id = local_transcript_task_id(&payload, &transcript_id);
        let status = self.transcript_sync_status(json!({
            "transcriptId": transcript_id,
            "taskId": local_task_id,
        }))?;
        if status.get("available").and_then(Value::as_bool) != Some(true) {
            return Ok(status);
        }
        let mut link = self
            .local_task_link(&local_task_id)
            .ok_or_else(|| AppIpcError::new("task_missing", "runtime task is unavailable"))?;
        let current = imported_through(&link);
        let turns = payload
            .get("turns")
            .and_then(Value::as_array)
            .ok_or_else(|| AppIpcError::new("bad_request", "turns is required"))?;
        if turns.is_empty() {
            return Ok(sync_status(
                &local_task_id,
                &transcript_id,
                true,
                current,
                "ready",
            ));
        }
        let mut expected = current + 1;
        let mut last_sequence = current;
        let mut items = Vec::new();
        for turn in turns {
            let sequence = turn
                .get("sequence")
                .and_then(Value::as_u64)
                .ok_or_else(|| AppIpcError::new("bad_request", "turn sequence is required"))?;
            if sequence <= current {
                continue;
            }
            if sequence != expected {
                return Err(AppIpcError::new(
                    "sequence_conflict",
                    format!("transcript import expected sequence {expected}, received {sequence}"),
                ));
            }
            items.extend(response_items_from_cloud_turn(turn));
            expected += 1;
            last_sequence = sequence;
        }
        if last_sequence == current {
            return Ok(sync_status(
                &local_task_id,
                &transcript_id,
                true,
                current,
                "ready",
            ));
        }
        let resumed_thread_id = if let Some(thread_id) = link.thread_id.clone() {
            self.resume_codex_thread_for_action(&link, &thread_id)
                .await
                .map_err(|error| AppIpcError::new("thread_resume_failed", error))?
        } else {
            let request = runtime_event_request_from_link(&link);
            let thread_id = start_codex_app_server_thread(&self.codex_app_server, &request)
                .await
                .map_err(|error| AppIpcError::new("thread_start_failed", error))?;
            self.record_local_task_thread(&local_task_id, &thread_id);
            self.register_codex_thread_workspace_root(&thread_id, &request);
            link.thread_id = Some(thread_id.clone());
            thread_id
        };
        if !items.is_empty() {
            self.call_codex_thread_method(
                "thread/inject_items",
                json!({
                    "threadId": resumed_thread_id,
                    "items": items,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("transcript_import_failed", error))?;
        }
        set_cloud_transcript(&mut link, &transcript_id, last_sequence);
        link.updated_at = now_ms();
        self.upsert_local_task(link);
        Ok(sync_status(
            &local_task_id,
            &transcript_id,
            true,
            last_sequence,
            "ready",
        ))
    }

    pub(super) fn acknowledge_transcript_turn(&self, payload: Value) -> Result<Value, AppIpcError> {
        let transcript_id = required_transcript_id(&payload)?;
        let local_task_id = local_transcript_task_id(&payload, &transcript_id);
        let sequence = payload
            .get("sequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| AppIpcError::new("bad_request", "sequence is required"))?;
        let parent_transcript_id = string_field(&payload, "parentTranscriptId")
            .or_else(|| string_field(&payload, "parent_transcript_id"));
        let updated = self.store.update_task(&local_task_id, |link| {
            let current_id = cloud_transcript_id(link);
            let may_rebind = current_id.as_deref() == Some(transcript_id.as_str())
                || current_id.is_none()
                || parent_transcript_id.as_deref() == current_id.as_deref();
            if may_rebind {
                set_cloud_transcript(link, &transcript_id, sequence);
                link.updated_at = now_ms();
            }
        });
        let Some(link) = updated else {
            return Ok(sync_status(
                &local_task_id,
                &transcript_id,
                false,
                0,
                "task_missing",
            ));
        };
        Ok(sync_status(
            &local_task_id,
            &transcript_id,
            transcript_matches(&link, &transcript_id),
            imported_through(&link),
            "acknowledged",
        ))
    }
}

fn required_transcript_id(payload: &Value) -> Result<String, AppIpcError> {
    string_field(payload, "transcriptId")
        .or_else(|| string_field(payload, "transcript_id"))
        .ok_or_else(|| AppIpcError::new("bad_request", "transcriptId is required"))
}

fn local_transcript_task_id(payload: &Value, transcript_id: &str) -> String {
    runtime_task_id(payload).unwrap_or_else(|| transcript_id.to_owned())
}

fn sync_status(
    local_task_id: &str,
    transcript_id: &str,
    available: bool,
    imported_through: u64,
    reason: &str,
) -> Value {
    json!({
        "success": true,
        "available": available,
        "taskId": local_task_id,
        "transcriptId": transcript_id,
        "importedThrough": imported_through,
        "reason": reason,
    })
}

fn cloud_transcript_id(link: &RuntimeTaskLink) -> Option<String> {
    link.runtime_handle
        .get(CLOUD_TRANSCRIPT_HANDLE_KEY)
        .and_then(|value| string_field(value, "transcriptId"))
}

fn transcript_matches(link: &RuntimeTaskLink, transcript_id: &str) -> bool {
    cloud_transcript_id(link)
        .map(|current| current == transcript_id)
        .unwrap_or_else(|| link.local_task_id == transcript_id)
}

fn imported_through(link: &RuntimeTaskLink) -> u64 {
    link.runtime_handle
        .get(CLOUD_TRANSCRIPT_HANDLE_KEY)
        .and_then(|value| value.get("importedThrough"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn set_cloud_transcript(link: &mut RuntimeTaskLink, transcript_id: &str, sequence: u64) {
    if !link.runtime_handle.is_object() {
        link.runtime_handle = json!({});
    }
    link.runtime_handle[CLOUD_TRANSCRIPT_HANDLE_KEY] = json!({
        "transcriptId": transcript_id,
        "importedThrough": sequence,
    });
}

fn response_items_from_cloud_turn(turn: &Value) -> Vec<Value> {
    let Some(payload) = turn.get("payload") else {
        return Vec::new();
    };
    let mut items = payload
        .get("userMessages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| string_field(message, "text"))
        .map(|text| {
            json!({
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": text}],
            })
        })
        .collect::<Vec<_>>();
    if let Some(text) = string_field(payload, "assistantMessage") {
        items.push(json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text}],
        }));
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_turns_become_native_responses_api_history() {
        let items = response_items_from_cloud_turn(&json!({
            "sequence": 2,
            "payload": {
                "userMessages": [{"id": "user-2", "text": "Continue on B"}],
                "assistantMessage": "B completed",
                "reasoning": "private reasoning is not portable"
            }
        }));

        assert_eq!(
            items,
            vec![
                json!({
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Continue on B"}],
                }),
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "B completed"}],
                }),
            ]
        );
    }

    #[test]
    fn branch_binding_replaces_mainline_cursor_without_copying_body() {
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/workspace".to_owned(),
            "Task".to_owned(),
        );
        set_cloud_transcript(&mut link, "task-1", 4);
        set_cloud_transcript(&mut link, "fork-1", 2);

        assert_eq!(cloud_transcript_id(&link).as_deref(), Some("fork-1"));
        assert_eq!(imported_through(&link), 2);
        assert!(link.runtime_handle.get("messages").is_none());
    }
}
