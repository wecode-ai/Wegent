// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Claim, fetch and land one external body without holding a DB lease over I/O.

use super::{
    cleanup,
    index::IndexPayload,
    sources::{self, Content, Identity, SourceError},
    store,
};
use crate::{AppState, background_jobs::BackgroundJobRegistry};
use anyhow::{Context, Result};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use brz_schedule::HandlerOptions;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, sync::Arc, time::Duration};

pub const NAME: &str = "app.tasks.knowledge_tasks.import_external_document";
#[derive(Deserialize)]
struct Input {
    document_id: i64,
    expected_generation: i64,
}

pub fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    registry.register_with_options(
        NAME,
        HandlerOptions {
            timeout: Some(Duration::from_secs(900)),
            retry_delay: Duration::from_secs(30),
            max_retry_delay: Duration::from_secs(30),
        },
        move |context, value| {
            let state = state.clone();
            async move {
                let input: Input = serde_json::from_value(value)?;
                run(
                    &state,
                    input.document_id,
                    input.expected_generation,
                    &context.job_id,
                )
                .await
                .map(brz_schedule::Completion::Success)
            }
        },
    )?;
    registry.max_failures(NAME, 1)
}

pub async fn run(state: &Arc<AppState>, id: i64, expected: i64, job_id: &str) -> Result<Value> {
    let claim = store::claim_import_for_job(&state.mysql, id, expected, job_id).await?;
    let Some(document) = claim.document.filter(|_| claim.accepted) else {
        return Ok(json!({"status":"skipped","reason":claim.reason}));
    };
    let generation = document.generation;
    let outcome = run_claimed(state, id, generation).await;
    match outcome {
        Ok(landed) => Ok(
            json!({"status":if landed{"success"}else{"skipped"},"document_id":id,"index_generation":generation}),
        ),
        Err(error) => {
            let source = error.downcast_ref::<SourceError>();
            let code = source
                .map(|source| source.code)
                .unwrap_or("external_import_failed");
            let message = source
                .map(|source| source.message.as_str())
                .unwrap_or("The external document could not be imported. Please retry later.");
            let mut public =
                super::state::processing_error("system", code, message, generation, Utc::now());
            public["retryable"] = source.is_none_or(|source| source.retryable).into();
            public["provider"] = document
                .external()
                .get("provider")
                .cloned()
                .unwrap_or(Value::Null);
            let failure = store::fail_import(&state.mysql, id, generation, public).await?;
            if let Some(document) = failure.document {
                cleanup::cleanup_replaced(state, document.user_id, failure.cleanup).await;
            }
            tracing::warn!(
                document_id = id,
                index_generation = generation,
                error_code = code,
                "external document import failed"
            );
            Ok(json!({"status":"failed","document_id":id,"error_code":code}))
        }
    }
}

async fn run_claimed(state: &Arc<AppState>, id: i64, generation: i64) -> Result<bool> {
    let identity = sources::identity(state, id)
        .await?
        .context("External source or its active owner no longer exists")?;
    let content = sources::fetch(state, &identity).await?;
    let extension = content.extension.trim_start_matches('.');
    let filename = if content
        .name
        .to_ascii_lowercase()
        .ends_with(&format!(".{extension}"))
    {
        content.name.clone()
    } else {
        format!("{}.{extension}", content.name)
    };
    let attachment = crate::attachments::upload::upload_attachment_context(
        state,
        identity.user_id,
        &filename,
        &content.bytes,
        0,
        (identity.external_provider == "wiki").then_some("external_wiki_sync"),
    )
    .await
    .map_err(|_| anyhow::anyhow!("External attachment upload failed"))?;
    let landed = land(state, &identity, generation, attachment, &content).await;
    match landed {
        Ok(Some(cleanup_ids)) => {
            cleanup::cleanup_replaced(state, identity.user_id, cleanup_ids).await;
            if !schedule_index(state, &identity, generation, true).await? {
                let error = super::state::processing_error(
                    "dispatch",
                    "external_import_index_not_scheduled",
                    "External document indexing could not be started. Please retry.",
                    generation,
                    Utc::now(),
                );
                store::fail(&state.mysql, id, generation, error, false, false).await?;
            }
            Ok(true)
        }
        Ok(None) => {
            cleanup::cleanup_replaced(state, identity.user_id, BTreeSet::from([attachment])).await;
            Ok(false)
        }
        Err(error) => {
            cleanup::cleanup_replaced(state, identity.user_id, BTreeSet::from([attachment])).await;
            Err(error)
        }
    }
}

