// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Knowledge processing jobs share the existing document generation state.

#![forbid(unsafe_code)]

mod cleanup;
mod gateway;
mod import;
mod index;
#[cfg(test)]
mod mysql_tests;
mod resources;
mod snapshot;
mod sources;
mod state;
mod store;
mod summary;
mod sync;

use std::{sync::Arc, time::Duration};

use anyhow::Result;
use chrono::Utc;
use serde_json::{Value, json};

use wegent_access::permissions::EntityResolvers;
use wegent_attachments as attachments;
use wegent_attachments::{AttachmentUploadBackend, UploadServices};
use wegent_backend_config as config;
use wegent_celery as celery_broker;
use wegent_execution_runtime::background_chat::BackgroundChatExecutor;
use wegent_job_runtime::{
    self as background_jobs, BackgroundJobRegistry, BackgroundJobsClient, with_lock_watchdog,
};
use wegent_knowledge::knowledge_documents_content;
use wegent_mcp_providers::mcp_providers;
use wegent_network_policy::http_trust;

pub use index::{NAME as INDEX_JOB, dispatch_failed};

pub struct KnowledgeJobState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub background_jobs: BackgroundJobsClient,
    pub attachment_upload: Arc<dyn AttachmentUploadBackend>,
    pub entity_resolvers: EntityResolvers,
    pub celery: celery_broker::CeleryBroker,
    pub jwt_key: String,
    pub jwt_algorithm: String,
    pub attachment_http: brz_http::Client,
    pub chat: Arc<dyn BackgroundChatExecutor>,
}

impl KnowledgeJobState {
    fn upload_services(&self) -> UploadServices<'_> {
        UploadServices {
            mysql: &self.mysql,
            attachment_upload: &self.attachment_upload,
        }
    }
}

pub const STALE_SCAN: &str = "app.tasks.knowledge_tasks.scan_stale_index_tasks";
pub const ORPHAN_CLEANUP: &str = "app.tasks.knowledge_tasks.cleanup_knowledge_attachment_orphans";

pub fn register(registry: &mut BackgroundJobRegistry, state: Arc<KnowledgeJobState>) -> Result<()> {
    index::register(registry, state.clone())?;
    summary::register(registry, state.clone())?;
    import::register(registry, state.clone())?;
    sync::register(registry, state.clone())?;
    let scan_state = state.clone();
    registry.register(STALE_SCAN, move |context, _| {
        let state = scan_state.clone();
        async move { scan_stale(&state, &context).await }
    })?;
    registry.max_failures(STALE_SCAN, 1)?;
    registry.fixed_rate(STALE_SCAN, Duration::from_secs(300), false)?;
    registry.register(ORPHAN_CLEANUP, move |context, _| {
        let state = state.clone();
        async move {
            let lease = Duration::from_secs(state::seconds(
                "KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_INTERVAL_SECONDS",
                3600,
            ) as u64);
            Ok(with_lock_watchdog(
                &state.background_jobs,
                &context,
                "wegent:lock:knowledge-attachment-orphan-cleanup",
                lease,
                cleanup::scan(&state, &context),
            )
            .await?
            .unwrap_or_else(|| json!({"status":"locked"})))
        }
    })?;
    registry.max_failures(ORPHAN_CLEANUP, 1)?;
    registry.fixed_rate(
        ORPHAN_CLEANUP,
        Duration::from_secs(state::seconds(
            "KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_INTERVAL_SECONDS",
            3600,
        ) as u64),
        false,
    )
}

async fn scan_stale(
    state: &KnowledgeJobState,
    context: &brz_schedule::JobContext,
) -> Result<Value> {
    let documents = store::active_attempts(&state.mysql).await?;
    let scanned = documents.len();
    let thresholds = state::StaleThresholds::from_env();
    let mut marked = 0;
    for document in documents {
        if context.cancellation.is_cancelled() {
            anyhow::bail!("stale index scan cancelled");
        }
        if !thresholds.expired(&document.index_status, document.age_seconds) {
            continue;
        }
        let error = state::timeout_error(
            &document.index_status,
            document.index_generation,
            Utc::now(),
        );
        let transition = store::fail(
            &state.mysql,
            document.id,
            document.index_generation,
            error,
            false,
            true,
        )
        .await?;
        if transition.accepted {
            marked += 1;
            if let Some(document) = transition.document {
                cleanup::cleanup_replaced(
                    &state.upload_services(),
                    document.user_id,
                    transition.cleanup,
                )
                .await;
            }
        }
    }
    Ok(json!({"marked_count":marked,"scanned_count":scanned}))
}
