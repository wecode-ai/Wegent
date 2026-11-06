//! Shared connected-account verification and runtime owner selectors.
use super::*;

impl RuntimeWorkRpcHandler {
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
        let response = self.runtime_request(method, path, body).await?;
        if !response.status().is_success() {
            return Err(AppIpcError::new(
                "cloud_request_failed",
                format!("Cloud request returned {}", response.status()),
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