async fn land(
    state: &AppState,
    identity: &Identity,
    generation: i64,
    attachment: i64,
    content: &Content,
) -> Result<Option<BTreeSet<i64>>> {
    #[derive(FromMysqlRow)]
    struct Current {
        attachment_id: i64,
        source_config: Json<Map<String, Value>>,
    }
    Ok(state.mysql.with_transaction(async |tx|{
        let current:Option<Current>=tx.fetch_optional("SELECT d.attachment_id,COALESCE(NULLIF(d.source_config,CAST('null' AS JSON)),JSON_OBJECT()) AS source_config FROM knowledge_documents d JOIN knowledge_document_external_sources e ON e.document_id=d.id WHERE d.id=? AND d.user_id=? AND d.index_generation=? AND e.external_provider=? AND e.external_resource_id=? FOR UPDATE",(identity.id,identity.user_id,generation,identity.external_provider.as_str(),identity.external_resource_id.as_str())).await?;
        let Some(current)=current else{return Ok(None)};
        let mut config=current.source_config.0;
        let old_converted=config.get("converted_attachment_id").and_then(Value::as_i64).unwrap_or_default();
        let has_snapshot=config.get(super::snapshot::SNAPSHOT_KEY).and_then(|snapshot|snapshot.get("generation")).and_then(Value::as_i64)==Some(generation);
        merge_content(&mut config,content,generation,attachment);
        let follow=identity.external_provider=="dingtalk"||config.get("external").and_then(|external|external.pointer("/sync/enabled")).and_then(Value::as_bool)==Some(true);
        let name=if follow&&!content.name.trim().is_empty(){Some(content.name.chars().take(255).collect::<String>())}else{None};
        tx.execute("UPDATE knowledge_documents SET attachment_id=?,file_extension=?,file_size=?,source_config=?,name=COALESCE(?,name),updated_at=NOW() WHERE id=? AND index_generation=?",(attachment,content.extension.as_str(),content.bytes.len() as i64,Json(&config),name,identity.id,generation)).await?;
        Ok(Some(if has_snapshot{BTreeSet::new()}else{BTreeSet::from([current.attachment_id,old_converted]).into_iter().filter(|id|*id>0&&*id!=attachment).collect()}))
    }).await?)
}

fn merge_content(
    config: &mut Map<String, Value>,
    content: &Content,
    generation: i64,
    attachment: i64,
) {
    let mut external = config
        .get("external")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let previous = external
        .get("sync")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    external.extend(content.metadata.clone());
    if let Some(incoming) = external.get("sync").and_then(Value::as_object) {
        let mut sync = previous;
        sync.extend(incoming.clone());
        sync.remove("last_error_code");
        external.insert("sync".into(), sync.into());
    }
    external.insert("status".into(), "accessible".into());
    external.remove("last_error");
    config.insert("external".into(), external.into());
    config.remove("converted_attachment_id");
    if let Some(snapshot) = config
        .get_mut(super::snapshot::SNAPSHOT_KEY)
        .and_then(Value::as_object_mut)
        && snapshot.get("generation").and_then(Value::as_i64) == Some(generation)
    {
        snapshot.insert("staged_attachment_id".into(), attachment.into());
    }
}

/// The index owner's credentials are resolved from the KB, not the source owner.
pub async fn schedule_index(
    state: &AppState,
    identity: &Identity,
    expected: i64,
    replace: bool,
) -> Result<bool> {
    let kb = crate::knowledge_documents_content::access::knowledge_base_record(
        &state.mysql,
        identity.kind_id,
    )
    .await?
    .context("Knowledge base no longer exists")?;
    let config = kb.kinds_json.to_value();
    let retrieval = &config["spec"]["retrievalConfig"];
    let retriever = retrieval["retriever_name"]
        .as_str()
        .filter(|name| !name.is_empty());
    let embedding = retrieval["embedding_config"]["model_name"]
        .as_str()
        .filter(|name| !name.is_empty());
    let (Some(retriever), Some(embedding)) = (retriever, embedding) else {
        return Ok(false);
    };
    let prepared =
        store::enqueue(&state.mysql, identity.id, Some(expected), replace, false).await?;
    let Some(document) = prepared.document.filter(|_| prepared.accepted) else {
        return Ok(false);
    };
    let payload = IndexPayload {
        knowledge_base_id: identity.kind_id.to_string(),
        attachment_id: document.converted_id().unwrap_or(document.attachment_id),
        retriever_name: retriever.into(),
        retriever_namespace: retrieval["retriever_namespace"]
            .as_str()
            .unwrap_or("default")
            .into(),
        embedding_model_name: embedding.into(),
        embedding_model_namespace: retrieval["embedding_config"]["model_namespace"]
            .as_str()
            .unwrap_or("default")
            .into(),
        user_id: identity.user_id,
        user_name: identity.user_name.clone(),
        document_id: Some(identity.id),
        index_generation: document.generation,
        splitter_config_dict: None,
        trigger_summary: true,
        caller_user_id: None,
    };
    let value = serde_json::to_value(&payload)?;
    let extension = document
        .file_extension
        .trim_start_matches('.')
        .to_lowercase();
    let converted = document.converted_id().is_some();
    let needs_conversion = super::index::enabled("KNOWLEDGE_CONVERSION_ENABLED", false)
        && crate::config::env_or_dotenv("KNOWLEDGE_CONVERSION_FILE_TYPES")
            .unwrap_or_default()
            .split(',')
            .any(|candidate| {
                candidate
                    .trim()
                    .trim_start_matches('.')
                    .eq_ignore_ascii_case(&extension)
            });
    let result = if needs_conversion && !converted {
        dispatch_conversion(state, identity, &extension, &value, document.generation).await
    } else {
        dispatch_index(state, &value).await
    };
    if let Err(error) = result {
        let failure = super::state::processing_error(
            "dispatch",
            "processing_failed",
            "Document processing failed. Please retry.",
            document.generation,
            Utc::now(),
        );
        let transition = store::fail(
            &state.mysql,
            identity.id,
            document.generation,
            failure,
            false,
            false,
        )
        .await?;
        cleanup::cleanup_replaced(state, identity.user_id, transition.cleanup).await;
        return Err(error);
    }
    Ok(true)
}

