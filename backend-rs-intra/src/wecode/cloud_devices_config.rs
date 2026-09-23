//! Cloud device configuration for `GET /api/cloud-devices/config`.
//!
//! Mirrors `wecode.api.cloud_devices.get_cloud_device_config` (router prefix
//! `/cloud-devices`, mounted under the app prefix `/api`): authenticate the
//! bearer token, then return the current cloud-device configuration and
//! limits. The source builds the body from the process-lifetime Nevis client
//! singleton and `nevis_settings`:
//!
//! - `enabled`: `cloud_device_provider.is_configured()`, which delegates to
//!   `nevis_client.is_configured()` — true when `NEVIS_BASE_URL`,
//!   `NEVIS_MANAGER_ID`, `NEVIS_IMAGE_ID`, and `NEVIS_SIGNATURE` are all
//!   non-empty (`wecode.service.nevis_client.NevisClient.is_configured`,
//!   `wecode.service.cloud_device_provider.CloudDeviceProvider.is_configured`).
//! - `max_devices_per_user`: `nevis_settings.NEVIS_MAX_DEVICES_PER_USER`
//!   (`wecode.config.nevis_config.NevisSettings`, pydantic default `1`).
//! - `can_create`: the literal `True`.
//!
//! The endpoint has no `response_model`, so FastAPI serializes the returned
//! dict directly; field order follows dict insertion order
//! (`enabled`, `max_devices_per_user`, `can_create`).
use serde::Serialize;

use wegent_backend_rs::auth::SessionUser;
use wegent_backend_rs::config::env_or_dotenv;

/// `NEVIS_MAX_DEVICES_PER_USER` pydantic default
/// (`wecode.config.nevis_config.NevisSettings`).
const NEVIS_MAX_DEVICES_PER_USER_DEFAULT: i64 = 1;

/// Response body for `GET /api/cloud-devices/config`
/// (`wecode.api.cloud_devices.get_cloud_device_config`). Field order matches
/// the source dict insertion order.
#[derive(Debug, Serialize)]
struct CloudDeviceConfigResponse {
    /// `cloud_device_provider.is_configured()`.
    enabled: bool,
    /// `nevis_settings.NEVIS_MAX_DEVICES_PER_USER`.
    max_devices_per_user: i64,
    /// Source literal `True`.
    can_create: bool,
}

/// Read `NEVIS_MAX_DEVICES_PER_USER` (integer, pydantic default `1`).
fn nevis_max_devices_per_user() -> i64 {
    parse_nevis_max_devices(env_or_dotenv("NEVIS_MAX_DEVICES_PER_USER").as_deref())
}

fn parse_nevis_max_devices(value: Option<&str>) -> i64 {
    value
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(NEVIS_MAX_DEVICES_PER_USER_DEFAULT)
}

/// `NevisClient.is_configured`: true when all four required settings are
/// present and non-empty
/// (`wecode.service.nevis_client.NevisClient.is_configured`).
fn nevis_is_configured() -> bool {
    nevis_settings_configured([
        env_or_dotenv("NEVIS_BASE_URL"),
        env_or_dotenv("NEVIS_MANAGER_ID"),
        env_or_dotenv("NEVIS_IMAGE_ID"),
        env_or_dotenv("NEVIS_SIGNATURE"),
    ])
}

fn nevis_settings_configured(settings: [Option<String>; 4]) -> bool {
    settings.iter().all(Option::is_some)
}

/// GET /api/cloud-devices/config: the authenticated config route.
#[brz_http_server::get("/api/cloud-devices/config", group = crate::wecode::startup::wecode_apis)]
async fn get_cloud_device_config(#[auth] _user: SessionUser) -> CloudDeviceConfigResponse {
    cloud_device_config()
}

/// Handler body for `GET /api/cloud-devices/config`.
fn cloud_device_config() -> CloudDeviceConfigResponse {
    CloudDeviceConfigResponse {
        enabled: nevis_is_configured(),
        max_devices_per_user: nevis_max_devices_per_user(),
        can_create: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_devices_default_is_one() {
        assert_eq!(NEVIS_MAX_DEVICES_PER_USER_DEFAULT, 1);
    }

    #[test]
    fn is_configured_reads_all_four_nevis_settings() {
        let configured = [
            Some("http://cloud.nevis.example".to_owned()),
            Some("manager-1".to_owned()),
            Some("image-1".to_owned()),
            Some("sig-1".to_owned()),
        ];
        assert!(nevis_settings_configured(configured.clone()));
        for missing in 0..configured.len() {
            let mut settings = configured.clone();
            settings[missing] = None;
            assert!(!nevis_settings_configured(settings));
        }
    }

    #[test]
    fn max_devices_parses_override() {
        assert_eq!(parse_nevis_max_devices(Some("3")), 3);
        assert_eq!(
            parse_nevis_max_devices(None),
            NEVIS_MAX_DEVICES_PER_USER_DEFAULT
        );
    }
}
