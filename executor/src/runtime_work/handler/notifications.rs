// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::command_items::{merge_codex_command_item, merge_codex_turn_items};
use super::*;

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
    pub(super) fn register_scoped_child_route(&self, parent: &str, child: &str) {
        if parent == child {
            return;
        }
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        if routing.routes.contains_key(child) {
            return;
        }
        let Some(parent) = routing.routes.get(parent) else {
            return;
        };
        let local_task_id = parent.local_task_id.clone();
        let request = parent.request.clone();
        let event_mapper = parent.event_mapper.clone();
        let active = parent.active;
        let generation = next_thread_event_route_generation(&mut routing);
        routing.routes.insert(
            child.to_owned(),
            RuntimeThreadEventRoute {
                local_task_id,
                request,
                event_mapper,
                active,
                nested: true,
                generation,
            },
        );
        let replay = begin_pending_codex_notification_replays(&mut routing, &[child.to_owned()]);
        drop(routing);
        self.replay_codex_notifications(replay);
    }

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
        expected_turn_id: Option<&str>,
    ) {
        let mut active_items = self.active_codex_transcript_items.lock().ok();
        let active = active_items.as_mut().and_then(|items| {
            if expected_turn_id.is_some_and(|expected| {
                items
                    .get(local_task_id)
                    .is_some_and(|active| active.turn_id != expected)
            }) {
                return None;
            }
            items.remove(local_task_id)
        });
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
        let mut messages = transcript_messages(
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
                for incoming in &mut messages {
                    if let Some(cached) = link
                        .runtime_handle
                        .get("completedTranscriptMessages")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .find(|cached| cached["id"] == incoming["id"])
                    {
                        merge_completed_transcript_message(incoming, cached.clone());
                    }
                }
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
            return;
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
                turn["status"] = json!("inProgress");
                turn["completedAt"] = Value::Null;
                turn["durationMs"] = Value::Null;
                turn["error"] = Value::Null;
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

    pub(super) async fn ensure_notification_router(&self) {
        if self
            .notification_router
            .lock()
            .expect("notification router lock should not be poisoned")
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return;
        }

        let notification_rx = match self
            .codex_app_server
            .subscribe_runtime_notifications()
            .await
        {
            Ok(receiver) => receiver,
            Err(error) => {
                log_executor_event(
                    "runtime work notification router subscribe failed",
                    &[("error", error)],
                );
                return;
            }
        };

        let mut router = self
            .notification_router
            .lock()
            .expect("notification router lock should not be poisoned");
        if router.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }

        let handler = self.clone();
        *router = Some(tokio::spawn(async move {
            handler.run_notification_router(notification_rx).await;
        }));
    }

    pub(super) async fn run_notification_router(
        &self,
        mut notification_rx: mpsc::Receiver<CodexNotification>,
    ) {
        loop {
            let message = match notification_rx.recv().await {
                Some(message) => message,
                None => {
                    log_executor_event("runtime work notification router closed", &[]);
                    return;
                }
            };

            if message.get("method").and_then(Value::as_str) == Some("codex/app-server/exited") {
                log_executor_event("runtime work notification router app-server exited", &[]);
                self.settle_native_transport_exit();
                return;
            }

            self.route_codex_notification(message);
        }
    }

    pub(super) fn route_codex_notification(&self, message: impl Into<CodexNotification>) {
        self.route_codex_notification_inner(message.into(), None);
    }

    fn route_codex_notification_inner(
        &self,
        message: CodexNotification,
        replaying_route: Option<(&str, u64)>,
    ) {
        let thread_id =
            codex_notification_thread_id(&message).or_else(|| self.unscoped_route_thread_id());
        let Some(thread_id) = thread_id else {
            debug_unrouted_codex_notification(&message, "missing_thread_id");
            return;
        };
        let notification_turn_id = codex_notification_turn_id(&message);

        if !self.thread_event_route_exists(&thread_id) {
            self.register_thread_event_route_from_store(&thread_id);
        }
        if !self.thread_event_route_exists(&thread_id)
            && codex_started_thread_id(&message).as_deref() == Some(thread_id.as_str())
        {
            self.promote_pending_thread_event_route(&thread_id);
        }

        let child_thread_ids = codex_spawned_child_thread_ids(&message);
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        let route_generation = routing.routes.get(&thread_id).map(|route| route.generation);
        let replay_generation = replaying_route
            .filter(|(replaying_thread_id, _)| *replaying_thread_id == thread_id)
            .map(|(_, generation)| generation);
        if replay_generation.is_some() && replay_generation != route_generation {
            debug_unrouted_codex_notification(&message, "replay_route_replaced");
            return;
        }
        let route_replaying = routing
            .replaying_route_generations
            .get(&thread_id)
            .is_some_and(|generation| Some(*generation) != replay_generation);
        let Some(route) = routing
            .routes
            .get_mut(&thread_id)
            .filter(|_| !route_replaying)
        else {
            debug_unrouted_codex_notification(
                &message,
                if route_replaying {
                    "route_replaying"
                } else {
                    "route_pending"
                },
            );
            let dropped = if routing.pending_notifications.len() >= MAX_PENDING_CODEX_NOTIFICATIONS
            {
                routing.pending_notifications.pop_front()
            } else {
                None
            };
            routing
                .pending_notifications
                .push_back(PendingCodexNotification { thread_id, message });
            drop(routing);
            if let Some(dropped) = dropped {
                let notification = codex_notification(&dropped.message);
                log_executor_event(
                    "runtime work pending codex notification dropped",
                    &[
                        ("thread_id", dropped.thread_id),
                        ("method", notification.method),
                    ],
                );
            }
            return;
        };
        let local_task_id = route.local_task_id.clone();
        let route_request = route.request.clone();
        let event_mapper = route.event_mapper.clone();
        let route_active = route.active;
        let route_nested = route.nested;
        if route_nested && codex_stream_debug_enabled() {
            let notification = codex_notification(&message);
            log_executor_event(
                "runtime work routes nested notification",
                &[
                    ("thread_id", thread_id.clone()),
                    ("method", notification.method),
                    (
                        "item_type",
                        item_type(&notification_item(notification.params)),
                    ),
                    (
                        "item_id",
                        notification_item(notification.params)
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("<none>")
                            .to_owned(),
                    ),
                ],
            );
        }
        for child_thread_id in &child_thread_ids {
            if !routing.routes.contains_key(child_thread_id) {
                let generation = next_thread_event_route_generation(&mut routing);
                routing.routes.insert(
                    child_thread_id.clone(),
                    RuntimeThreadEventRoute {
                        local_task_id: local_task_id.clone(),
                        request: route_request.clone(),
                        event_mapper: event_mapper.clone(),
                        active: route_active,
                        nested: true,
                        generation,
                    },
                );
            }
        }
        let pending_replays =
            begin_pending_codex_notification_replays(&mut routing, &child_thread_ids);
        let notification = codex_notification(&message);
        let command_notification = notification.method.starts_with("item/commandExecution/")
            || item_type(&notification_item(notification.params)) == "commandexecution";
        if let Some(started_thread_id) = codex_started_thread_id(&message) {
            self.register_codex_thread_workspace_root(&started_thread_id, &route_request, false);
        }
        drop(routing);

        {
            // Claim, persist, and publish under one lock shared with the execution receiver.
            let _delivery = self
                .codex_notification_delivery
                .lock()
                .unwrap_or_else(|poisoned| {
                    log_executor_event("Codex notification delivery recovered after panic", &[]);
                    poisoned.into_inner()
                });
            if message.claim_runtime_delivery() {
                let mut message = message;
                let stopped = self
                    .active_local_executions
                    .lock()
                    .expect("active local execution map lock should not be poisoned")
                    .get(&local_task_id)
                    .is_some_and(|execution| execution.stop_requested);
                let method = codex_notification(&message).method;
                if stopped
                    && !command_notification
                    && method.starts_with("item/")
                    && method != super::super::mcp_elicitation::SETTLED_METHOD
                    && method != super::super::codex_user_input::APPROVAL_SETTLED_METHOD
                {
                    return;
                }
                if !route_nested && is_root_codex_turn_event(codex_notification(&message).params) {
                    let native = codex_notification(&message);
                    self.apply_native_lifecycle(&local_task_id, &route_request, &message);
                    if native.method == "turn/started" {
                        if let Some(turn_id) = codex_notification_turn_id(&message) {
                            let accepted = self
                                .local_task_link(&local_task_id)
                                .and_then(|link| {
                                    crate::runtime_work::lifecycle::native_execution_state(&link)
                                })
                                .is_some_and(|state| {
                                    state.native_sequence == message.sequence()
                                        && state.turn_id.as_deref() == Some(turn_id.as_str())
                                });
                            if accepted {
                                self.begin_active_codex_transcript(
                                    &local_task_id,
                                    &thread_id,
                                    &turn_id,
                                );
                            }
                        }
                    }
                    if let Some(turn_id) = codex_notification_turn_id(&message) {
                        self.record_active_codex_transcript_item(
                            &local_task_id,
                            &turn_id,
                            &message,
                        );
                    }
                    if !self.normalize_pending_mcp_elicitation(&local_task_id, &mut message) {
                        return;
                    }
                    if super::super::codex_user_input::async_question_payload_from_item(
                        &message["params"],
                    )
                    .is_some()
                    {
                        self.set_interaction_status(
                            &local_task_id,
                            Some(INTERACTION_AWAITING_USER_REPLY),
                        );
                    }
                    if codex_notification_requires_user_input(&message)
                        || message["method"] == super::super::mcp_elicitation::SETTLED_METHOD
                        || message["method"]
                            == super::super::codex_user_input::APPROVAL_SETTLED_METHOD
                    {
                        self.refresh_pending_user_input_status(&local_task_id);
                    }
                }
                if !route_nested {
                    self.record_background_terminal_notification(&local_task_id, &message);
                }
                let compaction_item = super::super::events::is_context_compaction_notification(
                    codex_notification(&message).params,
                );
                let event_request = if route_nested
                    || (is_context_compaction_request(&route_request) && compaction_item)
                {
                    route_request
                } else {
                    self.request_for_codex_event(
                        &local_task_id,
                        &route_request,
                        notification_turn_id.as_deref(),
                    )
                };
                event_mapper
                    .lock()
                    .expect("thread event mapper lock should not be poisoned")
                    .map(
                        &self.event_tx,
                        &self.device_id,
                        &local_task_id,
                        &event_request,
                        message.into_value(),
                    );
            }
        }
        self.replay_codex_notifications(pending_replays);
    }

    pub(super) fn register_thread_event_route(
        &self,
        thread_id: &str,
        local_task_id: String,
        request: ExecutionRequest,
        active: bool,
    ) {
        if thread_id.trim().is_empty() {
            return;
        }
        self.store.update_task(&local_task_id, |link| {
            if link.thread_id.as_deref() != Some(thread_id) {
                link.thread_id = Some(thread_id.to_owned());
            }
            clear_runtime_handle_messages(&mut link.runtime_handle);
        });
        let pending_id = pending_thread_event_route_id(&local_task_id);
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        let existing = routing
            .routes
            .remove(thread_id)
            .or_else(|| routing.routes.remove(&pending_id));
        let mut route = existing.unwrap_or_else(|| {
            let generation = next_thread_event_route_generation(&mut routing);
            RuntimeThreadEventRoute::new(local_task_id.clone(), request.clone(), active, generation)
        });
        if route.local_task_id != local_task_id {
            route.generation = next_thread_event_route_generation(&mut routing);
            routing.replaying_route_generations.remove(thread_id);
            routing
                .pending_notifications
                .retain(|notification| notification.thread_id != thread_id);
        }
        let preserve_active_turn_request = route.active
            && !active
            && !is_context_compaction_request(&route.request)
            && is_context_compaction_request(&request);
        if active {
            route.event_mapper = Arc::new(Mutex::new(CodexNotificationEventMapper::default()));
        }
        route
            .event_mapper
            .lock()
            .expect("thread event mapper lock should not be poisoned")
            .observe_root_thread_id(thread_id);
        route.local_task_id = local_task_id;
        if !preserve_active_turn_request {
            route.request = request;
        }
        route.active = route.active || active;
        route.nested = false;
        routing.routes.insert(thread_id.to_owned(), route);
        let pending_replay =
            begin_pending_codex_notification_replays(&mut routing, &[thread_id.to_owned()]);
        drop(routing);
        self.replay_codex_notifications(pending_replay);
    }

    pub(super) fn repair_legacy_task_activity_time(&self, local_task_id: &str, thread: &Value) {
        if self.is_active_local_task(local_task_id) {
            return;
        }
        let Some(thread_updated_at) = timestamp_ms_field(thread, "updatedAt") else {
            return;
        };
        self.store.update_task(local_task_id, |link| {
            if !link.running && link.completed_at.is_none() && link.updated_at > thread_updated_at {
                link.updated_at = thread_updated_at;
                link.completed_at = Some(thread_updated_at);
            }
        });
    }

    #[cfg(test)]
    pub(super) fn register_pending_thread_event_route(
        &self,
        local_task_id: String,
        request: ExecutionRequest,
    ) {
        let pending_id = pending_thread_event_route_id(&local_task_id);
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        if let Some(route) = routing.routes.get_mut(&pending_id) {
            route.request = request;
            route.active = true;
            return;
        }
        let generation = next_thread_event_route_generation(&mut routing);
        routing.routes.insert(
            pending_id,
            RuntimeThreadEventRoute::new(local_task_id, request, true, generation),
        );
    }

    pub(super) fn record_local_task_thread(&self, local_task_id: &str, thread_id: &str) {
        if thread_id.trim().is_empty() {
            return;
        }
        self.store.update_task(local_task_id, |link| {
            if link.thread_id.as_deref() != Some(thread_id) {
                clear_completed_transcript_messages(&mut link.runtime_handle);
                clear_transcript_snapshot_messages(&mut link.runtime_handle);
            }
            link.thread_id = Some(thread_id.to_owned());
            clear_runtime_handle_messages(&mut link.runtime_handle);
            link.updated_at = now_ms();
        });
    }

    pub(super) fn register_thread_event_route_for_link(
        &self,
        link: &RuntimeTaskLink,
        active: bool,
    ) {
        let Some(thread_id) = runtime_session_id_from_link(link) else {
            return;
        };
        self.register_thread_event_route(
            &thread_id,
            link.local_task_id.clone(),
            runtime_event_request_from_link(link),
            active,
        );
    }

    pub(super) fn register_thread_event_route_from_store(&self, thread_id: &str) {
        if let Some(link) = self.local_task_by_thread_id(thread_id) {
            self.register_thread_event_route_for_link(&link, false);
        }
    }

    pub(super) fn thread_event_route_exists(&self, thread_id: &str) -> bool {
        self.thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned")
            .routes
            .contains_key(thread_id)
    }

    pub(super) fn promote_pending_thread_event_route(&self, thread_id: &str) -> bool {
        if thread_id.trim().is_empty() {
            return false;
        }

        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        if routing.routes.contains_key(thread_id) {
            return true;
        }
        let mut pending_route_ids = routing
            .routes
            .iter()
            .filter(|(route_id, route)| is_pending_thread_event_route_id(route_id) && route.active)
            .map(|(route_id, _)| route_id.clone());
        let Some(pending_route_id) = pending_route_ids.next() else {
            return false;
        };
        if pending_route_ids.next().is_some() {
            return false;
        }
        let Some(mut route) = routing.routes.remove(&pending_route_id) else {
            return false;
        };
        route
            .event_mapper
            .lock()
            .expect("thread event mapper lock should not be poisoned")
            .observe_root_thread_id(thread_id);
        route.nested = false;
        let local_task_id = route.local_task_id.clone();
        routing.routes.insert(thread_id.to_owned(), route);
        let pending_replay =
            begin_pending_codex_notification_replays(&mut routing, &[thread_id.to_owned()]);
        drop(routing);

        self.store.update_task(&local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            clear_runtime_handle_messages(&mut link.runtime_handle);
            link.updated_at = now_ms();
        });
        self.replay_codex_notifications(pending_replay);
        true
    }

    pub(super) fn unscoped_route_thread_id(&self) -> Option<String> {
        let routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        let mut active_routes = routing
            .routes
            .iter()
            .filter(|(_, route)| route.active)
            .map(|(thread_id, _)| thread_id.clone());
        if let Some(thread_id) = active_routes.next() {
            if active_routes.next().is_some() {
                return None;
            }
            return Some(thread_id);
        }

        let mut route_ids = routing.routes.keys().cloned();
        let thread_id = route_ids.next()?;
        if route_ids.next().is_some() {
            None
        } else {
            Some(thread_id)
        }
    }

    pub(super) fn mark_thread_event_route_idle(&self, thread_id: &str) {
        if let Some(route) = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned")
            .routes
            .get_mut(thread_id)
        {
            route.active = false;
        }
    }

    pub(super) fn remove_thread_event_route(&self, thread_id: &str) {
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        routing.routes.remove(thread_id);
        routing.replaying_route_generations.remove(thread_id);
        routing
            .pending_notifications
            .retain(|notification| notification.thread_id != thread_id);
    }

    pub(super) fn mark_thread_event_routes_idle_for_local_task(&self, local_task_id: &str) {
        for route in self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned")
            .routes
            .values_mut()
        {
            if route.local_task_id == local_task_id {
                route.active = false;
            }
        }
    }

    pub(super) fn replay_codex_notifications(
        &self,
        pending_replay: Option<PendingCodexNotificationReplay>,
    ) {
        let Some(PendingCodexNotificationReplay {
            route_generations,
            mut notifications,
        }) = pending_replay
        else {
            return;
        };
        loop {
            for notification in notifications {
                let Some(generation) = route_generations.get(&notification.thread_id) else {
                    continue;
                };
                self.route_codex_notification_inner(
                    notification.message,
                    Some((&notification.thread_id, *generation)),
                );
            }

            let mut routing = self
                .thread_event_routing
                .lock()
                .expect("thread event routing lock should not be poisoned");
            let active_thread_ids = route_generations
                .iter()
                .filter(|(thread_id, generation)| {
                    routing
                        .routes
                        .get(*thread_id)
                        .is_some_and(|route| route.generation == **generation)
                        && routing
                            .replaying_route_generations
                            .get(*thread_id)
                            .is_some_and(|replaying| replaying == *generation)
                })
                .map(|(thread_id, _)| thread_id.clone())
                .collect::<Vec<_>>();
            notifications = take_pending_codex_notifications(&mut routing, &active_thread_ids);
            if notifications.is_empty() {
                for (thread_id, generation) in &route_generations {
                    if routing
                        .replaying_route_generations
                        .get(thread_id)
                        .is_some_and(|replaying| replaying == generation)
                    {
                        routing.replaying_route_generations.remove(thread_id);
                    }
                }
                return;
            }
        }
    }
}

