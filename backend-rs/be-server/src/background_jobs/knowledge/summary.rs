// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Document summaries and row-locked knowledge-base summary debouncing.

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use brz_schedule::HandlerOptions;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

use super::index::enabled;
use crate::{
    AppState,
    background_jobs::{
        BackgroundJobRegistry,
        execution::{self, BackgroundChat},
    },
};

pub const DOCUMENT: &str = "app.tasks.knowledge_tasks.generate_document_summary";
pub const KNOWLEDGE_BASE: &str = "app.tasks.knowledge_tasks.update_kb_summary";
const DOCUMENT_PROMPT: &str = include_str!("prompts/document_summary.txt");
const KB_PROMPT: &str = include_str!("prompts/kb_summary.txt");

#[derive(Deserialize)]
struct DocumentInput {
    document_id: i64,
    user_id: i64,
    user_name: String,
}
#[derive(Deserialize)]
struct KbInput {
    knowledge_base_id: i64,
    user_id: i64,
    user_name: String,
}
#[derive(FromMysqlRow)]
struct Kb {
    id: i64,
    json: Json<Value>,
}
#[derive(FromMysqlRow)]
struct Document {
    id: i64,
    kind_id: i64,
    name: String,
    is_active: i8,
    summary: Option<Json<Value>>,
}

pub fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    let copy = state.clone();
    registry.register_with_options(
        DOCUMENT,
        HandlerOptions {
            timeout: Some(Duration::from_secs(900)),
            retry_delay: Duration::from_secs(30),
            max_retry_delay: Duration::from_secs(300),
        },
        move |_, value| {
            let state = copy.clone();
            async move {
                document(&state, serde_json::from_value(value)?)
                    .await
                    .map(brz_schedule::Completion::Success)
            }
        },
    )?;
    registry.max_failures(DOCUMENT, 4)?;
    registry.register_with_options(
        KNOWLEDGE_BASE,
        HandlerOptions {
            timeout: Some(Duration::from_secs(900)),
            retry_delay: Duration::from_secs(30),
            max_retry_delay: Duration::from_secs(30),
        },
        move |_, value| {
            let state = state.clone();
            async move {
                let input: KbInput = serde_json::from_value(value)?;
                if !enabled("SUMMARY_ENABLED", true) {
                    return Ok(brz_schedule::Completion::Success(
                        json!({"status":"skipped","reason":"global_summary_disabled"}),
                    ));
                }
                knowledge_base(
                    &state,
                    input.knowledge_base_id,
                    input.user_id,
                    &input.user_name,
                )
                .await?;
                Ok(brz_schedule::Completion::Success(
                    json!({"status":"success","knowledge_base_id":input.knowledge_base_id}),
                ))
            }
        },
    )?;
    registry.max_failures(KNOWLEDGE_BASE, 3)
}

async fn kb(state: &AppState, id: i64) -> Result<Option<Kb>> {
    Ok(state
        .mysql
        .fetch_optional(
            "SELECT id,json FROM kinds WHERE id=? AND kind='KnowledgeBase'",
            (id,),
        )
        .await?)
}

async fn model(state: &AppState, kb: &Kb, user_id: i64, user_name: &str) -> Result<Option<Value>> {
    let Some(reference) = kb.json.0.pointer("/spec/summaryModelRef") else {
        return Ok(None);
    };
    let Some(name) = reference
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    else {
        return Ok(None);
    };
    let namespace = reference
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let kind = reference
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("public");
    #[derive(FromMysqlRow)]
    struct Model {
        json: Json<Value>,
    }
    let row:Option<Model>=match kind {
        "public"=>state.mysql.fetch_optional("SELECT json FROM kinds WHERE kind='Model' AND user_id=0 AND name=? AND namespace='default' AND is_active=true LIMIT 1",(name,)).await?,
        "user"=>state.mysql.fetch_optional("SELECT json FROM kinds WHERE kind='Model' AND user_id=? AND name=? AND namespace=? AND is_active=true LIMIT 1",(user_id,name,namespace)).await?,
        _=>state.mysql.fetch_optional("SELECT json FROM kinds WHERE kind='Model' AND name=? AND namespace=? AND is_active=true LIMIT 1",(name,namespace)).await?,
    };
    let Some(row) = row else { return Ok(None) };
    let Some(spec) = row.json.0.get("spec") else {
        return Ok(None);
    };
    match execution::model_config(state, spec, user_id, user_name).await {
        Ok(mut config) => {
            config["model_name"] = name.into();
            config["model_namespace"] = namespace.into();
            config["model_type"] = kind.into();
            Ok(Some(config))
        }
        Err(error) => {
            tracing::warn!(knowledge_base_id=kb.id,%error,"summary model unavailable");
            Ok(None)
        }
    }
}

