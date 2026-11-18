// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_http_server::{AuthFailure, AuthRequest, Authenticator};
use serde::Serialize;

use crate::auth::{AppAuthenticator, bearer_credential};
use crate::socketio::auth::{API_KEY_PREFIX, AuthError, Identity, verify_personal_api_key};

struct DeviceApiKeyOwner(Identity);

impl Authenticator<DeviceApiKeyOwner> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: AuthRequest<'a>,
    ) -> Result<DeviceApiKeyOwner, AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        let token = personal_bearer_key(authorization)
            .ok_or_else(|| AuthFailure::invalid_credentials("Bearer"))?;
        verify_personal_api_key(&self.state().mysql, token)
            .await
            .map(DeviceApiKeyOwner)
            .map_err(|error| match error {
                AuthError::Refused(_) => AuthFailure::invalid_credentials("Bearer"),
                AuthError::StorageUnavailable => AuthFailure::Unavailable,
            })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a DeviceApiKeyOwner,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }
}

fn personal_bearer_key(authorization: Option<&str>) -> Option<&str> {
    bearer_credential(authorization).filter(|token| token.starts_with(API_KEY_PREFIX))
}

#[derive(Serialize)]
struct RuntimeOwner {
    id: i64,
}

#[brz_http_server::get("/api/devices/runtime-owner")]
async fn read_runtime_owner(#[auth] owner: DeviceApiKeyOwner) -> RuntimeOwner {
    RuntimeOwner {
        id: owner.0.user_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_owner_requires_a_personal_bearer_key() {
        assert_eq!(
            personal_bearer_key(Some("Bearer wg-example")),
            Some("wg-example")
        );
        for authorization in [
            None,
            Some("wg-example"),
            Some("Basic wg-example"),
            Some("Bearer wgr-workspace-runner"),
            Some("Bearer header.session.signature"),
        ] {
            assert_eq!(personal_bearer_key(authorization), None);
        }
    }
}