async fn dispatch_index(state: &AppState, value: &Value) -> Result<()> {
    if state.background_jobs.is_enabled(super::index::NAME) {
        state
            .background_jobs
            .submit(super::index::NAME, value, None, None)
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
                    task_name: super::index::NAME,
                    queue: "wegent_online",
                    task_id: &id,
                    kwargs: value
                        .as_object()
                        .context("Index dispatch payload must be an object")?,
                    expires_at: None,
                },
            )
            .await?;
    }
    Ok(())
}

async fn dispatch_conversion(
    state: &AppState,
    identity: &Identity,
    extension: &str,
    index: &Value,
    generation: i64,
) -> Result<()> {
    let attachment = index["attachment_id"]
        .as_i64()
        .context("Attachment is missing")?;
    let context = crate::attachments::context_store::get_context_optional_with_user(
        &state.mysql,
        attachment,
        identity.user_id,
    )
    .await?
    .context("Conversion attachment is missing")?;
    let kb = crate::knowledge_documents_content::access::knowledge_base_record(
        &state.mysql,
        identity.kind_id,
    )
    .await?
    .context("Knowledge base is missing")?;
    let kb_name = kb
        .kinds_json
        .to_value()
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let payload = json!({"document_id":identity.id,"attachment_id":attachment,"file_extension":format!(".{extension}"),"original_filename":context.original_filename(),"knowledge_base_name":kb_name,"index_generation":generation,
        "content_download_path":format!("/api/internal/attachments/{attachment}/download"),"callback_status_path":"/api/internal/conversion/callback/status","callback_completed_path":"/api/internal/conversion/callback/completed","index_dispatch_payload":index});
    state.mysql.with_transaction(async |tx|{tx.execute("UPDATE knowledge_documents SET index_status='pending_conversion',updated_at=NOW() WHERE id=? AND index_generation=? AND index_status='queued'",(identity.id,generation)).await?;Ok(())}).await?;
    let redis = state
        .redis
        .as_ref()
        .context("Knowledge conversion broker is unavailable")?;
    let id = super::super::client::random_id()?;
    let queue = crate::config::env_or_dotenv("KNOWLEDGE_CONVERSION_QUEUE")
        .unwrap_or_else(|| "knowledge_conversion".into());
    state
        .celery
        .dispatch(
            redis,
            &crate::celery_broker::CeleryTask {
                task_name: "knowledge_doc_converter.convert_document",
                queue: &queue,
                task_id: &id,
                kwargs: payload
                    .as_object()
                    .context("Conversion payload must be an object")?,
                expires_at: None,
            },
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn body_landing_preserves_sync_policy_and_user_folder_metadata() {
        let mut config=json!({"folder":"user","converted_attachment_id":5,"external":{"sync":{"enabled":true,"indexed_version":"old","last_error_code":"failed"}},"_pending_external_refresh":{"generation":8}}).as_object().unwrap().clone();
        let content = Content {
            name: "new".into(),
            extension: "md".into(),
            bytes: vec![],
            metadata: json!({"sync":{"content_version":"new"}})
                .as_object()
                .unwrap()
                .clone(),
        };
        merge_content(&mut config, &content, 8, 9);
        assert_eq!(config["folder"], "user");
        assert_eq!(config["external"]["sync"]["indexed_version"], "old");
        assert!(config["external"]["sync"].get("last_error_code").is_none());
        assert!(!config.contains_key("converted_attachment_id"));
        assert_eq!(
            config["_pending_external_refresh"]["staged_attachment_id"],
            9
        );
    }
}