async fn document(state: &AppState, input: DocumentInput) -> Result<Value> {
    if !enabled("SUMMARY_ENABLED", true) {
        return Ok(
            json!({"status":"skipped","reason":"global_summary_disabled","document_id":input.document_id}),
        );
    }
    let document: Option<Document> = state
        .mysql
        .fetch_optional(
            "SELECT id,kind_id,name,is_active,summary FROM knowledge_documents WHERE id=?",
            (input.document_id,),
        )
        .await?;
    let Some(document) = document.filter(|doc| doc.is_active != 0) else {
        return Ok(json!({"status":"success","document_id":input.document_id}));
    };
    let Some(kb) = kb(state, document.kind_id).await? else {
        return Ok(json!({"status":"success","document_id":document.id}));
    };
    let Some(model_config) = model(state, &kb, input.user_id, &input.user_name).await? else {
        return Ok(json!({"status":"success","document_id":document.id}));
    };
    let mut generating = document
        .summary
        .as_ref()
        .map(|summary| summary.0.clone())
        .filter(Value::is_object)
        .unwrap_or(json!({}));
    generating["status"] = "generating".into();
    generating["updated_at"] = now().into();
    if !persist_document(state, document.id, generating).await? {
        return Ok(json!({"status":"success","document_id":document.id}));
    }
    let outcome = document_result(state, &document, input.user_id, model_config).await;
    let successful = outcome.as_ref().is_ok_and(|(_, parsed)| parsed.is_some());
    let result = match outcome {
        Ok((task_id, Some(mut parsed))) => {
            parsed["status"] = "completed".into();
            parsed["task_id"] = task_id.into();
            parsed["updated_at"] = now().into();
            parsed
        }
        Ok((task_id, None)) => {
            json!({"status":"failed","error":"Failed to parse summary","task_id":task_id,"updated_at":now()})
        }
        Err(error) => json!({"status":"failed","error":error.to_string(),"updated_at":now()}),
    };
    if persist_document(state, document.id, result).await? && successful {
        // The source calls this directly, so ownership of the standalone
        // post-delete summary job is independent of this continuation.
        knowledge_base(state, document.kind_id, input.user_id, &input.user_name).await?;
    }
    Ok(json!({"status":"success","document_id":document.id}))
}

async fn document_result(
    state: &AppState,
    document: &Document,
    user_id: i64,
    model_config: Value,
) -> Result<(i64, Option<Value>)> {
    #[derive(FromMysqlRow)]
    struct Text {
        content: Option<String>,
    }
    let row:Option<Text>=state.mysql.fetch_optional("SELECT COALESCE(NULLIF(converted.extracted_text,''),original.extracted_text) AS content FROM knowledge_documents d LEFT JOIN subtask_contexts converted ON converted.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(d.source_config,'$.converted_attachment_id')) AS SIGNED) LEFT JOIN subtask_contexts original ON original.id=d.attachment_id WHERE d.id=? AND d.is_active=true",(document.id,)).await?;
    let content = row
        .and_then(|row| row.content)
        .filter(|text| !text.is_empty())
        .context("Failed to get document content")?;
    let content = truncate(&content);
    let prompt = format!("Please generate a summary for the following document:\n\n{content}");
    let title = format!("Document Summary - {}", document.id);
    let result = execution::execute(
        state,
        BackgroundChat {
            user_id,
            title: &title,
            task_type: "summary",
            summary_type: "document",
            document_id: Some(document.id),
            knowledge_base_id: Some(document.kind_id),
            system_prompt: DOCUMENT_PROMPT,
            prompt: &prompt,
            model_config,
        },
    )
    .await?;
    Ok((result.task_id, result.parsed))
}

async fn persist_document(state: &AppState, id: i64, summary: Value) -> Result<bool> {
    Ok(state
        .mysql
        .with_transaction(async |tx| {
            tx.execute(
                "UPDATE knowledge_documents SET summary=?,updated_at=NOW() WHERE id=?",
                (Json(&summary), id),
            )
            .await
        })
        .await?
        .rows_affected
        > 0)
}

