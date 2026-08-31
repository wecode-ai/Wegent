// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{sync::Mutex, task::JoinHandle};

use crate::{
    config::device::{ConnectionConfig, DeviceConfig},
    local::{
        app_ipc::{AppIpcError, BackendConnectionHandler, RuntimeWorkHandler},
        event_stream::ExecutorEventHub,
    },
    logging::{format_executor_log, write_executor_error_line, write_executor_log_line},
};

use super::{LocalBackendConfig, LocalBackendRunner, LocalBackendTransport, SocketIoTransport};

#[derive(Clone)]
pub struct LocalBackendConnectionController {
    base_config: DeviceConfig,
    runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
    runtime_event_hub: Option<ExecutorEventHub>,
    state: Arc<Mutex<LocalBackendConnectionState>>,
    /// Lightweight snapshot of the current connection shared with the
    /// runtime-work handler so App-IPC task runs can resolve backend
    /// credentials without relying on the executor process environment.
    connection_snapshot: Arc<StdMutex<Option<ConnectionConfig>>>,
    connection_status: Arc<AtomicBool>,
}

#[derive(Default)]
struct LocalBackendConnectionState {
    profile: Option<LocalBackendConnectionProfile>,
    transport: Option<SocketIoTransport>,
    task: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalBackendConnectionProfile {
    connection: ConnectionConfig,
    registration_device_type: Option<String>,
}

impl LocalBackendConnectionController {
    pub async fn start(config: DeviceConfig) -> Self {
        Self::start_internal(config, None, None, Arc::new(StdMutex::new(None))).await
    }

    pub(crate) async fn start_with_runtime(
        config: DeviceConfig,
        runtime_work_handler: Arc<dyn RuntimeWorkHandler>,
        runtime_event_hub: ExecutorEventHub,
        connection_snapshot: Arc<StdMutex<Option<ConnectionConfig>>>,
    ) -> Self {
        Self::start_internal(
            config,
            Some(runtime_work_handler),
            Some(runtime_event_hub),
            connection_snapshot,
        )
        .await
    }

    async fn start_internal(
        mut config: DeviceConfig,
        runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
        runtime_event_hub: Option<ExecutorEventHub>,
        connection_snapshot: Arc<StdMutex<Option<ConnectionConfig>>>,
    ) -> Self {
        let initial_profile = normalized_connection(&config.connection).map(|connection| {
            LocalBackendConnectionProfile {
                connection,
                registration_device_type: None,
            }
        });
        config.connection = ConnectionConfig::default();
        let controller = Self {
            base_config: config,
            runtime_work_handler,
            runtime_event_hub,
            state: Arc::new(Mutex::new(LocalBackendConnectionState::default())),
            connection_snapshot,
            connection_status: Arc::new(AtomicBool::new(false)),
        };
        controller.replace_connection(initial_profile).await;
        controller
    }

    pub fn connection_snapshot(&self) -> Arc<StdMutex<Option<ConnectionConfig>>> {
        Arc::clone(&self.connection_snapshot)
    }

