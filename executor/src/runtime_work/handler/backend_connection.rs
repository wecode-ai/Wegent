//! Device connection snapshots, event ownership and model gateway configuration.
use super::*;

impl RuntimeWorkRpcHandler {
    /// Fill the request's backend connection fields from the executor's
    /// current configuration when the run payload did not provide them.
    /// Runtime tasks created through the App IPC (queue dispatches, project
    /// chat runs) do not carry credentials; `wework_space` relies on them to
    /// read cloud project data. This mirrors `normalize_local_task_request`
    /// used by the `task:execute` channel so both paths behave identically
    /// regardless of when the executor process was spawned.
    pub(super) fn backend_connection_snapshot(
        &self,
    ) -> Result<Option<ConnectionConfig>, AppIpcError> {
        self.backend_connection
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| {
                AppIpcError::new(
                    "backend_connection_unavailable",
                    "Backend connection state is unavailable",
                )
            })
    }

    pub(super) fn apply_backend_connection(&self, request: &mut ExecutionRequest) {
        let connection = self.event_connection_snapshot();
        crate::local::event_scope::capture(request, connection.as_ref());
        if request.is_local_project() {
            request.clear_backend_credentials();
            return;
        }
        let current_account = connection
            .as_ref()
            .and_then(crate::local::event_scope::account);
        if request
            .extra
            .get(crate::local::event_scope::REQUEST_ACCOUNT)
            != Some(&current_account.map(Value::String).unwrap_or(Value::Null))
        {
            // Queued and recovered work must never borrow another login's
            // credentials. Existing original-actor credentials stay intact.
            return;
        }
        self.rewrite_model_gateway_backend(request);
        let Some(connection) = connection else { return };
        if connection.backend_url.trim().is_empty() || connection.auth_token.trim().is_empty() {
            return;
        }
        if request
            .backend_url
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            request.backend_url = Some(connection.backend_url.clone());
        }
        // Coordinator work must retain the enabling actor, including absent credentials.
        if request
            .extra
            .get("origin")
            .is_some_and(|origin| origin.get("project_coordination").is_some())
        {
            return;
        }
        if request
            .auth_token
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            request.auth_token = Some(connection.auth_token);
        }
        if request
            .runtime_auth_token
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
            && !connection.runtime_auth_token.trim().is_empty()
        {
            request.runtime_auth_token = Some(connection.runtime_auth_token);
        }
    }

    pub(super) fn capture_runtime_event_account(&self, request: &mut ExecutionRequest) {
        let connection = self.event_connection_snapshot();
        crate::local::event_scope::capture(request, connection.as_ref());
    }

    pub(super) fn admit_runtime_event_account(&self, payload: &mut Value) {
        let connection = self.event_connection_snapshot();
        crate::local::event_scope::admit(payload, connection.as_ref());
    }

    fn event_connection_snapshot(&self) -> Option<ConnectionConfig> {
        match self.backend_connection_snapshot() {
            Ok(connection) => connection,
            Err(error) => {
                log_executor_event(
                    "runtime event account unavailable",
                    &[("error", error.message)],
                );
                None
            }
        }
    }

    pub(super) fn retain_runtime_model_config(&self, local_task_id: &str, model_config: &Value) {
        let mut configs = self
            .runtime_model_configs
            .lock()
            .expect("runtime model config map lock should not be poisoned");
        if model_config
            .as_object()
            .is_some_and(|value| !value.is_empty())
        {
            configs.insert(local_task_id.to_owned(), model_config.clone());
        } else {
            configs.remove(local_task_id);
        }
    }

    pub(super) fn runtime_model_config(&self, local_task_id: &str) -> Option<Value> {
        self.runtime_model_configs
            .lock()
            .expect("runtime model config map lock should not be poisoned")
            .get(local_task_id)
            .cloned()
    }

    pub(super) fn forget_runtime_model_config(&self, local_task_id: &str) {
        self.forget_submitted_interfaces(local_task_id);
        self.runtime_model_configs
            .lock()
            .expect("runtime model config map lock should not be poisoned")
            .remove(local_task_id);
    }

    /// Bind the cloud-model gateway to the backend this device reaches.
    ///
    /// The connection snapshot is unavailable before the device finishes
    /// connecting, so fall back to the request's own backend URL (environment,
    /// payload, or task API domain) and leave the gateway untouched when
    /// neither source yields a reachable address.
    pub(super) fn rewrite_model_gateway_backend(&self, request: &mut ExecutionRequest) {
        let snapshot_backend_url = self
            .backend_connection_snapshot()
            .ok()
            .flatten()
            .map(|connection| connection.backend_url)
            .unwrap_or_default();
        let backend_url = if snapshot_backend_url.trim().is_empty() {
            crate::agents::request_backend_url(request).unwrap_or_default()
        } else {
            snapshot_backend_url
        };
        crate::agents::bind_backend_model_gateway(request, &backend_url);
    }
}

#[cfg(test)]
#[path = "event_account_tests.rs"]
mod tests;
