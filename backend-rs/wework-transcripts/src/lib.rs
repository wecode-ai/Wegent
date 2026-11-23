// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework transcript leases, segments, and archives.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_backend_config as config;
use wegent_http_compat as http_compat;
use wegent_identity::auth::{self, AppAuthenticator};
use wegent_python_compat::json_compat;

mod wework_transcript_archive_storage;
mod wework_transcript_encryption;
mod wework_transcript_lease_release;
mod wework_transcript_lease_transaction;
mod wework_transcript_segment_manifest;
mod wework_transcripts;
mod wework_transcripts_lease;
mod wework_transcripts_segments;

/// Process-owned services used by the transcript endpoints.
pub struct TranscriptState {
    pub mysql: brz_mysql::MysqlService,
    pub archive_http: brz_http::Client,
    pub jwt_key: String,
}

brz_http_server::registry!(
    dependencies(state: Arc<TranscriptState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<TranscriptState>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

/// Registered paths and HTTP methods for gateway ownership verification.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_http_apis::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
