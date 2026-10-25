// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use std::sync::atomic::Ordering;

use super::{AppIpcError, LocalBackendConnectionController};

fn required_profile_field<'a>(params: &'a Value, name: &str) -> Result<&'a str, AppIpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppIpcError::new(
                "invalid_params",
                "Plugin route requires a connection profile",
            )
        })
}

impl LocalBackendConnectionController {
    /// Resolve only plugin targeting; never reconfigure or expose the credentials.
    pub(super) async fn resolve_plugin_device_route(
        &self,
        params: Value,
    ) -> Result<Value, AppIpcError> {
        let backend_url = required_profile_field(&params, "backend_url")?.trim_end_matches('/');
        let auth_token = required_profile_field(&params, "auth_token")?;
        let device_id = required_profile_field(&params, "device_id")?;
        let unavailable = || {
            AppIpcError::new(
                "plugin_route_unavailable",
                "Plugin Runtime is not registered for this connection",
            )
        };
        // Profile replacement holds this same lock while stopping its old route
        // producer. Capture the route together with the expected HTTP profile.
        let state = self.state.lock().await;
        let profile = state.profile.as_ref().ok_or_else(unavailable)?;
        if profile.connection.backend_url != backend_url
            || profile.connection.auth_token != auth_token
            || self.base_config.device_id != device_id
        {
            return Err(AppIpcError::new(
                "plugin_route_profile_mismatch",
                "Plugin Runtime connection does not match the requested profile",
            ));
        }
        let route = self.device_route_id.lock().map_err(|_| unavailable())?;
        if !self.connection_status.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let route = route
            .as_deref()
            .map(str::trim)
            .filter(|route| !route.is_empty())
            .ok_or_else(unavailable)?;
        Ok(json!({"device_id": device_id, "device_route_id": route}))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use std::sync::atomic::Ordering;

    use super::super::{LocalBackendConnectionController, LocalBackendConnectionProfile};
    use crate::{
        config::device::{ConnectionConfig, DeviceConfig},
        local::app_ipc::{AppIpcError, AppIpcServer},
    };

    async fn registered_controller() -> LocalBackendConnectionController {
        let controller = LocalBackendConnectionController::start(DeviceConfig {
            device_id: "stable-desktop".to_owned(),
            ..DeviceConfig::default()
        })
        .await;
        controller.state.lock().await.profile = Some(LocalBackendConnectionProfile {
            connection: ConnectionConfig {
                backend_url: "https://backend-a.example".to_owned(),
                auth_token: "secret-account-a".to_owned(),
                ..ConnectionConfig::default()
            },
            registration_device_type: Some("app".to_owned()),
        });
        *controller.device_route_id.lock().unwrap() = Some("app-record-70".to_owned());
        controller.connection_status.store(true, Ordering::Release);
        controller
    }

    fn request() -> Value {
        json!({
            "backend_url": "https://backend-a.example/",
            "auth_token": "secret-account-a",
            "device_id": "stable-desktop",
        })
    }

    async fn query(
        controller: &LocalBackendConnectionController,
        params: Value,
    ) -> Result<Value, AppIpcError> {
        AppIpcServer::new()
            .with_backend_connection_handler(controller.clone())
            .dispatch("executor.plugins.device_route", params)
            .await
    }

    #[tokio::test]
    async fn plugin_route_is_scoped_to_the_registered_backend_account_and_device() {
        let controller = registered_controller().await;
        assert_eq!(
            query(&controller, request()).await.unwrap(),
            json!({"device_id": "stable-desktop", "device_route_id": "app-record-70"})
        );
        for (field, value) in [
            ("backend_url", "https://backend-b.example"),
            ("auth_token", "secret-account-b"),
            ("device_id", "another-desktop"),
        ] {
            let mut params = request();
            params[field] = json!(value);
            let error = query(&controller, params).await.unwrap_err();
            assert_eq!(error.code, "plugin_route_profile_mismatch");
            assert!(!error.message.contains(value));
        }
    }

    #[tokio::test]
    async fn plugin_route_requires_a_ready_registration_without_changing_stable_identity() {
        let controller = registered_controller().await;
        controller.connection_status.store(false, Ordering::Release);
        assert_eq!(
            query(&controller, request()).await.unwrap_err().code,
            "plugin_route_unavailable"
        );
        controller.connection_status.store(true, Ordering::Release);
        *controller.device_route_id.lock().unwrap() = None;
        assert_eq!(
            query(&controller, request()).await.unwrap_err().code,
            "plugin_route_unavailable"
        );
        *controller.device_route_id.lock().unwrap() = Some("app-record-95".to_owned());
        let response = query(&controller, request()).await.unwrap();
        assert_eq!(response["device_route_id"], "app-record-95");
        assert_eq!(response["device_id"], "stable-desktop");
        assert!(!response.to_string().contains("secret-account"));
        controller.state.lock().await.profile = None;
        assert_eq!(
            query(&controller, request()).await.unwrap_err().code,
            "plugin_route_unavailable"
        );
    }

    #[tokio::test]
    async fn plugin_route_rejects_an_old_api_after_account_replacement() {
        let controller = registered_controller().await;
        let old_request = request();
        controller
            .state
            .lock()
            .await
            .profile
            .as_mut()
            .unwrap()
            .connection
            .auth_token = "secret-account-b".to_owned();
        *controller.device_route_id.lock().unwrap() = Some("app-record-95".to_owned());
        assert_eq!(
            query(&controller, old_request).await.unwrap_err().code,
            "plugin_route_profile_mismatch"
        );
        let mut new_request = request();
        new_request["auth_token"] = json!("secret-account-b");
        assert_eq!(
            query(&controller, new_request).await.unwrap()["device_route_id"],
            "app-record-95"
        );
    }

    #[tokio::test]
    async fn plugin_route_rejects_missing_profile_fields_and_is_advertised_by_ipc() {
        let controller = registered_controller().await;
        for field in ["backend_url", "auth_token", "device_id"] {
            let mut params = request();
            params.as_object_mut().unwrap().remove(field);
            assert_eq!(
                query(&controller, params).await.unwrap_err().code,
                "invalid_params"
            );
        }
        let description = AppIpcServer::new()
            .dispatch("executor.protocol.describe", json!({}))
            .await
            .unwrap();
        assert!(description["renderer_methods"]
            .as_array()
            .unwrap()
            .contains(&json!("executor.plugins.device_route")));
    }
}
