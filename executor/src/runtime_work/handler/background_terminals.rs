// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::command_items::preserve_newer_command_output;
use super::*;
use crate::runtime_work::events::push_limited_tool_output;
use crate::runtime_work::transcript::tool_update_from_notification;

impl RuntimeWorkRpcHandler {
    pub(super) fn background_terminal_count(&self) -> usize {
        self.store
            .list_task_summaries(true)
            .into_iter()
            .filter(|link| link.runtime == "codex")
            .filter_map(|link| self.local_task_link(&link.local_task_id))
            .flat_map(|link| completed_transcript_messages(&link))
            .flat_map(|message| {
                message
                    .get("blocks")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            })
            .filter(|block| {
                block
                    .pointer("/render_payload/kind")
                    .and_then(Value::as_str)
                    == Some("command_execution")
                    && block
                        .pointer("/render_payload/status")
                        .and_then(Value::as_str)
                        == Some("inProgress")
                    && !matches!(
                        block.get("status").and_then(Value::as_str),
                        Some("done" | "error")
                    )
            })
            .count()
    }

    pub(super) fn record_background_terminal_notification(&self, task_id: &str, message: &Value) {
        let notification = codex_notification(message);
        // Keep streaming and persisted transcripts in one atomic handoff.
        let mut active_items = self.active_codex_transcript_items.lock().ok();
        let update = match notification.method.as_str() {
            "item/commandExecution/outputDelta" => {
                let Some(item_id) = string_field(notification.params, "itemId") else {
                    return;
                };
                let Some(delta) = raw_string_field(notification.params, "delta") else {
                    return;
                };
                if let Some(active) = active_items.as_mut() {
                    if let Some(item) = active
                        .get_mut(task_id)
                        .into_iter()
                        .flat_map(|turn| &mut turn.items)
                        .find(|item| string_field(item, "id").as_deref() == Some(&item_id))
                    {
                        append_command_output(item, "aggregatedOutput", &delta);
                    }
                }
                (item_id, json!({"tool_output_delta": delta}))
            }
            "item/completed"
                if item_type(&notification_item(notification.params)) == "commandexecution" =>
            {
                let Some(update) = tool_update_from_notification(notification.params) else {
                    return;
                };
                update
            }
            _ => return,
        };
        self.store.update_task(task_id, |link| {
            update_completed_command(&mut link.runtime_handle, &update.0, &update.1);
        });
        drop(active_items);
    }

    pub(super) async fn clean_background_terminals(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        if link.runtime != "codex" {
            return Err(AppIpcError::new(
                "unsupported_runtime",
                "Background terminals require Codex",
            ));
        }
        let thread_id = codex_thread_id_from_link(&link)
            .ok_or_else(|| AppIpcError::new("missing_session", "The task has no Codex thread"))?;
        self.call_codex_thread_method(
            "thread/backgroundTerminals/clean",
            json!({"threadId": thread_id}),
        )
        .await
        .map_err(|error| AppIpcError::new("background_terminals_clean_failed", error))?;
        Ok(task_action_success(&link))
    }
}

fn append_command_output(value: &mut Value, field: &str, delta: &str) {
    let mut output = raw_string_field(value, field).unwrap_or_default();
    push_limited_tool_output(&mut output, delta);
    value[field] = Value::String(output);
}

