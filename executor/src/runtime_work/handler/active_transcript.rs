// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

impl ActiveCodexTranscriptItems {
    fn has_pending_mcp_elicitation(&self) -> bool {
        self.items.iter().any(|item| {
            item["type"] == "mcpElicitation"
                && item["renderPayload"]["interactionStatus"] == "pending"
        })
    }

    fn has_pending_user_input(&self) -> bool {
        self.user_input_requests.values().any(|pending| *pending)
            || self.has_pending_mcp_elicitation()
    }
}

fn user_input_request_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(id) => Some(id.to_string()),
        Value::String(id) if !id.trim().is_empty() => Some(id.clone()),
        _ => None,
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn refresh_pending_user_input_status(&self, local_task_id: &str) {
        let Ok(items) = self.active_codex_transcript_items.lock() else {
            return;
        };
        if let Some(active) = items.get(local_task_id) {
            self.set_pending_user_input_status(local_task_id, active);
        }
    }

    // Called with the transcript lock held: a concurrent response must not clear a new request.
    fn set_pending_user_input_status(
        &self,
        local_task_id: &str,
        active: &ActiveCodexTranscriptItems,
    ) {
        if active.has_pending_user_input() {
            self.set_interaction_status(local_task_id, Some(INTERACTION_WAITING_FOR_USER_INPUT));
        } else if self.local_task_link(local_task_id).is_some_and(|link| {
            link.interaction_status.as_deref() == Some(INTERACTION_WAITING_FOR_USER_INPUT)
        }) {
            self.set_interaction_status(local_task_id, None);
        }
    }

    pub(super) fn request_user_input_response_key(
        &self,
        local_task_id: &str,
        turn_id: &str,
        response: &Value,
    ) -> Option<String> {
        if let Some(id) = super::super::mcp_elicitation::response_id(response) {
            return user_input_request_key(id);
        }
        let items = self.active_codex_transcript_items.lock().ok()?;
        let active = items
            .get(local_task_id)
            .filter(|active| active.turn_id == turn_id)?;
        if active.has_pending_mcp_elicitation() {
            return None;
        }
        let mut pending = active
            .user_input_requests
            .iter()
            .filter(|(_, pending)| **pending);
        let (id, _) = pending.next()?;
        pending.next().is_none().then(|| id.clone())
    }

    pub(super) fn settle_request_user_input_response(
        &self,
        local_task_id: &str,
        turn_id: &str,
        request_id: Option<&str>,
        response: &Value,
    ) {
        let Ok(mut items) = self.active_codex_transcript_items.lock() else {
            return;
        };
        let Some(active) = items
            .get_mut(local_task_id)
            .filter(|active| active.turn_id == turn_id)
        else {
            return;
        };
        let newly_answered = request_id
            .and_then(|id| active.user_input_requests.get_mut(id))
            .is_some_and(|pending| std::mem::replace(pending, false));
        if let Some(item) = active.items.iter_mut().find(|item| {
            newly_answered
                && item["type"] == "userInputRequest"
                && user_input_request_key(&item["renderPayload"]["requestId"]).as_deref()
                    == request_id
        }) {
            item["renderPayload"]["response"] = response.clone();
            item["renderPayload"]["interactionStatus"] = json!("answered");
            item["renderPayload"]["settledAtUnixMs"] = json!(now_ms());
        }
        // MCP requests stay pending until their own answered/cancelled/expired notification.
        self.set_pending_user_input_status(local_task_id, active);
    }

    /// Replayed requests cannot reopen a settled card or extend its original deadline.
    pub(super) fn normalize_pending_mcp_elicitation(
        &self,
        local_task_id: &str,
        message: &mut Value,
    ) -> bool {
        if message["method"] == super::super::codex_user_input::APPROVAL_SETTLED_METHOD
            || message["method"] == super::super::mcp_elicitation::SETTLED_METHOD
        {
            return true;
        }
        let Some(item) = super::super::mcp_elicitation::item(message)
            .or_else(|| super::super::codex_user_input::request_item(message))
        else {
            return true;
        };
        let cached = self
            .active_codex_transcript_items
            .lock()
            .ok()
            .and_then(|items| {
                items.get(local_task_id).and_then(|active| {
                    active
                        .items
                        .iter()
                        .find(|existing| existing["id"] == item["id"])
                        .cloned()
                })
            });
        let Some(cached) = cached else {
            return true;
        };
        if cached["renderPayload"]["interactionStatus"] != "pending" {
            return false;
        }
        if let Some(deadline) = cached["renderPayload"].get("expiresAtUnixMs") {
            message["params"]["expiresAtUnixMs"] = deadline.clone();
        }
        true
    }

    pub(super) fn begin_active_codex_transcript(
        &self,
        local_task_id: &str,
        thread_id: &str,
        turn_id: &str,
    ) {
        let Ok(mut active_items) = self.active_codex_transcript_items.lock() else {
            return;
        };
        active_items.insert(
            local_task_id.to_owned(),
            ActiveCodexTranscriptItems {
                thread_id: thread_id.to_owned(),
                turn_id: turn_id.to_owned(),
                items: Vec::new(),
                user_input_requests: HashMap::new(),
            },
        );
    }

    #[cfg(test)]
    pub(super) fn clear_active_codex_transcript(&self, local_task_id: &str) {
        if let Ok(mut active_items) = self.active_codex_transcript_items.lock() {
            active_items.remove(local_task_id);
        }
    }

    pub(super) fn persist_and_clear_active_codex_transcript(
        &self,
        local_task_id: &str,
        status: &str,
    ) {
        let mut active_items = self.active_codex_transcript_items.lock().ok();
        let active = active_items
            .as_mut()
            .and_then(|items| items.remove(local_task_id));
        let Some(mut active) = active.filter(|active| !active.items.is_empty()) else {
            return;
        };
        for item in &mut active.items {
            super::super::mcp_elicitation::settle_pending(item);
        }
        let completed_at = now_ms();
        let workspace_path = self
            .local_task_link(local_task_id)
            .map(|link| link.workspace_path)
            .unwrap_or_default();
        let thread = json!({
            "cwd": workspace_path,
            "turns": [{
                "id": active.turn_id,
                "items": active.items,
                "itemsView": "full",
                "status": status,
                "completedAt": completed_at,
            }],
        });
        let messages = transcript_messages(&thread, &self.device_id)
            .into_iter()
            .filter(|message| {
                string_field(message, "role")
                    .is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
            })
            .collect::<Vec<_>>();
        if messages.is_empty() {
            return;
        }
        self.store.update_task(local_task_id, |link| {
            append_completed_transcript_messages(
                &mut link.runtime_handle,
                &active.thread_id,
                messages,
            );
            link.updated_at = link.updated_at.max(completed_at);
        });
        drop(active_items);
    }

    pub(super) fn persist_completed_codex_turn_from_notification(
        &self,
        local_task_id: &str,
        message: &Value,
    ) {
        let notification = codex_notification(message);
        if notification.method != "turn/completed" {
            return;
        }
        let Some(mut turn) = notification
            .params
            .get("turn")
            .filter(|turn| turn.is_object())
            .cloned()
        else {
            return;
        };
        let Some(turn_id) = string_field(&turn, "id") else {
            return;
        };
        // Completion notifications can omit items already delivered through the stream.
        let mut active_items = self.active_codex_transcript_items.lock().ok();
        let active = active_items.as_ref().and_then(|items| {
            items
                .get(local_task_id)
                .filter(|active| active.turn_id == turn_id)
                .cloned()
        });
        if let Some(active) = active.filter(|active| !active.items.is_empty()) {
            let completed_items = turn
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            turn["items"] = Value::Array(active.items);
            merge_codex_turn_items(&mut turn, completed_items);
        }
        let thread_id = string_field(notification.params, "threadId")
            .or_else(|| {
                self.local_task_link(local_task_id)
                    .and_then(|link| link.thread_id)
            })
            .unwrap_or_default();
        let workspace_path = self
            .local_task_link(local_task_id)
            .map(|link| link.workspace_path)
            .unwrap_or_default();
        let completed_at = timestamp_ms_field(&turn, "completedAt").unwrap_or_else(now_ms);
        let messages = transcript_messages(
            &json!({"cwd": workspace_path, "turns": [turn]}),
            &self.device_id,
        )
        .into_iter()
        .filter(|message| {
            string_field(message, "role").is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
        })
        .collect::<Vec<_>>();
        if !messages.is_empty() {
            self.store.update_task(local_task_id, |link| {
                append_completed_transcript_messages(
                    &mut link.runtime_handle,
                    &thread_id,
                    messages,
                );
                link.updated_at = link.updated_at.max(completed_at);
            });
        }
        if let Some(active_items) = active_items.as_mut() {
            if let Some(active) = active_items.get_mut(local_task_id) {
                if active.turn_id == turn_id {
                    active.items.clear();
                    active.user_input_requests.clear();
                }
            }
        }
        drop(active_items);
    }

    pub(super) fn record_active_codex_transcript_item(
        &self,
        local_task_id: &str,
        turn_id: &str,
        message: &Value,
    ) {
        let notification = codex_notification(message);
        if notification.method == super::super::codex_user_input::APPROVAL_SETTLED_METHOD {
            if let (Some(key), Ok(mut items)) = (
                message.get("id").and_then(user_input_request_key),
                self.active_codex_transcript_items.lock(),
            ) {
                if let Some(active) = items
                    .get_mut(local_task_id)
                    .filter(|active| active.turn_id == turn_id)
                {
                    active.user_input_requests.insert(key, false);
                }
            }
        }
        if notification.method != "mcpServer/elicitation/request"
            && codex_notification_requires_user_input(message)
        {
            let Some(request_id) = message.get("id").and_then(user_input_request_key) else {
                return;
            };
            let Ok(mut items) = self.active_codex_transcript_items.lock() else {
                return;
            };
            if let Some(active) = items
                .get_mut(local_task_id)
                .filter(|active| active.turn_id == turn_id)
            {
                active.user_input_requests.entry(request_id).or_insert(true);
            }
            if super::super::codex_user_input::request_item(message).is_none() {
                return;
            }
        }
        let text_item_type = match notification.method.as_str() {
            "item/plan/delta" => Some("plan"),
            "item/agentMessage/delta" => Some("agentMessage"),
            _ => None,
        };
        if let Some(text_item_type) = text_item_type {
            self.record_active_codex_text_delta(
                local_task_id,
                turn_id,
                notification.params,
                text_item_type,
            );
            return;
        }
        let interaction = super::super::mcp_elicitation::item(message)
            .or_else(|| super::super::codex_user_input::request_item(message));
        if interaction.is_some()
            && notification.params.get("turnId").and_then(Value::as_str) != Some(turn_id)
        {
            return;
        }
        if interaction.is_none()
            && !matches!(
                notification.method.as_str(),
                "item/started" | "item/completed"
            )
        {
            return;
        }
        let mut item = interaction.unwrap_or_else(|| notification_item(notification.params));
        if !item.is_object() {
            return;
        }
        item["lifecycleCompleted"] = json!(notification.method == "item/completed");
        if is_codex_context_compaction_item_type(&item_type(&item)) {
            item["status"] = json!(if notification.method == "item/completed" {
                "done"
            } else {
                "pending"
            });
        }
        let Some(item_id) = string_field(&item, "id") else {
            return;
        };
        let Ok(mut active_items) = self.active_codex_transcript_items.lock() else {
            return;
        };
        let Some(transcript) = active_items.get_mut(local_task_id) else {
            return;
        };
        if transcript.turn_id != turn_id {
            transcript.turn_id = turn_id.to_owned();
            transcript.items.clear();
            transcript.user_input_requests.clear();
        }
        if let Some(existing) = transcript
            .items
            .iter_mut()
            .find(|existing| string_field(existing, "id").as_deref() == Some(item_id.as_str()))
        {
            let created_at = existing
                .get("createdAt")
                .or_else(|| existing.get("created_at"))
                .cloned();
            *existing = if matches!(
                existing["type"].as_str(),
                Some("mcpElicitation" | "userInputRequest")
            ) {
                super::super::mcp_elicitation::merge(existing, item)
            } else {
                merge_codex_command_item(existing, item)
            };
            if existing.get("createdAt").is_none() && existing.get("created_at").is_none() {
                if let (Some(object), Some(created_at)) = (existing.as_object_mut(), created_at) {
                    object.insert("createdAt".to_owned(), created_at);
                }
            }
        } else {
            transcript.items.push(item);
        }
        let progress = (notification.method == "item/completed").then(|| {
            transcript
                .items
                .iter()
                .filter_map(|item| {
                    (string_field(item, "type").as_deref() == Some("agentMessage"))
                        .then(|| string_field(item, "text"))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        });
        drop(active_items);
        if let Some(progress) = progress.filter(|text| !text.is_empty()) {
            self.project_queue_progress(local_task_id, &progress);
        }
    }

    pub(super) fn reconcile_admitted_codex_turn(&self, local_task_id: &str, thread: &mut Value) {
        if thread["timeline"] != true {
            return;
        }
        let known_turn = {
            let active = self
                .active_local_executions
                .lock()
                .expect("active local execution map lock should not be poisoned");
            let Some(execution) = active
                .get(local_task_id)
                .filter(|execution| !execution.stop_requested)
            else {
                return;
            };
            execution
                .codex_turn
                .as_ref()
                .map(|turn| turn.turn_id.clone())
        };
        let previous_turn = self
            .local_task_link(local_task_id)
            .and_then(|link| string_field(&link.runtime_handle, "lastTurnId"));
        let Some(turns) = thread.get_mut("turns").and_then(Value::as_array_mut) else {
            return;
        };
        let turn = if let Some(id) = known_turn {
            turns.iter_mut().find(|turn| turn["id"] == id)
        } else {
            turns
                .last_mut()
                .filter(|turn| string_field(turn, "id").is_some_and(|id| Some(id) != previous_turn))
        };
        if let Some(turn) =
            turn.filter(|turn| turn["status"] == "interrupted" && turn["timelineCompleted"] != true)
        {
            // Native admission can precede the notification that binds the live buffer.
            // Only an unstopped local execution can own this open, newly observed turn.
            mark_codex_turn_running(turn);
        }
    }

    pub(super) fn merge_active_codex_transcript(&self, local_task_id: &str, thread: &mut Value) {
        let active = self
            .active_codex_transcript_items
            .lock()
            .ok()
            .and_then(|items| items.get(local_task_id).cloned());
        let Some(active) = active else {
            return;
        };
        let positioned = thread["timeline"] == true;
        let active_items = active
            .items
            .into_iter()
            .filter(|item| !positioned || item["lifecycleCompleted"] != true)
            .collect::<Vec<_>>();
        let Some(turns) = thread.get_mut("turns").and_then(Value::as_array_mut) else {
            return;
        };
        if let Some(turn) = turns
            .iter_mut()
            .find(|turn| string_field(turn, "id").as_deref() == Some(active.turn_id.as_str()))
        {
            // Turn-list status can synthesize interruption without a terminal boundary.
            // Execution identity remains authoritative for this open turn even when
            // every observed item has already been persisted.
            if !positioned || turn["timelineCompleted"] != true {
                mark_codex_turn_running(turn);
            }
            let active_items = active_items
                .into_iter()
                .filter(|item| {
                    if !positioned {
                        return true;
                    }
                    let existing = turn["items"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|native| native["id"] == item["id"]);
                    existing.map_or(true, |native| {
                        item_type(native) == "commandexecution"
                            && !matches!(native["status"].as_str(), Some("completed" | "failed"))
                    })
                })
                .collect();
            merge_codex_turn_items(turn, active_items);
            return;
        }
        if active_items.is_empty() {
            return;
        }
        turns.push(json!({
            "id": active.turn_id,
            "items": active_items,
            "itemsView": "full",
            "status": "inProgress",
        }));
    }

    pub(super) fn active_codex_transcript_messages(&self, local_task_id: &str) -> Vec<Value> {
        let workspace_path = self
            .local_task_link(local_task_id)
            .map(|link| link.workspace_path)
            .unwrap_or_default();
        let mut thread = json!({"cwd": workspace_path, "turns": []});
        self.merge_active_codex_transcript(local_task_id, &mut thread);
        transcript_messages(&thread, &self.device_id)
    }
}

fn mark_codex_turn_running(turn: &mut Value) {
    turn["status"] = json!("inProgress");
    turn["completedAt"] = Value::Null;
    turn["durationMs"] = Value::Null;
    turn["error"] = Value::Null;
}
