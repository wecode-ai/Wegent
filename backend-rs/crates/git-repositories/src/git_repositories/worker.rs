// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `_fetch_all_repositories_async` background worker.
//!
//! Each provider schedules a full refresh when a live page came back full.
//! The source starts those with `asyncio.create_task`, so the target uses one
//! process-owned worker started at service construction: request handlers only
//! admit a job into the bounded queue and return.
use std::sync::Arc;

use brz_http::Client;
use tokio::sync::mpsc;

use crate::git_repositories::cache::RepositoryCache;
use crate::git_repositories::providers::{self, RefreshRequest};

/// Drain accepted refresh jobs for the process lifetime. The worker ends when
/// the service (its only `Sender` owner) is dropped.
pub(crate) async fn run(
    cache: Arc<dyn RepositoryCache>,
    client: Client,
    mut receiver: mpsc::Receiver<RefreshRequest>,
) {
    while let Some(request) = receiver.recv().await {
        providers::refresh(&client, cache.as_ref(), &request).await;
    }
}
