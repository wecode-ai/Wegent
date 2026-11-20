// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn prepare_goal_model_route(
        &self,
        link: &RuntimeTaskLink,
        thread_id: &str,
        payload: &Value,
    ) -> Result<(), AppIpcError> {
        // A live turn already owns its route and model selection.
        if payload
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("active")
            != "active"
            || self.is_active_local_task(&link.local_task_id)
            || self.native_task_holds_capacity(&link.local_task_id)
        {
            return Ok(());
        }
        let mut request = runtime_model_request(link, payload)?;
        if payload.get("modelConfig").is_none() {
            if let Some(config) = self.runtime_model_config(&link.local_task_id) {
                request.model_config = config;
            }
        }
        crate::runtime_work::api_context::bind_task_identity(
            &mut request,
            &self.device_id,
            &link.local_task_id,
        );
        self.apply_backend_connection(&mut request);
        self.resolve_local_model_reference(&mut request, &link.local_task_id)?;
        self.register_thread_event_route(
            thread_id,
            link.local_task_id.clone(),
            request.clone(),
            false,
        );
        self.ensure_notification_router().await;
        // Apply the execution profile while the Goal is still stopped. Otherwise
        // recovery reloads the passive history profile after activation and can
        // unload the native continuation that the mutation already started.
        let thread_path = runtime_thread_path_from_link(link);
        self.codex_app_server
            .resume_thread_for_model_action(
                &request,
                thread_id,
                thread_path.as_deref(),
                |registration| {
                    self.retain_goal_model_route(thread_id, registration);
                },
            )
            .await
            .map_err(|error| AppIpcError::new("model_route_failed", error))?;
        Ok(())
    }

    pub(super) fn retain_goal_model_route(
        &self,
        thread_id: &str,
        registration: Option<crate::agents::ModelActionRegistration>,
    ) {
        if let Some(route) = self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned")
            .routes
            .get_mut(thread_id)
        {
            // Native activation may outlive an ambiguous resume response.
            route.goal_model_route = registration;
        }
    }

    pub(super) fn release_goal_model_routes(&self, local_task_id: &str) {
        for route in self
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned")
            .routes
            .values_mut()
        {
            if route.local_task_id == local_task_id {
                route.goal_model_route = None;
            }
        }
    }
}
