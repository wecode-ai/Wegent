// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, sync::Arc};

use serde_json::{json, Value};
use tokio::{
    sync::{broadcast, Mutex},
    task::JoinHandle,
};

use crate::{
    config::device::{ConnectionConfig, DeviceConfig},
    local::app_ipc::{AppIpcError, BackendConnectionHandler, RuntimeWorkHandler},
    logging::{format_executor_log, write_executor_error_line, write_executor_log_line},
};

use super::{LocalBackendConfig, LocalBackendRunner, LocalBackendTransport, SocketIoTransport};

#[derive(Clone)]
pub struct LocalBackendConnectionController {
    base_config: DeviceConfig,
    runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
    runtime_event_tx: Option<broadcast::Sender<Value>>,
    state: Arc<Mutex<LocalBackendConnectionState>>,
}

#[derive(Default)]
struct LocalBackendConnectionState {
    connection: Option<ConnectionConfig>,
    transport: Option<SocketIoTransport>,
    task: Option<JoinHandle<()>>,
}

impl LocalBackendConnectionController {
    pub async fn start(config: DeviceConfig) -> Self {
        Self::start_internal(config, None, None).await
    }

    pub async fn start_with_runtime(
        config: DeviceConfig,
        runtime_work_handler: Arc<dyn RuntimeWorkHandler>,
        runtime_event_tx: broadcast::Sender<Value>,
    ) -> Self {
        Self::start_internal(config, Some(runtime_work_handler), Some(runtime_event_tx)).await
    }

    async fn start_internal(
        mut config: DeviceConfig,
        runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
        runtime_event_tx: Option<broadcast::Sender<Value>>,
    ) -> Self {
        let initial_connection = normalized_connection(&config.connection);
        config.connection = ConnectionConfig::default();
        let controller = Self {
            base_config: config,
            runtime_work_handler,
            runtime_event_tx,
            state: Arc::new(Mutex::new(LocalBackendConnectionState::default())),
        };
        controller.replace_connection(initial_connection).await;
        controller
    }

    async fn replace_connection(&self, connection: Option<ConnectionConfig>) -> bool {
        let mut state = self.state.lock().await;
        if state.connection == connection {
            return false;
        }

        if let Some(task) = state.task.take() {
            task.abort();
        }
        if let Some(transport) = state.transport.take() {
            if let Err(error) = transport.disconnect().await {
                write_executor_error_line(&format_executor_log(
                    "local backend disconnect failed",
                    &[("error", error)],
                ));
            }
        }

        if let Some(connection) = &connection {
            let mut config = self.base_config.clone();
            config.connection = connection.clone();
            let backend_url = connection.backend_url.clone();
            let socket_url = resolved_socket_url(connection);
            let transport = SocketIoTransport::default();
            let mut runner = LocalBackendRunner::new(
                LocalBackendConfig::from_device_config(config),
                transport.clone(),
            );
            if let (Some(handler), Some(event_tx)) =
                (&self.runtime_work_handler, &self.runtime_event_tx)
            {
                runner =
                    runner.with_shared_runtime_work_handler(handler.clone(), event_tx.subscribe());
            }
            state.transport = Some(transport);
            state.task = Some(tokio::spawn(async move {
                if let Err(error) = runner.run_forever().await {
                    write_executor_error_line(&format_executor_log(
                        "local backend runner stopped",
                        &[
                            ("backend_url", backend_url),
                            ("socket_url", socket_url),
                            ("error", error),
                        ],
                    ));
                }
            }));
        }

        state.connection = connection.clone();
        write_executor_log_line(&format_executor_log(
            "local backend connection reconfigured",
            &[
                ("connected", connection.is_some().to_string()),
                (
                    "backend_url",
                    connection
                        .as_ref()
                        .map(|value| value.backend_url.clone())
                        .unwrap_or_default(),
                ),
                (
                    "socket_url",
                    connection
                        .as_ref()
                        .map(resolved_socket_url)
                        .unwrap_or_default(),
                ),
            ],
        ));
        true
    }
}

impl BackendConnectionHandler for LocalBackendConnectionController {
    fn configure_backend<'a>(
        &'a self,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            let connection = connection_from_params(&params)?;
            let changed = self.replace_connection(connection.clone()).await;
            Ok(json!({
                "changed": changed,
                "connected": connection.is_some(),
                "backend_url": connection.as_ref().map(|value| &value.backend_url),
                "socket_url": connection.as_ref().map(resolved_socket_url),
            }))
        })
    }
}

