// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The pooled transport owned by the LLM proxy route.

use anyhow::Context as _;
use brz_http::Client;

use super::REQUEST_TIMEOUT;

/// Builds the route's pooled client with LLM phase budgets and the shared TLS trust anchor.
pub(super) fn build_http() -> anyhow::Result<Client> {
    // A per-request total timeout does not override the client's phase timers.
    Client::builder()
        .connect_timeout(REQUEST_TIMEOUT)
        .read_timeout(REQUEST_TIMEOUT)
        .configure(|builder| match crate::http_trust::trust_anchor() {
            Some(anchor) => builder.add_root_certificate(anchor),
            None => builder,
        })
        .build()
        .context("failed to build the LLM proxy HTTP client")
}
