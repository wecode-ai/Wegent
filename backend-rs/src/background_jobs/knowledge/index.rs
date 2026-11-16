// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Generation-guarded indexing with late-delete compensation.

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use brz_schedule::{Completion, HandlerOptions, JobContext};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{cleanup, gateway, state, store};
use crate::{
    AppState,
    background_jobs::{BackgroundJobRegistry, with_lock_watchdog},
};

pub const NAME: &str = "app.tasks.knowledge_tasks.index_document";

pub(crate) async fn dispatch_failed(
    state: &AppState,
    id: i64,
    generation: i64,
) -> brz_mysql::MysqlResult<()> {
    let error = super::state::processing_error(
        "dispatch",
        "index_dispatch_failed",
        "The indexing task could not be submitted. Please retry later.",
        generation,
        chrono::Utc::now(),
    );
    let transition = store::fail(&state.mysql, id, generation, error, false, false).await?;
    if let Some(document) = transition.document {
        cleanup::cleanup_replaced(state, document.user_id, transition.cleanup).await;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IndexPayload {
    #[serde(deserialize_with = "string_id")]
    pub knowledge_base_id: String,
    pub attachment_id: i64,
    pub retriever_name: String,
    #[serde(default = "default_namespace")]
    pub retriever_namespace: String,
    pub embedding_model_name: String,
    #[serde(default = "default_namespace")]
    pub embedding_model_namespace: String,
    pub user_id: i64,
    pub user_name: String,
    #[serde(default)]
    pub document_id: Option<i64>,
    #[serde(default)]
    pub index_generation: i64,
    #[serde(default)]
    pub splitter_config_dict: Option<Value>,
    #[serde(default = "default_true")]
    pub trigger_summary: bool,
    #[serde(default)]
    pub caller_user_id: Option<i64>,
}

fn default_namespace() -> String {
    "default".into()
}
fn default_true() -> bool {
    true
}
fn string_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<String, D::Error> {
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(value) => Ok(value),
        Value::Number(value) if value.is_i64() || value.is_u64() => Ok(value.to_string()),
        _ => Err(serde::de::Error::custom(
            "knowledge_base_id must be an integer or string",
        )),
    }
}

pub fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    registry.register_with_options(
        NAME,
        HandlerOptions {
            timeout: Some(Duration::from_secs(900)),
            retry_delay: Duration::from_secs(self::state::seconds(
                "KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS",
                15,
            ) as u64),
            max_retry_delay: Duration::from_secs(15),
        },
        move |context, value| {
            let state = state.clone();
            async move { run(&state, &context, serde_json::from_value(value)?).await }
        },
    )?;
    let failures = crate::config::env_or_dotenv("KNOWLEDGE_INDEX_LOCK_MAX_RETRIES")
        .map(|value| value.parse::<u32>())
        .transpose()?
        .unwrap_or(1)
        .checked_add(1)
        .context("knowledge index retry budget overflow")?;
    registry.max_failures(NAME, failures)
}

pub async fn run(
    state: &AppState,
    context: &JobContext,
    payload: IndexPayload,
) -> Result<Completion> {
    let Some(id) = payload.document_id else {
        // This legacy entry has no document row in which to persist a failure.
        return Ok(match perform(state, &payload).await {
            Ok(result) => Completion::Success(result),
            Err(error) => terminal_failure(&error),
        });
    };
    let locked = with_lock_watchdog(
        &state.background_jobs,
        context,
        &format!("wegent:lock:knowledge:index_document:{id}"),
        Duration::from_secs(
            self::state::seconds("KNOWLEDGE_INDEX_LOCK_TIMEOUT_SECONDS", 120) as u64,
        ),
        guarded(state, &payload),
    )
    .await?;
    if let Some(result) = locked {
        return Ok(result);
    }
    let max_retries = crate::config::env_or_dotenv("KNOWLEDGE_INDEX_LOCK_MAX_RETRIES")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1);
    if context.failures < max_retries {
        return Ok(retry("knowledge index lock is held"));
    }
    let error = state::processing_error(
        "indexing",
        "index_lock_timeout",
        "The document indexing task waited too long. Please retry.",
        payload.index_generation,
        Utc::now(),
    );
    fail(state, &payload, error).await?;
    match compensate_if_deleted(state, &payload).await {
        Ok(deleted) => Ok(Completion::Success(
            json!({"status":"skipped","reason":"lock_retry_exhausted","document_id":id,"deleted_late_index":deleted}),
        )),
        Err(error) => Ok(terminal_failure(&error)),
    }
}

