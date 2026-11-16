//! Shared connected-account verification and runtime owner selectors.
use super::*;

impl RuntimeWorkRpcHandler {
    /// Desktop identity routes local IPC; cloud writes use the registered Runtime.
    pub(super) fn cloud_device_id(&self) -> Result<String, AppIpcError> {
        let Some(slot) = &self.backend_device_route else {
            // Standalone Executors register with their own device id.
            return Ok(self.device_id.clone());
        };
        slot.lock()
            .ok()
            .and_then(|route| route.clone())
            .filter(|route| !route.trim().is_empty())
            .ok_or_else(|| {
                AppIpcError::new(
                    "cloud_unavailable",
                    "Wait for this Runtime to register with the backend",
                )
            })
    }

    pub(super) async fn runtime_request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<reqwest::Response, AppIpcError> {
        let connection = self
            .backend_connection_snapshot()?
            .filter(|value| !value.backend_url.is_empty() && !value.auth_token.is_empty())
            .ok_or_else(|| {
                AppIpcError::new(
                    "cloud_unavailable",
                    "Connect this Executor to your cloud account",
                )
            })?;
        Self::runtime_request_on(&connection, method, path, body).await
    }

    pub(super) async fn runtime_request_on(
        connection: &ConnectionConfig,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<reqwest::Response, AppIpcError> {
        let client = crate::agents::backend_url::backend_http_client()
            .map_err(|error| AppIpcError::new("cloud_unavailable", error.to_string()))?;
        let mut request = client
            .request(
                method,
                format!("{}/api{path}", connection.backend_url.trim_end_matches('/')),
            )
            .bearer_auth(&connection.auth_token)
            .timeout(Duration::from_secs(10));
        if let Some(body) = body {
            request = request.json(body);
        }
        request
            .send()
            .await
            .map_err(|error| AppIpcError::new("cloud_unavailable", error.to_string()))
    }

    pub(super) async fn runtime_http(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AppIpcError> {
        let response = self.runtime_request(method.clone(), path, body).await?;
        if !response.status().is_success() {
            let status = response.status();
            let reason = response.json::<Value>().await.ok();
            let version_conflict = method == reqwest::Method::PATCH
                && status == reqwest::StatusCode::CONFLICT
                && reason
                    .as_ref()
                    .and_then(|body| body.pointer("/detail/code"))
                    .and_then(Value::as_str)
                    == Some("version_conflict");
            // Only known server messages are safe to include in diagnostics.
            let reason = match (
                version_conflict,
                reason.as_ref().and_then(|body| body["detail"].as_str()),
            ) {
                (true, _) => "version_conflict",
                (_, Some("Stand-in conversations require an active owned device")) => {
                    "active_owned_device_required"
                }
                (_, Some("Insufficient permission")) => "insufficient_permission",
                _ => "unknown",
            };
            log_executor_event(
                "runtime cloud request failed",
                &[
                    ("method", method.to_string()),
                    (
                        "path",
                        path.split('?').next().unwrap_or_default().to_owned(),
                    ),
                    ("status", status.as_u16().to_string()),
                    ("reason", reason.to_owned()),
                ],
            );
            return Err(AppIpcError::new(
                if version_conflict {
                    "version_conflict"
                } else {
                    "cloud_request_failed"
                },
                format!(
                    "Cloud request {method} {} returned {status} ({reason})",
                    path.split('?').next().unwrap_or_default()
                ),
            ));
        }
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        response
            .json()
            .await
            .map_err(|error| AppIpcError::new("cloud_response_invalid", error.to_string()))
    }

    pub(super) async fn verify_runtime_user(&self, config: &Value) -> Result<(), AppIpcError> {
        let user = self
            .runtime_http(reqwest::Method::GET, "/users/me", None)
            .await?;
        if user["id"] != config["userId"] {
            return Err(AppIpcError::new(
                "permission_denied",
                "The requested owner must match the connected account",
            ));
        }
        Ok(())
    }
}

pub(super) fn runtime_user(payload: &Value) -> Result<i64, AppIpcError> {
    payload["userId"]
        .as_i64()
        .filter(|user| *user >= 0)
        .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))
}

#[cfg(test)]
#[path = "runtime_owner_tests.rs"]
mod tests;