fn begin_pending_codex_notification_replays(
    routing: &mut RuntimeThreadEventRouting,
    thread_ids: &[String],
) -> Option<PendingCodexNotificationReplay> {
    let route_generations = thread_ids
        .iter()
        .filter_map(|thread_id| {
            let generation = routing.routes.get(thread_id)?.generation;
            if routing.replaying_route_generations.contains_key(thread_id) {
                return None;
            }
            routing
                .replaying_route_generations
                .insert(thread_id.clone(), generation);
            Some((thread_id.clone(), generation))
        })
        .collect::<HashMap<_, _>>();
    if route_generations.is_empty() {
        return None;
    }
    let thread_ids = route_generations.keys().cloned().collect::<Vec<_>>();
    let notifications = take_pending_codex_notifications(routing, &thread_ids);
    Some(PendingCodexNotificationReplay {
        route_generations,
        notifications,
    })
}

fn next_thread_event_route_generation(routing: &mut RuntimeThreadEventRouting) -> u64 {
    routing.next_route_generation = routing.next_route_generation.wrapping_add(1).max(1);
    routing.next_route_generation
}

fn take_pending_codex_notifications(
    routing: &mut RuntimeThreadEventRouting,
    thread_ids: &[String],
) -> Vec<PendingCodexNotification> {
    if thread_ids.is_empty() || routing.pending_notifications.is_empty() {
        return Vec::new();
    }
    let thread_ids = thread_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut pending = Vec::new();
    let mut remaining = VecDeque::new();
    while let Some(notification) = routing.pending_notifications.pop_front() {
        if thread_ids.contains(notification.thread_id.as_str()) {
            pending.push(notification);
        } else {
            remaining.push_back(notification);
        }
    }
    routing.pending_notifications = remaining;
    pending
}