async fn guarded(state: &AppState, payload: &IndexPayload) -> Result<Completion> {
    let id = payload
        .document_id
        .context("guarded indexing requires a document")?;
    let started = store::start(&state.mysql, id, payload.index_generation).await?;
    if !started.accepted {
        if started.reason == "document_not_found"
            && let Err(error) = compensate_if_deleted(state, payload).await
        {
            return Ok(retry(&format!("late index cleanup: {error}")));
        }
        return Ok(skipped(payload, started.reason));
    }
    match perform(state, payload).await {
        Ok(result) if result.get("status").and_then(Value::as_str) == Some("skipped") => {
            let error = state::processing_error(
                "indexing",
                "indexing_failed",
                "Document indexing failed. Please retry.",
                payload.index_generation,
                Utc::now(),
            );
            let finalized = fail(state, payload, error).await?;
            Ok(if finalized {
                Completion::Success(result)
            } else {
                skipped(payload, "stale_skip_result")
            })
        }
        Ok(mut result) => {
            let finalized = store::succeed(
                &state.mysql,
                id,
                payload.index_generation,
                result.get("chunks_data").cloned(),
                enabled("CHUNK_STORAGE_ENABLED", false),
            )
            .await?;
            if !finalized.accepted {
                if let Err(error) = compensate_if_deleted(state, payload).await {
                    return Ok(retry(&format!("late index cleanup: {error}")));
                }
                return Ok(skipped(payload, "stale_or_already_finalized"));
            }
            if let Some(document) = finalized.document {
                cleanup::cleanup_replaced(state, document.user_id, finalized.cleanup).await;
            }
            if payload.document_id.is_some()
                && payload.trigger_summary
                && enabled("SUMMARY_ENABLED", true)
                && let Err(error) = enqueue_summary(state, payload).await
            {
                tracing::warn!(document_id=id,%error,"document summary dispatch failed");
            }
            result["index_generation"] = payload.index_generation.into();
            Ok(Completion::Success(result))
        }
        Err(error) => {
            let finalized = fail(
                state,
                payload,
                gateway::processing_error(&error, payload.index_generation),
            )
            .await?;
            if !finalized {
                if let Err(error) = compensate_if_deleted(state, payload).await {
                    return Ok(retry(&format!("late index cleanup: {error}")));
                }
                return Ok(skipped(payload, "stale_failure"));
            }
            Ok(terminal_failure(&error))
        }
    }
}

async fn perform(state: &AppState, payload: &IndexPayload) -> Result<Value> {
    let (extension, size) = if let Some(id) = payload.document_id {
        store::load(&state.mysql, id)
            .await?
            .map(|doc| (doc.file_extension, doc.file_size))
            .unwrap_or_default()
    } else {
        crate::attachments::context_store::get_context_optional(&state.mysql, payload.attachment_id)
            .await?
            .map(|context| (context.file_extension(), context.file_size()))
            .unwrap_or_default()
    };
    if excel_too_large(&extension, size) {
        let normalized = format!(
            ".{}",
            extension
                .trim()
                .trim_start_matches('.')
                .to_ascii_lowercase()
        );
        let reason = format!(
            "EXCEL_FILE_SIZE_EXCEEDED|{normalized}|2|{:.2}",
            size as f64 / (1024.0 * 1024.0)
        );
        return Ok(
            json!({"status":"skipped","reason":reason,"document_id":payload.document_id,
            "knowledge_base_id":payload.knowledge_base_id,"indexed_count":0,"index_name":null}),
        );
    }
    gateway::index(state, payload).await
}

