// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
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
        let active = self
            .active_codex_transcript_items
            .lock()
            .ok()
            .and_then(|mut items| items.remove(local_task_id));
        let Some(active) = active.filter(|active| !active.items.is_empty()) else {
            return;
        };
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
        let Some(turn) = notification
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
        if let Ok(mut active_items) = self.active_codex_transcript_items.lock() {
            if let Some(active) = active_items.get_mut(local_task_id) {
                if active.turn_id == turn_id {
                    active.items.clear();
                }
            }
        }
    }

    pub(super) fn record_active_codex_transcript_item(
        &self,
        local_task_id: &str,
        turn_id: &str,
        message: &Value,
    ) {
        let notification = codex_notification(message);
        if notification.method == "item/plan/delta" {
            self.record_active_codex_plan_delta(local_task_id, turn_id, notification.params);
            return;
        }
        if !matches!(
            notification.method.as_str(),
            "item/started" | "item/completed"
        ) {
            return;
        }
        let item = notification_item(notification.params);
        if !item.is_object() {
            return;
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
            *existing = item;
            if existing.get("createdAt").is_none() && existing.get("created_at").is_none() {
                if let (Some(object), Some(created_at)) = (existing.as_object_mut(), created_at) {
                    object.insert("createdAt".to_owned(), created_at);
                }
            }
        } else {
            transcript.items.push(item);
        }
    }

    fn record_active_codex_plan_delta(&self, local_task_id: &str, turn_id: &str, params: &Value) {
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
            transcript.turn_id = turn_id.to_owned();
            transcript.items.clear();
        }
        if let Some(existing) = transcript
            .items
            .iter_mut()
            .find(|existing| string_field(existing, "id").as_deref() == Some(item_id.as_str()))
        {
            if string_field(existing, "type").as_deref() != Some("plan") {
                return;
            }
            let text = raw_string_field(existing, "text").unwrap_or_default();
            if let Some(object) = existing.as_object_mut() {
                object.insert("text".to_owned(), Value::String(format!("{text}{delta}")));
                object.insert("status".to_owned(), Value::String("inProgress".to_owned()));
            }
            return;
        }
        transcript.items.push(json!({
            "id": item_id,
            "type": "plan",
            "text": delta,
            "status": "inProgress",
            "createdAt": now_ms(),
        }));
    }

    pub(super) fn merge_active_codex_transcript(&self, local_task_id: &str, thread: &mut Value) {
        let active = self
            .active_codex_transcript_items
            .lock()
            .ok()
            .and_then(|items| items.get(local_task_id).cloned());
        let Some(active) = active.filter(|active| !active.items.is_empty()) else {
            return;
        };
        let Some(turns) = thread.get_mut("turns").and_then(Value::as_array_mut) else {
            return;
        };
        if let Some(turn) = turns
            .iter_mut()
            .find(|turn| string_field(turn, "id").as_deref() == Some(active.turn_id.as_str()))
        {
            merge_codex_turn_items(turn, active.items);
            return;
        }
        turns.push(json!({
            "id": active.turn_id,
            "items": active.items,
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

        let notification_rx = match self.codex_app_server.subscribe_notifications().await {
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
        mut notification_rx: broadcast::Receiver<Value>,
    ) {
        loop {
            let message = match notification_rx.recv().await {
                Ok(message) => message,
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    log_executor_event(
                        "runtime work notification router lagged",
                        &[("count", count.to_string())],
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    log_executor_event("runtime work notification router closed", &[]);
                    return;
                }
            };

            if message.get("method").and_then(Value::as_str) == Some("codex/app-server/exited") {
                log_executor_event("runtime work notification router app-server exited", &[]);
                return;
            }

            self.route_codex_notification(message);
        }
    }

    pub(super) fn route_codex_notification(&self, message: Value) {
        self.route_codex_notification_inner(message, None);
    }

    fn route_codex_notification_inner(&self, message: Value, replaying_route: Option<(&str, u64)>) {
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
        let Some(route) = routing.routes.get(&thread_id).filter(|_| !route_replaying) else {
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
        let skip_active_notification = if self.is_active_local_task(&local_task_id) {
            let Some(active_turn) = self.active_codex_turn(&local_task_id) else {
                drop(routing);
                self.replay_codex_notifications(pending_replays);
                return;
            };
            let Some(notification_turn_id) = notification_turn_id.as_deref() else {
                drop(routing);
                self.replay_codex_notifications(pending_replays);
                return;
            };
            if notification_turn_id == active_turn.turn_id {
                true
            } else {
                log_executor_event(
                    "runtime work routes non-active turn notification",
                    &[
                        ("thread_id", thread_id.clone()),
                        ("active_turn_id", active_turn.turn_id),
                        ("notification_turn_id", notification_turn_id.to_owned()),
                    ],
                );
                false
            }
        } else {
            false
        };
        if let Some(started_thread_id) = codex_started_thread_id(&message) {
            self.register_codex_thread_workspace_root(&started_thread_id, &route_request, false);
        }
        drop(routing);

        if !skip_active_notification {
            let mut event_request = route_request;
            if !route_nested && !is_context_compaction_request(&event_request) {
                if let Some(turn_id) = notification_turn_id {
                    if event_request.subtask_id != turn_id {
                        event_request.subtask_id = turn_id;
                        event_request.extra.remove("client_user_message_id");
                        event_request.extra.remove("clientUserMessageId");
                    }
                }
            }
            event_mapper
                .lock()
                .expect("thread event mapper lock should not be poisoned")
                .map(
                    &self.event_tx,
                    &self.device_id,
                    &local_task_id,
                    &event_request,
                    message,
                );
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

fn merge_codex_turn_items(turn: &mut Value, active_items: Vec<Value>) {
    let Some(turn_object) = turn.as_object_mut() else {
        return;
    };
    let items = turn_object
        .entry("items".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !items.is_array() {
        *items = Value::Array(Vec::new());
    }
    let items = items
        .as_array_mut()
        .expect("turn items were normalized to an array");
    for active_item in active_items {
        let Some(item_id) = string_field(&active_item, "id") else {
            continue;
        };
        if let Some(existing) = items
            .iter_mut()
            .find(|existing| string_field(existing, "id").as_deref() == Some(item_id.as_str()))
        {
            *existing = active_item;
        } else {
            items.push(active_item);
        }
    }
    turn_object.insert("itemsView".to_owned(), Value::String("full".to_owned()));
    turn_object.insert("status".to_owned(), Value::String("inProgress".to_owned()));
}