fn update_completed_command(handle: &mut Value, id: &str, updates: &Value) {
    let Some(messages) = handle
        .get_mut("completedTranscriptMessages")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for message in messages {
        visit_transcript_blocks_mut(message, |block| {
            if block["id"] != id
                || block
                    .pointer("/render_payload/kind")
                    .and_then(Value::as_str)
                    != Some("command_execution")
            {
                return;
            }
            if let Some(delta) = updates.get("tool_output_delta").and_then(Value::as_str) {
                append_command_output(block, "tool_output", delta);
            } else {
                let mut updates = updates.clone();
                preserve_newer_command_output(block, &mut updates, "tool_output");
                if let (Some(block), Some(updates)) = (block.as_object_mut(), updates.as_object()) {
                    block.extend(updates.clone());
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_message(mut message: Value) -> Value {
        message["runtimeItems"] =
            json!([{ "id": "command-1", "type": "block", "block": message["blocks"][0].clone() }]);
        message
    }

    #[test]
    fn background_terminal_snapshot_preserves_live_output_after_reload() {
        let mut link =
            RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
        link.thread_id = Some("thread-1".into());
        append_completed_transcript_messages(
            &mut link.runtime_handle,
            "thread-1",
            vec![command_message(json!({
                "id": "assistant-1", "role": "assistant", "status": "done", "content": "Started",
                "blocks": [{"id": "command-1", "status": "pending", "tool_output": "ready\n", "render_payload": {"kind": "command_execution", "status": "inProgress"}}],
            }))],
        );
        update_completed_command(
            &mut link.runtime_handle,
            "command-1",
            &json!({"tool_output_delta": "tick\n"}),
        );
        let mut messages = vec![command_message(json!({
            "id": "assistant-1", "role": "assistant", "status": "done", "content": "Started",
            "blocks": [{"id": "command-1", "status": "pending", "tool_output": "ready\n", "render_payload": {"kind": "command_execution", "status": "inProgress"}}],
        }))];
        merge_latest_completed_transcript_messages(&mut messages, &link, None, None);
        assert_eq!(messages[0]["blocks"][0]["tool_output"], "ready\ntick\n");
        assert_eq!(
            messages[0]["runtimeItems"][0]["block"]["tool_output"],
            "ready\ntick\n"
        );
        assert_eq!(
            messages[0]["blocks"][0]["render_payload"]["status"],
            "inProgress"
        );
    }

    #[test]
    fn background_terminal_snapshot_retains_buffer_when_native_exit_omits_output() {
        let mut link =
            RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
        link.thread_id = Some("thread-1".into());
        append_completed_transcript_messages(
            &mut link.runtime_handle,
            "thread-1",
            vec![command_message(json!({
                "id": "assistant-1", "role": "assistant", "status": "done", "content": "Started",
                "blocks": [{"id": "command-1", "status": "pending", "tool_output": "ready\n", "render_payload": {"kind": "command_execution", "status": "inProgress"}}],
            }))],
        );
        let mut messages = vec![command_message(json!({
            "id": "assistant-1", "role": "assistant", "status": "done", "content": "Started",
            "blocks": [{"id": "command-1", "status": "done", "render_payload": {"kind": "command_execution", "status": "completed", "exitCode": 0}}],
        }))];
        merge_latest_completed_transcript_messages(&mut messages, &link, None, None);
        assert_eq!(messages[0]["blocks"][0]["tool_output"], "ready\n");
        assert_eq!(messages[0]["blocks"][0]["status"], "done");
        assert_eq!(
            messages[0]["runtimeItems"][0]["block"]["tool_output"],
            "ready\n"
        );
        assert_eq!(messages[0]["runtimeItems"][0]["block"]["status"], "done");
    }

    #[test]
    fn background_terminal_snapshot_does_not_overwrite_native_exit() {
        let mut link =
            RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
        link.thread_id = Some("thread-1".into());
        append_completed_transcript_messages(
            &mut link.runtime_handle,
            "thread-1",
            vec![command_message(json!({
                "id": "assistant-1", "role": "assistant", "status": "done", "content": "Started",
                "blocks": [{"id": "command-1", "status": "pending", "render_payload": {"kind": "command_execution", "status": "inProgress"}}],
            }))],
        );
        let mut messages = vec![command_message(json!({
            "id": "assistant-1", "role": "assistant", "status": "done", "content": "Started",
            "blocks": [{"id": "command-1", "status": "done", "tool_output": "finished", "render_payload": {"kind": "command_execution", "status": "completed", "exitCode": 0}}],
        }))];
        merge_latest_completed_transcript_messages(&mut messages, &link, None, None);
        assert_eq!(messages[0]["blocks"][0]["status"], "done");
        assert_eq!(messages[0]["blocks"][0]["tool_output"], "finished");
        assert_eq!(messages[0]["blocks"][0]["render_payload"]["exitCode"], 0);
        assert_eq!(
            messages[0]["runtimeItems"][0]["block"]["render_payload"]["exitCode"],
            0
        );
    }
}
