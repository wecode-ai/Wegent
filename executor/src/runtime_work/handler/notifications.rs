// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
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
        let thread_id =
            codex_notification_thread_id(&message).or_else(|| self.unscoped_route_thread_id());
        let Some(thread_id) = thread_id else {
            debug_unrouted_codex_notification(&message, "missing_thread_id");
            return;
        };

        if !self.thread_event_route_exists(&thread_id) {
            self.register_thread_event_route_from_store(&thread_id);
        }
        if !self.thread_event_route_exists(&thread_id)
            && codex_started_thread_id(&message).as_deref() == Some(thread_id.as_str())
        {
            self.promote_pending_thread_event_route(&thread_id);
        }

        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let Some(route) = routes.get_mut(&thread_id) else {
            debug_unrouted_codex_notification(&message, "missing_route");
            return;
        };
        if self.is_active_local_task(&route.local_task_id) {
            return;
        }
        if let Some(started_thread_id) = codex_started_thread_id(&message) {
            self.register_codex_thread_workspace_root(&started_thread_id, &route.request);
        }
        route.event_mapper.map(
            &self.event_tx,
            &self.device_id,
            &route.local_task_id,
            &route.request,
            message,
        );
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
        });
        let pending_id = pending_thread_event_route_id(&local_task_id);
        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let existing = routes
            .remove(thread_id)
            .or_else(|| routes.remove(&pending_id));
        let mut route = existing.unwrap_or_else(|| {
            RuntimeThreadEventRoute::new(local_task_id.clone(), request.clone(), active)
        });
        if active {
            route.event_mapper = CodexNotificationEventMapper::default();
        }
        route.local_task_id = local_task_id;
        route.request = request;
        route.active = route.active || active;
        routes.insert(thread_id.to_owned(), route);
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
        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        if let Some(route) = routes.get_mut(&pending_id) {
            route.request = request;
            route.active = true;
            return;
        }
        routes.insert(
            pending_id,
            RuntimeThreadEventRoute::new(local_task_id, request, true),
        );
    }

    pub(super) fn record_local_task_thread(&self, local_task_id: &str, thread_id: &str) {
        if thread_id.trim().is_empty() {
            return;
        }
        self.store.update_task(local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
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
        self.thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .contains_key(thread_id)
    }

    pub(super) fn promote_pending_thread_event_route(&self, thread_id: &str) -> bool {
        if thread_id.trim().is_empty() {
            return false;
        }

        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        if routes.contains_key(thread_id) {
            return true;
        }
        let mut pending_route_ids = routes
            .iter()
            .filter(|(route_id, route)| is_pending_thread_event_route_id(route_id) && route.active)
            .map(|(route_id, _)| route_id.clone());
        let Some(pending_route_id) = pending_route_ids.next() else {
            return false;
        };
        if pending_route_ids.next().is_some() {
            return false;
        }
        let Some(route) = routes.remove(&pending_route_id) else {
            return false;
        };
        let local_task_id = route.local_task_id.clone();
        routes.insert(thread_id.to_owned(), route);
        drop(routes);

        self.store.update_task(&local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.updated_at = now_ms();
        });
        true
    }

    pub(super) fn unscoped_route_thread_id(&self) -> Option<String> {
        let routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let mut active_routes = routes
            .iter()
            .filter(|(_, route)| route.active)
            .map(|(thread_id, _)| thread_id.clone());
        if let Some(thread_id) = active_routes.next() {
            if active_routes.next().is_some() {
                return None;
            }
            return Some(thread_id);
        }

        let mut route_ids = routes.keys().cloned();
        let thread_id = route_ids.next()?;
        if route_ids.next().is_some() {
            None
        } else {
            Some(thread_id)
        }
    }

    pub(super) fn mark_thread_event_route_idle(&self, thread_id: &str) {
        if let Some(route) = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .get_mut(thread_id)
        {
            route.active = false;
        }
    }

    pub(super) fn remove_thread_event_route(&self, thread_id: &str) {
        self.thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .remove(thread_id);
    }

    pub(super) fn mark_thread_event_routes_idle_for_local_task(&self, local_task_id: &str) {
        for route in self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .values_mut()
        {
            if route.local_task_id == local_task_id {
                route.active = false;
            }
        }
    }
}
