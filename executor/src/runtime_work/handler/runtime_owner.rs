//! Shared connected-account verification and runtime owner selectors.
use super::*;
use sha2::{Digest, Sha256};

pub(super) fn connection_owner_key(connection: &ConnectionConfig) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(connection.backend_url.as_bytes());
    hash.update([0]);
    hash.update(connection.auth_token.as_bytes());
    hash.update(
        connection
            .authenticated_user_id
            .unwrap_or_default()
            .to_be_bytes(),
    );
    hash.finalize().into()
}

impl RuntimeWorkRpcHandler {
    pub(super) fn require_runtime_connection(&self) -> Result<ConnectionConfig, AppIpcError> {
        self.backend_connection_snapshot()?
            .filter(|value| !value.backend_url.is_empty() && !value.auth_token.is_empty())
            .ok_or_else(|| {
                AppIpcError::new(
                    "cloud_unavailable",
                    "Connect this Executor to your cloud account",
                )
            })
    }

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
        let connection = self.require_runtime_connection()?;
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
        let connection = self.require_runtime_connection()?;
        Self::runtime_http_on(&connection, method, path, body).await
    }

    async fn runtime_http_on(
        connection: &ConnectionConfig,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AppIpcError> {
        let response = Self::runtime_request_on(connection, method.clone(), path, body).await?;
        Self::read_runtime_response(method, path, response).await
    }

    pub(super) async fn read_runtime_response(
        method: reqwest::Method,
        path: &str,
        response: reqwest::Response,
    ) -> Result<Value, AppIpcError> {
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

    pub(super) fn local_connection_user(connection: &ConnectionConfig) -> Result<i64, AppIpcError> {
        connection
            .authenticated_user_id
            .filter(|id| *id > 0)
            .ok_or_else(|| {
                AppIpcError::new(
                    "permission_denied",
                    "Connected account identity is unavailable",
                )
            })
    }

    pub(super) async fn connected_runtime_user(
        connection: &ConnectionConfig,
    ) -> Result<i64, AppIpcError> {
        let user = if connection.auth_token.starts_with("wg-") {
            Self::runtime_http_on(
                connection,
                reqwest::Method::GET,
                "/devices/runtime-owner",
                None,
            )
            .await?["id"]
                .as_i64()
        } else {
            return Self::local_connection_user(connection);
        };
        user.filter(|id| *id > 0).ok_or_else(|| {
            AppIpcError::new(
                "permission_denied",
                "Connected account identity is unavailable",
            )
        })
    }

    /// Standalone Runtimes resolve their account at service startup. Desktop
    /// Runtimes receive an authenticated identity in the connection snapshot.
    pub(super) async fn initialize_connection_service_owner(&self) -> Result<i64, AppIpcError> {
        let connection = self.require_runtime_connection()?;
        let owner = if !connection.auth_token.starts_with("wg-")
            && connection.authenticated_user_id.is_none()
        {
            Self::runtime_http_on(&connection, reqwest::Method::GET, "/users/me", None).await?["id"]
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or_else(|| {
                    AppIpcError::new(
                        "permission_denied",
                        "Connected account identity is unavailable",
                    )
                })?
        } else {
            Self::connected_runtime_user(&connection).await?
        };
        let mut snapshot = self.backend_connection.lock().map_err(|_| {
            AppIpcError::new(
                "cloud_unavailable",
                "Runtime connection state is unavailable",
            )
        })?;
        let current = snapshot
            .as_mut()
            .filter(|current| **current == connection)
            .ok_or_else(|| AppIpcError::new("cloud_unavailable", "Runtime connection changed"))?;
        current.authenticated_user_id = Some(owner);
        Ok(owner)
    }

    pub(super) fn verify_local_stand_in_owner(&self, user: i64) -> Result<(), AppIpcError> {
        if let Some(connection) = self.backend_connection_snapshot()? {
            if connection.authenticated_user_id != Some(user) {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "The requested owner must match the connected account",
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn verify_runtime_user(&self, config: &Value) -> Result<(), AppIpcError> {
        let connection = self.require_runtime_connection()?;
        let user = Self::connected_runtime_user(&connection).await?;
        if config["userId"].as_i64() != Some(user) {
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
