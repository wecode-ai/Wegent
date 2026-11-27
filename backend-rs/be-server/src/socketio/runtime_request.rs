// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Gateway adapter for verified Runtime namespace requests.

use brz_socket_io::ClientError;
use serde_json::Value;
use wegent_runtime_work::{Ownership, RuntimeRequestIdentity};

use crate::runtime_work::request_services;
use crate::state::AppState;

use super::auth::Identity;

pub(super) async fn handle(
    app: &AppState,
    identity: &Identity,
    credential_expires_at: Option<i64>,
    ownership: &Ownership,
    data: Value,
) -> Result<Value, ClientError> {
    wegent_runtime_work::handle_runtime_request(
        &request_services(app),
        RuntimeRequestIdentity {
            user_id: identity.user_id,
            user_name: &identity.user_name,
            email: identity.email.as_deref(),
            credential_expires_at,
        },
        ownership,
        data,
    )
    .await
}

pub(super) async fn sync_runtime_auth_file(
    app: &AppState,
    user_id: i64,
    device_id: &str,
    runtime: &str,
    content: &str,
) -> bool {
    wegent_runtime_work::sync_runtime_auth_file(
        &request_services(app),
        user_id,
        device_id,
        runtime,
        content,
    )
    .await
}
