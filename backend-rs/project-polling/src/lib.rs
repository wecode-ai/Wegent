// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project event polling and provider ingress normalization.

#![forbid(unsafe_code)]

#[path = "project_polling.rs"]
mod polling;
pub mod sources;

pub use polling::check;

/// Resume the gateway's incoming-event drain once a polled page has committed.
#[async_trait::async_trait]
pub trait PendingEvents: Send + Sync {
    async fn process_pending(&self) -> anyhow::Result<usize>;
}

pub struct PollingState<'a> {
    pub mysql: &'a brz_mysql::MysqlService,
    pub http: &'a brz_http::Client,
    pub credential_key: &'a str,
    pub pending_events: &'a dyn PendingEvents,
}
