// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, sync::Arc};

use serde_json::{json, Value};
use tokio::{sync::Mutex, task::JoinHandle};

use crate::{
    config::device::{ConnectionConfig, DeviceConfig},
    local::app_ipc::{AppIpcError, BackendConnectionHandler},
    logging::{format_executor_log, write_executor_error_line, write_executor_log_line},
};

use super::{LocalBackendConfig, LocalBackendRunner, LocalBackendTransport, SocketIoTransport};

#[derive(Clone)]
pub struct LocalBackendConnectionController {
    base_config: DeviceConfig,
    state: Arc<Mutex<LocalBackendConnectionState>>,
}

#[derive(Default)]
struct LocalBackendConnectionState {
    connection: Option<ConnectionConfig>,
    transport: Option<SocketIoTransport>,
    task: Option<JoinHandle<()>>,
}

impl LocalBackendConnectionController {
    pub async fn start(mut config: DeviceConfig) -> Self {
        let initial_connection = normalized_connection(&config.connection);
        config.connection = ConnectionConfig::default();
        let controller = Self {
            base_config: config,
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
            let transport = SocketIoTransport::default();
            let runner = LocalBackendRunner::new(
                LocalBackendConfig::from_device_config(config),
                transport.clone(),
            );
            state.transport = Some(transport);
            state.task = Some(tokio::spawn(async move {
                if let Err(error) = runner.run_forever().await {
                    write_executor_error_line(&format_executor_log(
                        "local backend runner stopped",
                        &[("backend_url", backend_url), ("error", error)],
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
                "backend_url": connection.map(|value| value.backend_url),
            }))
        })
    }
}

fn normalized_connection(connection: &ConnectionConfig) -> Option<ConnectionConfig> {
    let backend_url = connection.backend_url.trim().trim_end_matches('/');
    let auth_token = connection.auth_token.trim();
    if backend_url.is_empty() || auth_token.is_empty() {
        return None;
    }
    Some(ConnectionConfig {
        backend_url: backend_url.to_owned(),
        auth_token: auth_token.to_owned(),
    })
}

fn connection_from_params(params: &Value) -> Result<Option<ConnectionConfig>, AppIpcError> {
    let Some(params) = params.as_object() else {
        return Err(AppIpcError::new(
            "bad_request",
            "Backend connection params must be an object",
        ));
    };
    let backend_url = optional_connection_field(params.get("backend_url"), "backend_url")?;
    let auth_token = optional_connection_field(params.get("auth_token"), "auth_token")?;
    match (backend_url, auth_token) {
        (None, None) => Ok(None),
        (Some(backend_url), Some(auth_token)) => Ok(Some(ConnectionConfig {
            backend_url: backend_url.trim_end_matches('/').to_owned(),
            auth_token,
        })),
        _ => Err(AppIpcError::new(
            "bad_request",
            "backend_url and auth_token must be provided together",
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
