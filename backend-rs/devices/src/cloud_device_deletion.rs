// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_http_compat::FastApiError;

/// Destroys a sandbox by its provider-assigned ID. An already absent sandbox
/// counts as success so a request can retry the registration cleanup.
#[async_trait::async_trait]
pub trait CloudDeviceDestroyer: Send + Sync {
    async fn destroy(&self, record_id: i64, sandbox_id: &str) -> Result<(), FastApiError>;
}