fn normalized_connection(connection: &ConnectionConfig) -> Option<ConnectionConfig> {
    let backend_url = connection.backend_url.trim().trim_end_matches('/');
    let auth_token = connection.auth_token.trim();
    let runtime_auth_token = connection.runtime_auth_token.trim();
    if backend_url.is_empty() || auth_token.is_empty() {
        return None;
    }
    Some(ConnectionConfig {
        backend_url: backend_url.to_owned(),
        socket_url: resolved_socket_url(connection),
        auth_token: auth_token.to_owned(),
        runtime_auth_token: runtime_auth_token.to_owned(),
    })
}

fn resolved_socket_url(connection: &ConnectionConfig) -> String {
    let socket_url = connection.socket_url.trim().trim_end_matches('/');
    if socket_url.is_empty() {
        connection
            .backend_url
            .trim()
            .trim_end_matches('/')
            .to_owned()
    } else {
        socket_url.to_owned()
    }
}

fn connection_from_params(params: &Value) -> Result<Option<ConnectionConfig>, AppIpcError> {
    let Some(params) = params.as_object() else {
        return Err(AppIpcError::new(
            "bad_request",
            "Backend connection params must be an object",
        ));
    };
    let backend_url = optional_connection_field(params.get("backend_url"), "backend_url")?;
    let socket_url = optional_connection_field(params.get("socket_url"), "socket_url")?;
    let auth_token = optional_connection_field(params.get("auth_token"), "auth_token")?;
    let runtime_auth_token =
        optional_connection_field(params.get("runtime_auth_token"), "runtime_auth_token")?;
    match (backend_url, socket_url, auth_token, runtime_auth_token) {
        (None, None, None, None) => Ok(None),
        (Some(backend_url), socket_url, Some(auth_token), runtime_auth_token) => {
            Ok(Some(ConnectionConfig {
                backend_url: backend_url.trim_end_matches('/').to_owned(),
                socket_url: socket_url
                    .unwrap_or_else(|| backend_url.clone())
                    .trim_end_matches('/')
                    .to_owned(),
                auth_token,
                runtime_auth_token: runtime_auth_token.unwrap_or_default(),
            }))
        }
        _ => Err(AppIpcError::new(
            "bad_request",
            "socket_url requires backend_url and auth_token",
        )),
    }
}

fn optional_connection_field(
    value: Option<&Value>,
    name: &str,
) -> Result<Option<String>, AppIpcError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.trim().to_owned())),
        _ => Err(AppIpcError::new(
            "bad_request",
            format!("{name} must be a non-empty string or null"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{connection_from_params, normalized_connection};
    use crate::config::device::ConnectionConfig;

    #[test]
    fn dynamic_connection_preserves_distinct_socket_url() {
        let connection = connection_from_params(&json!({
            "backend_url": "https://backend.example.com/",
            "socket_url": "wss://socket.example.com/",
            "auth_token": "wg-token",
            "runtime_auth_token": "runtime-wg-token",
        }))
        .expect("connection should parse")
        .expect("connection should be configured");

        assert_eq!(connection.backend_url, "https://backend.example.com");
        assert_eq!(connection.socket_url, "wss://socket.example.com");
        assert_eq!(connection.auth_token, "wg-token");
        assert_eq!(connection.runtime_auth_token, "runtime-wg-token");
    }

    #[test]
    fn static_connection_defaults_socket_url_to_backend_url() {
        let connection = normalized_connection(&ConnectionConfig {
            backend_url: "https://backend.example.com/".to_owned(),
            socket_url: String::new(),
            auth_token: "wg-token".to_owned(),
            runtime_auth_token: "runtime-wg-token".to_owned(),
        })
        .expect("connection should be configured");

        assert_eq!(connection.backend_url, "https://backend.example.com");
        assert_eq!(connection.socket_url, "https://backend.example.com");
        assert_eq!(connection.runtime_auth_token, "runtime-wg-token");
    }

    #[test]
    fn dynamic_connection_rejects_socket_url_without_credentials() {
        let error = connection_from_params(&json!({
            "socket_url": "wss://socket.example.com",
        }))
        .expect_err("socket-only connection should be rejected");

        assert_eq!(error.code, "bad_request");
    }
}
