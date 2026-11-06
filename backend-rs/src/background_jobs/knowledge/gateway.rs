// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Remote RAG calls contain authorized resource references, never storage secrets.

use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{index::IndexPayload, resources};
use crate::{AppState, attachments::context_store, knowledge_documents_content::access};

pub async fn index(state: &AppState, payload: &IndexPayload) -> Result<Value> {
    let kb_id: i64 = payload
        .knowledge_base_id
        .parse()
        .context("knowledge_base_id must be an integer")?;
    let kb = access::knowledge_base_record(&state.mysql, kb_id)
        .await?
        .context("Knowledge base not found")?;
    if let Some(caller) = payload.caller_user_id {
        resources::require_manual_access(state, kb_id, payload.document_id, caller).await?;
    }
    let authorized = resources::authorized(
        state,
        kb_id,
        kb.kinds_user_id,
        "index",
        &payload.retriever_name,
        &payload.retriever_namespace,
        Some((
            &payload.embedding_model_name,
            &payload.embedding_model_namespace,
        )),
    )
    .await?;
    let attachment = context_store::get_context_optional(&state.mysql, payload.attachment_id)
        .await?
        .filter(|context| context.context_type == "attachment")
        .context("Attachment not found")?;
    let content_ref = content_ref(state, attachment.id).await?;
    if let Some(document_id) = payload.document_id {
        delete(state, kb_id, document_id, kb.kinds_user_id).await?;
    }
    post(
        state,
        "/internal/rag/index",
        json!({
            "knowledge_base_id":kb_id,"user_id":payload.caller_user_id.unwrap_or(kb.kinds_user_id),
            "document_id":payload.document_id,"source_file":attachment.original_filename(),
            "file_extension":attachment.file_extension(),"content_ref":content_ref,
            "authorized_resources":authorized,
        }),
        Duration::from_secs(600),
    )
    .await
}

pub async fn delete(state: &AppState, kb_id: i64, document_id: i64, owner: i64) -> Result<Value> {
    let kb = access::knowledge_base_record(&state.mysql, kb_id)
        .await?
        .context("Knowledge base not found")?;
    let config = kb.kinds_json.to_value();
    let retriever = config
        .pointer("/spec/retrievalConfig/retriever_name")
        .and_then(Value::as_str)
        .context("Knowledge base has no retriever")?;
    let namespace = config
        .pointer("/spec/retrievalConfig/retriever_namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let authorized =
        resources::authorized(state, kb_id, owner, "delete", retriever, namespace, None).await?;
    post(
        state,
        "/internal/rag/delete-document-index",
        json!({
            "knowledge_base_id":kb_id,"user_id":owner,"document_ref":document_id.to_string(),
            "authorized_resources":authorized,
        }),
        Duration::from_secs(30),
    )
    .await
}

async fn content_ref(state: &AppState, attachment_id: i64) -> Result<Value> {
    #[derive(Serialize)]
    struct Claims {
        attachment_id: i64,
        exp: i64,
        r#type: &'static str,
    }
    let expires = Utc::now() + ChronoDuration::seconds(300);
    let algorithm = state
        .auth
        .algorithm
        .parse()
        .context("Unsupported JWT algorithm")?;
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(algorithm),
        &Claims {
            attachment_id,
            exp: expires.timestamp(),
            r#type: "rag_download_token",
        },
        &jsonwebtoken::EncodingKey::from_secret(state.auth.jwt_key.as_bytes()),
    )?;
    let base =
        std::env::var("BACKEND_INTERNAL_URL").unwrap_or_else(|_| "http://localhost:8000".into());
    let prefix = std::env::var("API_PREFIX").unwrap_or_else(|_| "/api".into());
    Ok(json!({"kind":"backend_attachment_stream",
        "url":format!("{}{prefix}/internal/rag/content/{attachment_id}", base.trim_end_matches('/')),
        "auth_token":token,"expires_at":expires.to_rfc3339()}))
}

#[derive(Debug, Deserialize)]
pub struct RuntimeError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub details: Value,
    #[serde(skip)]
    pub timeout: bool,
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "knowledge runtime request failed ({})", self.code)
    }
}
impl std::error::Error for RuntimeError {}

pub async fn post(
    state: &AppState,
    path: &str,
    payload: Value,
    timeout: Duration,
) -> Result<Value> {
    let base =
        std::env::var("KNOWLEDGE_RUNTIME_URL").unwrap_or_else(|_| "http://localhost:8200".into());
    let mut request = state
        .attachment_http
        .post(format!("{}{path}", base.trim_end_matches('/')))?
        .timeout(timeout)
        .json(&payload);
    if let Ok(token) = std::env::var("INTERNAL_SERVICE_TOKEN")
        && !token.is_empty()
    {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|error| RuntimeError {
        code: if error.is_timeout() {
            "indexing_timeout"
        } else {
            "remote_request_failed"
        }
        .into(),
        timeout: error.is_timeout(),
        details: Value::Null,
    })?;
    let success = response.status().is_success();
    let body: Value = response
        .json()
        .await
        .context("Knowledge runtime returned invalid JSON")?;
    if !success {
        let error = body.get("error").unwrap_or(&body);
        return Err(serde_json::from_value::<RuntimeError>(error.clone())
            .unwrap_or(RuntimeError {
                code: "remote_request_failed".into(),
                details: Value::Null,
                timeout: false,
            })
            .into());
    }
    Ok(body)
}

pub fn processing_error(error: &anyhow::Error, generation: i64) -> Value {
    let runtime = error.downcast_ref::<RuntimeError>();
    let (code, message, retryable) = match runtime.map(|error| error.code.as_str()) {
        Some("embedding_dimension_mismatch") => (
            "embedding_dimension_mismatch",
            "The embedding model returned an unexpected vector dimension. Check the model configuration and rebuild the document index.",
            false,
        ),
        Some("collection_dimension_mismatch") => (
            "collection_dimension_mismatch",
            "The document index stores a different vector dimension than the embedding model declares. Rebuild the document index to match the model.",
            false,
        ),
        _ if runtime.is_some_and(|error| error.timeout) => (
            "indexing_timeout",
            "Document indexing timed out. Please retry.",
            true,
        ),
        _ => (
            "indexing_failed",
            "Document indexing failed. Please retry.",
            true,
        ),
    };
    let mut value =
        super::state::processing_error("indexing", code, message, generation, Utc::now());
    value["retryable"] = retryable.into();
    if !retryable {
        value["model"] = runtime
            .and_then(|error| error.details.get("model"))
            .filter(|model| model.is_string())
            .cloned()
            .unwrap_or(Value::Null);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn engine_errors_are_sanitized_and_dimension_errors_are_not_retryable() {
        let error = anyhow::Error::new(RuntimeError {
            code: "embedding_dimension_mismatch".into(),
            details: json!({"model":"embed","api_key":"secret"}),
            timeout: false,
        });
        let public = processing_error(&error, 8);
        assert_eq!(public["retryable"], false);
        assert_eq!(public["model"], "embed");
        assert_eq!(public["generation"], 8);
        assert!(!public.to_string().contains("secret"));
    }
}