    async fn replace_connection(&self, profile: Option<LocalBackendConnectionProfile>) -> bool {
        let mut state = self.state.lock().await;
        if state.profile == profile {
            return false;
        }
        if let Ok(mut snapshot) = self.connection_snapshot.lock() {
            *snapshot = profile.as_ref().map(|value| value.connection.clone());
        }

        if let Some(task) = state.task.take() {
            self.connection_status.store(false, Ordering::Release);
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

        if let Some(profile) = &profile {
            let config = device_config_for_profile(&self.base_config, profile);
            let backend_url = profile.connection.backend_url.clone();
            let socket_url = resolved_socket_url(&profile.connection);
            let transport = SocketIoTransport::default();
            let runner = if let (Some(handler), Some(event_hub)) =
                (&self.runtime_work_handler, &self.runtime_event_hub)
            {
                LocalBackendRunner::new_for_app_sidecar_with_event_hub(
                    LocalBackendConfig::from_device_config(config),
                    transport.clone(),
                    handler.clone(),
                    event_hub.clone(),
                )
            } else {
                LocalBackendRunner::new_for_app_sidecar(
                    LocalBackendConfig::from_device_config(config),
                    transport.clone(),
                )
            }
            .with_connection_status(Arc::clone(&self.connection_status));
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

        state.profile = profile.clone();
        write_executor_log_line(&format_executor_log(
            "local backend connection reconfigured",
            &[
                ("connected", profile.is_some().to_string()),
                (
                    "backend_url",
                    profile
                        .as_ref()
                        .map(|value| value.connection.backend_url.clone())
                        .unwrap_or_default(),
                ),
                (
                    "socket_url",
                    profile
                        .as_ref()
                        .map(|value| resolved_socket_url(&value.connection))
                        .unwrap_or_default(),
                ),
                (
                    "registration_device_type",
                    profile
                        .as_ref()
                        .and_then(|value| value.registration_device_type.clone())
                        .unwrap_or_else(|| self.base_config.device_type.clone()),
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
            let profile = connection_profile_from_params(&params)?;
            let changed = self.replace_connection(profile.clone()).await;
            Ok(json!({
                "changed": changed,
                "connected": profile.is_some(),
                "backend_url": profile.as_ref().map(|value| &value.connection.backend_url),
                "socket_url": profile.as_ref().map(|value| resolved_socket_url(&value.connection)),
                "device_type": profile.as_ref().and_then(|value| value.registration_device_type.as_deref()),
            }))
        })
    }

    fn backend_status<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            let state = self.state.lock().await;
            Ok(json!({
                "configured": state.profile.is_some(),
                "connected": self.connection_status.load(Ordering::Acquire),
                "backend_url": state.profile.as_ref().map(|value| &value.connection.backend_url),
                "socket_url": state.profile.as_ref().map(|value| resolved_socket_url(&value.connection)),
                "device_type": state.profile.as_ref().and_then(|value| value.registration_device_type.as_deref()),
            }))
        })
    }

    fn backend_quota<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            let connection = {
                let state = self.state.lock().await;
                state.profile.as_ref().map(|value| value.connection.clone())
            }
            .ok_or_else(|| {
                AppIpcError::new(
                    "backend_connection_unavailable",
                    "Backend connection is not configured",
                )
            })?;
            let endpoint = format!(
                "{}/api/quota/claude/quota",
                connection.backend_url.trim_end_matches('/')
            );
            let response = reqwest::Client::new()
                .get(endpoint)
                .bearer_auth(&connection.auth_token)
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|error| {
                    AppIpcError::new("backend_quota_unavailable", error.to_string())
                })?;
            let status = response.status();
            let payload = response.json::<Value>().await.map_err(|error| {
                AppIpcError::new("backend_quota_invalid_response", error.to_string())
            })?;
            if !status.is_success() {
                return Err(AppIpcError::new(
                    "backend_quota_unavailable",
                    format!("Backend quota request failed with HTTP {status}"),
                ));
            }
            Ok(payload)
        })
    }
}