async fn compensate_if_deleted(state: &AppState, payload: &IndexPayload) -> Result<bool> {
    let Some(id) = payload.document_id else {
        return Ok(false);
    };
    if store::load(&state.mysql, id).await?.is_some() {
        return Ok(false);
    };
    let kb = crate::knowledge_documents_content::access::knowledge_base_record(
        &state.mysql,
        payload.knowledge_base_id.parse()?,
    )
    .await?
    .context("Knowledge base not found for late index cleanup")?;
    gateway::delete(state, kb.kinds_id, id, kb.kinds_user_id).await?;
    Ok(true)
}

async fn fail(state: &AppState, payload: &IndexPayload, error: Value) -> Result<bool> {
    let transition = store::fail(
        &state.mysql,
        payload.document_id.context("document required")?,
        payload.index_generation,
        error,
        false,
        false,
    )
    .await?;
    if let Some(document) = transition.document {
        cleanup::cleanup_replaced(state, document.user_id, transition.cleanup).await;
    }
    Ok(transition.accepted)
}

async fn enqueue_summary(state: &AppState, payload: &IndexPayload) -> Result<()> {
    let kb = crate::knowledge_documents_content::access::knowledge_base_record(
        &state.mysql,
        payload.knowledge_base_id.parse()?,
    )
    .await?
    .context("Knowledge base not found")?;
    if kb
        .kinds_json
        .to_value()
        .pointer("/spec/summaryEnabled")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok(());
    }
    let value = json!({"document_id":payload.document_id,"user_id":payload.user_id,"user_name":payload.user_name});
    if state.background_jobs.is_enabled(super::summary::DOCUMENT) {
        state
            .background_jobs
            .submit(super::summary::DOCUMENT, &value, None, None)
            .await?;
    } else {
        let redis = state
            .redis
            .as_ref()
            .context("Knowledge broker is unavailable")?;
        let id = super::super::client::random_id()?;
        state
            .celery
            .dispatch(
                redis,
                &crate::celery_broker::CeleryTask {
                    task_name: super::summary::DOCUMENT,
                    queue: "wegent_online",
                    task_id: &id,
                    kwargs: value.as_object().expect("summary payload object"),
                    expires_at: None,
                },
            )
            .await?;
    }
    Ok(())
}

pub(super) fn enabled(name: &str, default: bool) -> bool {
    crate::config::env_or_dotenv(name)
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on"))
        .unwrap_or(default)
}
fn excel_too_large(extension: &str, size: i64) -> bool {
    matches!(
        extension
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str(),
        "xls" | "xlsx"
    ) && size > 2 * 1024 * 1024
}
fn retry(error: &str) -> Completion {
    Completion::Failure {
        error: error.into(),
        retry_at_ms: Some(
            brz_schedule::now_ms()
                + state::seconds("KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS", 15) * 1000,
        ),
    }
}
fn terminal_failure(error: &anyhow::Error) -> Completion {
    Completion::Failure {
        error: format!("{error:#}"),
        retry_at_ms: None,
    }
}
fn skipped(payload: &IndexPayload, reason: &str) -> Completion {
    Completion::Success(
        json!({"status":"skipped","reason":reason,"document_id":payload.document_id,"knowledge_base_id":payload.knowledge_base_id,"index_generation":payload.index_generation}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excel_limit_is_strict_and_does_not_skip_other_documents() {
        assert!(!excel_too_large("xlsx", 2 * 1024 * 1024));
        assert!(excel_too_large(".XLSX", 2 * 1024 * 1024 + 1));
        assert!(!excel_too_large("pdf", 10 * 1024 * 1024));
    }
}
