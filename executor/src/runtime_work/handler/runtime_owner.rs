//! Shared connected-account verification and runtime owner selectors.
use super::*;
use sha2::{Digest, Sha256};

pub(super) type VerifiedStandInOwner = ([u8; 32], i64);

fn connection_owner_key(connection: &ConnectionConfig) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(connection.backend_url.as_bytes());
    hash.update([0]);
    hash.update(connection.auth_token.as_bytes());
    hash.finalize().into()
}

impl RuntimeWorkRpcHandler {
    fn require_runtime_connection(&self) -> Result<ConnectionConfig, AppIpcError> {
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

    pub(super) async fn verify_runtime_user(&self, config: &Value) -> Result<(), AppIpcError> {
        let connection = self.require_runtime_connection()?;
        self.verify_runtime_user_on(&connection, config).await
    }

    async fn verify_runtime_user_on(
        &self,
        connection: &ConnectionConfig,
        config: &Value,
    ) -> Result<(), AppIpcError> {
        let path = if connection.auth_token.starts_with("wg-") {
            "/devices/runtime-owner"
        } else {
            "/users/me"
        };
        let key = connection_owner_key(connection);
        let response =
            Self::runtime_request_on(connection, reqwest::Method::GET, path, None).await?;
        if matches!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) {
            if let Ok(mut verified) = self.verified_stand_in_owner.lock() {
                if verified.is_some_and(|(owner_key, _)| owner_key == key) {
                    *verified = None;
                }
            }
        }
        let user = Self::read_runtime_response(reqwest::Method::GET, path, response).await?;
        if let Ok(mut verified) = self.verified_stand_in_owner.lock() {
            *verified = user["id"].as_i64().map(|owner| (key, owner));
        }
        if user["id"].as_i64().is_none() || user["id"] != config["userId"] {
            return Err(AppIpcError::new(
                "permission_denied",
                "The requested owner must match the connected account",
            ));
        }
        Ok(())
    }

    /// Local background work uses the owner proved for this exact connection.
    /// Access to cloud resources still requires live authorization.
    pub(super) async fn verify_local_stand_in_owner(&self, user: i64) -> Result<(), AppIpcError> {
        let Some(connection) = self.backend_connection_snapshot()? else {
            return Ok(());
        };
        let key = connection_owner_key(&connection);
        let verified = self
            .verified_stand_in_owner
            .lock()
            .ok()
            .and_then(|owner| *owner);
        if let Some((_, owner)) = verified.filter(|(verified_key, _)| *verified_key == key) {
            if owner == user {
                return Ok(());
            }
            return Err(AppIpcError::new(
                "permission_denied",
                "The requested owner must match the connected account",
            ));
        }
        self.verify_runtime_user_on(&connection, &json!({"userId":user}))
            .await
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