pub async fn knowledge_base(
    state: &AppState,
    id: i64,
    user_id: i64,
    user_name: &str,
) -> Result<()> {
    let Some(record) = kb(state, id).await? else {
        return Ok(());
    };
    let Some(model_config) = model(state, &record, user_id, user_name).await? else {
        return Ok(());
    };
    let claim=state.mysql.with_transaction(async |tx| {
        let kb:Option<Kb>=tx.fetch_optional("SELECT id,json FROM kinds WHERE id=? AND kind='KnowledgeBase' FOR UPDATE",(id,)).await?;
        let Some(kb)=kb else{return Ok(None)};
        if kb.json.0.pointer("/spec/summaryEnabled").and_then(Value::as_bool)!=Some(true) || kb.json.0.pointer("/spec/summary/status").and_then(Value::as_str)==Some("generating") {return Ok(None)}
        let documents:Vec<Document>=tx.fetch_all("SELECT id,kind_id,name,is_active,summary FROM knowledge_documents WHERE kind_id=? AND is_active=true",(id,)).await?;
        let (count,aggregation)=aggregate(&documents);
        if aggregation.is_empty() {return Ok(None)}
        tx.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.summary',JSON_MERGE_PATCH(COALESCE(NULLIF(JSON_EXTRACT(json,'$.spec.summary'),CAST('null' AS JSON)),JSON_OBJECT()),?)),updated_at=NOW() WHERE id=? AND kind='KnowledgeBase'",(Json(json!({"status":"generating","updated_at":now()})),id)).await?;
        Ok(Some((count,aggregation)))
    }).await?;
    let Some((count, aggregation)) = claim else {
        return Ok(());
    };
    let title = format!("Knowledge Base Summary - {id}");
    let prompt = format!(
        "Please generate a comprehensive summary for the knowledge base based on the following document summaries:\n\n{}",
        truncate(&aggregation)
    );
    let outcome = execution::execute(
        state,
        BackgroundChat {
            user_id,
            title: &title,
            task_type: "summary",
            summary_type: "knowledge_base",
            document_id: None,
            knowledge_base_id: Some(id),
            system_prompt: KB_PROMPT,
            prompt: &prompt,
            model_config,
        },
    )
    .await;
    let result = match outcome {
        Ok(result) => {
            if let Some(mut parsed) = result.parsed {
                parsed["status"] = "completed".into();
                parsed["task_id"] = result.task_id.into();
                parsed["updated_at"] = now().into();
                parsed["last_summary_doc_count"] = count.into();
                parsed["meta_info"] = json!({"document_count":count,"last_updated":now()});
                parsed
            } else {
                json!({"status":"failed","error":"Failed to parse summary","task_id":result.task_id,"updated_at":now()})
            }
        }
        Err(error) => json!({"status":"failed","error":error.to_string(),"updated_at":now()}),
    };
    state.mysql.with_transaction(async |tx|{
        tx.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.summary',JSON_MERGE_PATCH(COALESCE(NULLIF(JSON_EXTRACT(json,'$.spec.summary'),CAST('null' AS JSON)),JSON_OBJECT()),?)),updated_at=NOW() WHERE id=? AND kind='KnowledgeBase'",(Json(&result),id)).await?;Ok(())
    }).await?;
    Ok(())
}

fn aggregate(documents: &[Document]) -> (u64, String) {
    let mut count = 0;
    let mut lines = vec![];
    for document in documents {
        let Some(summary) = document
            .summary
            .as_ref()
            .map(|summary| &summary.0)
            .filter(|summary| summary["status"] == "completed")
        else {
            continue;
        };
        count += 1;
        let short = summary["short_summary"].as_str().unwrap_or("");
        if short.is_empty() {
            continue;
        }
        let topics = summary["topics"]
            .as_array()
            .map(|topics| {
                topics
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        lines.push(format!(
            "## Document {}: {}\nSummary: {short}\nTopics: {topics}\n",
            lines.len() + 1,
            document.name
        ));
    }
    (count, lines.join("\n"))
}

fn now() -> String {
    Utc::now()
        .naive_utc()
        .format("%Y-%m-%dT%H:%M:%S%.f")
        .to_string()
}
fn truncate(text: &str) -> String {
    if text.len() <= 45000 {
        return text.into();
    }
    let mut end = 45000;
    while !text.is_char_boundary(end) {
        end -= 1
    }
    format!(
        "{}\n\n[Content truncated due to length limit...]",
        &text[..end]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_limit_preserves_utf8() {
        let text = "中".repeat(20000);
        let result = truncate(&text);
        assert!(result.starts_with(&"中".repeat(15000)));
        assert!(result.ends_with("[Content truncated due to length limit...]"));
    }
    #[test]
    fn aggregation_counts_completed_summaries_even_without_short_text() {
        let doc = |id, summary| Document {
            id,
            kind_id: 1,
            name: format!("d{id}"),
            is_active: 1,
            summary: Some(Json(summary)),
        };
        let (count, text) = aggregate(&[
            doc(
                1,
                json!({"status":"completed","short_summary":"hello","topics":["a"]}),
            ),
            doc(2, json!({"status":"generating"})),
            doc(3, json!({"status":"completed"})),
        ]);
        assert_eq!(count, 2);
        assert_eq!(text, "## Document 1: d1\nSummary: hello\nTopics: a\n");
    }
}
