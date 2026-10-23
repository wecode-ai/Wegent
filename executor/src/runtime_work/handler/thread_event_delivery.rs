// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn record_codex_global_notification_progress(
        routing: &mut RuntimeThreadEventRouting,
        local_task_id: &str,
        sequence: u64,
        active: bool,
    ) {
        routing
            .global_notification_progress
            .entry(local_task_id.to_owned())
            .and_modify(|progress| *progress = (*progress).max(sequence))
            .or_insert(sequence);
        if !active {
            if let Some(claims) = routing.command_notification_claims.get_mut(local_task_id) {
                claims.retain(|claimed| *claimed >= sequence);
                if claims.is_empty() {
                    routing.command_notification_claims.remove(local_task_id);
                }
            }
        }
    }

    pub(super) fn claim_codex_command_notification(
        &self,
        local_task_id: &str,
        message: &Value,
        global_receiver: bool,
    ) -> Option<std::sync::MutexGuard<'_, RuntimeThreadEventRouting>> {
        let active = self.is_active_local_task(local_task_id);
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        if let Some(sequence) = message
            .get(crate::runtime_work::CODEX_NOTIFICATION_SEQUENCE_FIELD)
            .and_then(Value::as_u64)
        {
            let global_progress = routing
                .global_notification_progress
                .get(local_task_id)
                .copied()
                .unwrap_or_default();
            let claims = routing
                .command_notification_claims
                .entry(local_task_id.to_owned())
                .or_default();
            if claims.remove(&sequence) {
                return None;
            }
            if active && (global_receiver || sequence > global_progress) {
                claims.insert(sequence);
            }
        }
        // Keep claiming, recording and emitting atomic across both receivers.
        Some(routing)
    }

    pub(super) fn retire_codex_command_notification_claims(
        &self,
        routing: &mut RuntimeThreadEventRouting,
        task_id: &str,
    ) {
        if self.is_active_local_task(task_id) {
            return;
        }
        let global_progress = routing
            .global_notification_progress
            .get(task_id)
            .copied()
            .unwrap_or_default();
        if let Some(claims) = routing.command_notification_claims.get_mut(task_id) {
            // Retain only output the global receiver has not reached yet.
            claims.retain(|sequence| *sequence > global_progress);
            if claims.is_empty() {
                routing.command_notification_claims.remove(task_id);
            }
        }
    }

    pub(super) fn mark_thread_event_route_idle(&self, thread_id: &str) {
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        if let Some(route) = routing.routes.get_mut(thread_id) {
            route.active = false;
            let local_task_id = route.local_task_id.clone();
            self.retire_codex_command_notification_claims(&mut routing, &local_task_id);
        }
    }

    pub(super) fn remove_thread_event_route(&self, thread_id: &str) {
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        if let Some(removed) = routing.routes.remove(thread_id) {
            if !self.is_active_local_task(&removed.local_task_id)
                && !routing
                    .routes
                    .values()
                    .any(|route| route.local_task_id == removed.local_task_id)
            {
                routing
                    .command_notification_claims
                    .remove(&removed.local_task_id);
                routing
                    .global_notification_progress
                    .remove(&removed.local_task_id);
            }
        }
        routing.replaying_route_generations.remove(thread_id);
        routing
            .pending_notifications
            .retain(|notification| notification.thread_id != thread_id);
    }

    pub(super) fn mark_thread_event_routes_idle_for_local_task(&self, local_task_id: &str) {
        let mut routing = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        self.retire_codex_command_notification_claims(&mut routing, local_task_id);
        for route in routing.routes.values_mut() {
            if route.local_task_id == local_task_id {
                route.active = false;
            }
        }
    }
}