fn codex_spawned_child_thread_ids(message: &Value) -> Vec<String> {
    let params = message.get("params").unwrap_or(message);
    let item = params.get("item").unwrap_or(params);
    if item_type(item) == "subagentactivity" {
        return string_field(item, "agentThreadId")
            .or_else(|| string_field(item, "agent_thread_id"))
            .filter(|thread_id| !thread_id.trim().is_empty())
            .into_iter()
            .collect();
    }
    if item_type(item) != "collabagenttoolcall"
        || string_field(item, "tool").as_deref() != Some("spawnAgent")
    {
        return Vec::new();
    }

    let mut thread_ids = Vec::new();
    if let Some(receiver_ids) = item.get("receiverThreadIds").and_then(Value::as_array) {
        for thread_id in receiver_ids.iter().filter_map(Value::as_str) {
            if !thread_id.trim().is_empty() && !thread_ids.iter().any(|value| value == thread_id) {
                thread_ids.push(thread_id.to_owned());
            }
        }
    }
    if let Some(agent_states) = item.get("agentsStates").and_then(Value::as_object) {
        for thread_id in agent_states.keys() {
            if !thread_id.trim().is_empty() && !thread_ids.iter().any(|value| value == thread_id) {
                thread_ids.push(thread_id.to_owned());
            }
        }
    }
    thread_ids
}
