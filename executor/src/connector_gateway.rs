// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Short-lived, local authorization used by the Connector MCP child process.

use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const CONFIG_DIR: &str = "connector-runtime";
const CONFIG_FILE: &str = "authorization.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ConnectorGatewayConfig {
    pub(crate) api_base_url: String,
    pub(crate) connector_token: String,
    pub(crate) expires_at_ms: i64,
}

#[derive(Debug)]
pub(crate) struct ConnectorGatewayError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ConnectorGatewayError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl ConnectorGatewayConfig {
    pub(crate) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ConnectorGatewayError> {
        if self.expires_at_ms <= now_ms() + 5_000 {
            return Err(ConnectorGatewayError::new(
                "connector_token_expired",
                "Wegent connector authorization expired; reconnect cloud",
            ));
        }
        let url = format!(
            "{}/connector-runtime/{}",
            self.api_base_url,
            path.trim_start_matches('/')
        );
        let client = reqwest::Client::new();
        let mut request = client
            .request(method, &url)
            .bearer_auth(&self.connector_token)
            .timeout(Duration::from_secs(75));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            ConnectorGatewayError::new(
                "connector_gateway_unavailable",
                format!("Wegent connector gateway is unavailable: {error}"),
            )
        })?;
        let status = response.status();
        let text = response.text().await.map_err(|error| {
            ConnectorGatewayError::new(
                "connector_gateway_invalid_response",
                format!("Invalid connector gateway response: {error}"),
            )
        })?;
        if !status.is_success() {
            let detail = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
                value
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            let message = match detail {
                Some(detail) => format!("{detail} (HTTP {status})"),
                None => format!("Connector gateway request failed (HTTP {status}): {text}"),
            };
            return Err(ConnectorGatewayError::new(
                "connector_gateway_error",
                message,
            ));
        }
        let value = serde_json::from_str::<Value>(&text).map_err(|error| {
            ConnectorGatewayError::new(
                "connector_gateway_invalid_response",
                format!("Invalid connector gateway response: {error}"),
            )
        })?;
        Ok(value)
    }
}

pub(crate) fn load_connector_gateway_config() -> Result<ConnectorGatewayConfig, String> {
    load_connector_gateway_config_from(&connector_gateway_config_path())
}

pub(crate) fn persist_connector_gateway_config(
    config: &ConnectorGatewayConfig,
) -> Result<(), String> {
    persist_connector_gateway_config_to(&connector_gateway_config_path(), config)
}

pub(crate) fn clear_connector_gateway_config() -> Result<(), String> {
    let path = connector_gateway_config_path();
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }
}

fn connector_gateway_config_path() -> PathBuf {
    env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .unwrap_or_else(env::temp_dir)
        .join(CONFIG_DIR)
        .join(CONFIG_FILE)
}

fn load_connector_gateway_config_from(path: &Path) -> Result<ConnectorGatewayConfig, String> {
    let bytes = fs::read(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            "Wegent connector authorization is unavailable; reconnect cloud".to_owned()
        }
        _ => format!("Failed to read connector authorization: {error}"),
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid connector authorization: {error}"))
}

fn persist_connector_gateway_config_to(
    path: &Path,
    config: &ConnectorGatewayConfig,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Connector authorization path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create connector authorization: {error}"))?;
    serde_json::to_writer(&mut temporary, config)
        .map_err(|error| format!("Failed to encode connector authorization: {error}"))?;
    temporary
        .write_all(b"\n")
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("Failed to write connector authorization: {error}"))?;
    set_owner_only_permissions(temporary.path())?;
    temporary
        .persist(path)
        .map_err(|error| format!("Failed to replace connector authorization: {}", error.error))?;
    set_owner_only_permissions(path)
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to secure connector authorization: {error}"))
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
    use tokio::net::TcpListener;

    #[test]
    fn persists_and_loads_scoped_authorization() {
        let temp = tempfile::tempdir().expect("temporary directory should be created");
        let path = temp.path().join(CONFIG_FILE);
        let config = ConnectorGatewayConfig {
            api_base_url: "https://cloud.example.test/api".to_owned(),
            connector_token: "scoped-token".to_owned(),
            expires_at_ms: 42,
        };

        persist_connector_gateway_config_to(&path, &config).expect("authorization should persist");
        let loaded =
            load_connector_gateway_config_from(&path).expect("authorization should be readable");

        assert_eq!(loaded.api_base_url, config.api_base_url);
        assert_eq!(loaded.connector_token, config.connector_token);
        assert_eq!(loaded.expires_at_ms, config.expires_at_ms);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path)
                    .expect("authorization metadata should exist")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn non_success_json_detail_returns_gateway_error() {
        let config =
            gateway_config_for_response(StatusCode::BAD_REQUEST, r#"{"detail":"cloud rejected"}"#)
                .await;

        let error = config
            .request(Method::GET, "tools", None)
            .await
            .expect_err("gateway error should be returned");

        assert_eq!(error.code, "connector_gateway_error");
        assert_eq!(error.message, "cloud rejected (HTTP 400 Bad Request)");
    }

    #[tokio::test]
    async fn non_success_plain_text_returns_gateway_error_with_body() {
        let config =
            gateway_config_for_response(StatusCode::BAD_GATEWAY, "upstream unavailable").await;

        let error = config
            .request(Method::GET, "tools", None)
            .await
            .expect_err("gateway error should be returned");

        assert_eq!(error.code, "connector_gateway_error");
        assert_eq!(
            error.message,
            "Connector gateway request failed (HTTP 502 Bad Gateway): upstream unavailable"
        );
    }

    async fn gateway_config_for_response(
        status: StatusCode,
        body: &'static str,
    ) -> ConnectorGatewayConfig {
        let app = Router::new().route(
            "/connector-runtime/tools",
            get(move || async move { (status, body).into_response() }),
        );
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let address = listener
            .local_addr()
            .expect("test listener address should be available");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("test server should run");
        });
        ConnectorGatewayConfig {
            api_base_url: format!("http://{address}"),
            connector_token: "scoped-token".to_owned(),
            expires_at_ms: now_ms() + 60_000,
        }
    }
}