fn device_config_for_profile(
    base_config: &DeviceConfig,
    profile: &LocalBackendConnectionProfile,
) -> DeviceConfig {
    let mut config = base_config.clone();
    config.connection = profile.connection.clone();
    if let Some(device_type) = &profile.registration_device_type {
        config.device_type = device_type.clone();
    }
    config
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

fn connection_profile_from_params(
    params: &Value,
) -> Result<Option<LocalBackendConnectionProfile>, AppIpcError> {
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
    let registration_device_type = optional_registration_device_type(params.get("device_type"))?;
    match (
        backend_url,
        socket_url,
        auth_token,
        runtime_auth_token,
        registration_device_type,
    ) {
        (None, None, None, None, None) => Ok(None),
        (
            Some(backend_url),
            socket_url,
            Some(auth_token),
            runtime_auth_token,
            registration_device_type,
        ) => Ok(Some(LocalBackendConnectionProfile {
            connection: ConnectionConfig {
                backend_url: backend_url.trim_end_matches('/').to_owned(),
                socket_url: socket_url
                    .unwrap_or_else(|| backend_url.clone())
                    .trim_end_matches('/')
                    .to_owned(),
                auth_token,
                runtime_auth_token: runtime_auth_token.unwrap_or_default(),
            },
            registration_device_type,
        })),
        _ => Err(AppIpcError::new(
            "bad_request",
            "socket_url requires backend_url and auth_token",
        )),
    }
}

fn optional_registration_device_type(value: Option<&Value>) -> Result<Option<String>, AppIpcError> {
    let Some(device_type) = optional_connection_field(value, "device_type")? else {
        return Ok(None);
    };
    match device_type.as_str() {
        "app" | "remote" => Ok(Some(device_type)),
        _ => Err(AppIpcError::new(
            "bad_request",
            "device_type must be app or remote",
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
    use axum::{http::HeaderMap, routing::get, Json, Router};
    use serde_json::json;
    use tokio::net::TcpListener;

    use super::{
        connection_profile_from_params, device_config_for_profile, normalized_connection,
        LocalBackendConnectionController,
    };
    use crate::{
        config::device::{ConnectionConfig, DeviceConfig},
        local::app_ipc::BackendConnectionHandler,
    };

    #[tokio::test]
    async fn publishes_the_initial_connection_to_the_shared_snapshot() {
        let config = DeviceConfig {
            connection: ConnectionConfig {
                backend_url: "https://backend.example.com".to_owned(),
                socket_url: String::new(),
                auth_token: "wg-token".to_owned(),
                runtime_auth_token: "runtime-wg-token".to_owned(),
            },
            ..DeviceConfig::default()
        };

        let controller = LocalBackendConnectionController::start(config).await;
        let snapshot = controller.connection_snapshot();
        {
            let guard = snapshot.lock().unwrap();
            let connection = guard
                .as_ref()
                .expect("initial connection should be published");

            assert_eq!(connection.backend_url, "https://backend.example.com");
            assert_eq!(connection.auth_token, "wg-token");
            assert_eq!(connection.runtime_auth_token, "runtime-wg-token");
        }

        let status = controller
            .backend_status()
            .await
            .expect("backend status should be available");
        assert_eq!(status["configured"], true);
        assert_eq!(status["connected"], false);
    }

    #[tokio::test]
    async fn reads_backend_quota_without_exposing_the_auth_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/api/quota/claude/quota",
                    get(|headers: HeaderMap| async move {
                        assert_eq!(
                            headers
                                .get("authorization")
                                .and_then(|value| value.to_str().ok()),
                            Some("Bearer wg-token")
                        );
                        Json(json!({
                            "data": {"remaining": 845.21},
                            "quota_source": "AIGC额度",
                        }))
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let controller = LocalBackendConnectionController::start(DeviceConfig {
            connection: ConnectionConfig {
                backend_url: format!("http://{address}"),
                socket_url: String::new(),
                auth_token: "wg-token".to_owned(),
                runtime_auth_token: "runtime-wg-token".to_owned(),
            },
            ..DeviceConfig::default()
        })
        .await;

        let quota = controller
            .backend_quota()
            .await
            .expect("backend quota should be available");

        assert_eq!(quota["data"]["remaining"], 845.21);
        assert_eq!(quota["quota_source"], "AIGC额度");
        server.abort();
    }

    #[test]
    fn dynamic_connection_preserves_distinct_socket_url() {
        let profile = connection_profile_from_params(&json!({
            "backend_url": "https://backend.example.com/",
            "socket_url": "wss://socket.example.com/",
            "auth_token": "wg-token",
            "runtime_auth_token": "runtime-wg-token",
            "device_type": "remote",
        }))
        .expect("connection should parse")
        .expect("connection should be configured");
        let connection = &profile.connection;

        assert_eq!(connection.backend_url, "https://backend.example.com");
        assert_eq!(connection.socket_url, "wss://socket.example.com");
        assert_eq!(connection.auth_token, "wg-token");
        assert_eq!(connection.runtime_auth_token, "runtime-wg-token");
        assert_eq!(profile.registration_device_type.as_deref(), Some("remote"));
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
        let error = connection_profile_from_params(&json!({
            "socket_url": "wss://socket.example.com",
        }))
        .expect_err("socket-only connection should be rejected");

        assert_eq!(error.code, "bad_request");
    }

    #[test]
    fn dynamic_connection_rejects_non_exposure_device_types() {
        let error = connection_profile_from_params(&json!({
            "backend_url": "https://backend.example.com",
            "auth_token": "wg-token",
            "device_type": "local",
        }))
        .expect_err("local device type should not be accepted as an exposure profile");

        assert_eq!(error.code, "bad_request");
        assert_eq!(error.message, "device_type must be app or remote");
    }

    #[test]
    fn registration_profile_changes_only_the_backend_device_type() {
        let base = DeviceConfig {
            device_type: "local".to_owned(),
            ..DeviceConfig::default()
        };
        let profile = connection_profile_from_params(&json!({
            "backend_url": "https://backend.example.com",
            "auth_token": "wg-token",
            "device_type": "remote",
        }))
        .expect("profile should parse")
        .expect("profile should be configured");

        let configured = device_config_for_profile(&base, &profile);

        assert_eq!(base.device_type, "local");
        assert_eq!(configured.device_type, "remote");
        assert_eq!(configured.device_id, base.device_id);
        assert_eq!(configured.runtime_instance_id, base.runtime_instance_id);
    }
}
