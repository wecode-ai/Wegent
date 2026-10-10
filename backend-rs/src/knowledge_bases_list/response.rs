// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response models for `GET /api/knowledge-bases`:
//! `KnowledgeBaseListResponse` and its `KnowledgeBaseResponse` items
//! (`app.schemas.knowledge`).
//!
//! The list reuses the shared `KnowledgeBaseResponse.from_kind` projection but
//! takes `document_count` from the stored spec (the cached count) rather than a
//! per-row `knowledge_documents` query — the source's stated reason for the list
//! path ("Use cached document_count from spec to avoid N+1 query problem").
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::json_compat::OpaqueJson;

/// `KnowledgeBaseListResponse` (`app.schemas.knowledge`): field order follows
/// the pydantic model declaration.
#[derive(Debug, Serialize)]
pub(crate) struct KnowledgeBaseListResponse {
    pub(crate) total: i64,
    pub(crate) returned_count: i64,
    pub(crate) limit: i64,
    pub(crate) offset: i64,
    pub(crate) has_more: bool,
    pub(crate) items: Vec<KnowledgeBaseResponse>,
}

/// `KnowledgeBaseResponse`: the multimodal mixin first, then the response
/// model's own fields (including `dingtalk_auto_sync_enabled`, which the list
/// records carry between `retrieval_capabilities` and `summary_enabled`).
#[derive(Debug, Serialize)]
pub(crate) struct KnowledgeBaseResponse {
    multimodal_analysis_enabled: bool,
    multimodal_analysis_model_ref: Option<OpaqueJson>,
    multimodal_analysis_video_prompt: Option<String>,
    multimodal_analysis_image_prompt: Option<String>,
    id: i64,
    name: String,
    description: Option<String>,
    user_id: i64,
    namespace: String,
    direct_access_requirement: String,
    allow_document_download: Option<bool>,
    source: Option<OpaqueJson>,
    language: Option<String>,
    show_generation_task: bool,
    generation_strategy: Option<String>,
    kb_type: String,
    document_count: i64,
    is_active: bool,
    retrieval_config: Option<RetrievalConfigResponse>,
    retrieval_capabilities: RetrievalCapabilities,
    dingtalk_auto_sync_enabled: bool,
    summary_enabled: bool,
    summary_model_ref: Option<OpaqueJson>,
    execution_model_ref: Option<OpaqueJson>,
    summary: Option<OpaqueJson>,
    guided_questions: Option<Vec<String>>,
    max_calls_per_conversation: i64,
    exempt_calls_before_check: i64,
    created_at: String,
    updated_at: String,
}

/// `RetrievalConfig` (`app.schemas.kind`) as `from_kind` echoes it after
/// `_normalize_retrieval_config_for_response` accepts the stored config.
#[derive(Debug, PartialEq, Serialize)]
struct RetrievalConfigResponse {
    retriever_name: String,
    retriever_namespace: String,
    embedding_config: EmbeddingConfigResponse,
    retrieval_mode: String,
    top_k: i64,
    score_threshold: f64,
    hybrid_weights: Option<HybridWeights>,
}

/// `CompleteEmbeddingModelRef`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct EmbeddingConfigResponse {
    model_name: String,
    #[serde(default = "default_namespace")]
    model_namespace: String,
}

/// `HybridWeights`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct HybridWeights {
    #[serde(default = "default_vector_weight")]
    vector_weight: f64,
    #[serde(default = "default_keyword_weight")]
    keyword_weight: f64,
}

/// `derive_retrieval_capabilities` (`retrieval_capabilities.py`).
#[derive(Debug, Serialize)]
struct RetrievalCapabilities {
    retrieval_mode: Option<String>,
    semantic_query: bool,
    keywords: bool,
    phrases: bool,
}

fn default_namespace() -> String {
    "default".to_string()
}

fn default_vector_weight() -> f64 {
    0.7
}

fn default_keyword_weight() -> f64 {
    0.3
}

/// The `kinds.json` document wrapper: `from_kind` reads only `spec`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct KbDocument {
    pub(crate) spec: KbSpec,
}

/// The `kinds.json` `spec` fields `from_kind` reads (camelCase keys); unknown
/// keys are ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct KbSpec {
    name: Option<String>,
    description: Option<String>,
    #[serde(rename = "kbType")]
    kb_type: Option<String>,
    source: Option<OpaqueJson>,
    language: Option<String>,
    #[serde(rename = "showGenerationTask")]
    show_generation_task: Option<bool>,
    #[serde(rename = "generationStrategy")]
    generation_strategy: Option<String>,
    #[serde(rename = "directAccessRequirement")]
    direct_access_requirement: Option<String>,
    #[serde(rename = "allowDocumentDownload")]
    allow_document_download: Option<bool>,
    #[serde(rename = "retrievalConfig")]
    retrieval_config: Option<StoredRetrievalConfig>,
    #[serde(rename = "dingtalkAutoSyncEnabled")]
    dingtalk_auto_sync_enabled: Option<bool>,
    #[serde(rename = "summaryEnabled")]
    summary_enabled: Option<bool>,
    #[serde(rename = "summaryModelRef")]
    summary_model_ref: Option<OpaqueJson>,
    #[serde(rename = "executionModelRef")]
    execution_model_ref: Option<OpaqueJson>,
    summary: Option<OpaqueJson>,
    #[serde(rename = "guidedQuestions")]
    guided_questions: Option<Vec<String>>,
    #[serde(rename = "maxCallsPerConversation")]
    max_calls_per_conversation: Option<i64>,
    #[serde(rename = "exemptCallsBeforeCheck")]
    exempt_calls_before_check: Option<i64>,
    // The list's document count: `kb.json.get("spec", {}).get("document_count", 0)`.
    document_count: Option<i64>,
    #[serde(rename = "multimodalAnalysisEnabled")]
    multimodal_analysis_enabled: Option<bool>,
    #[serde(rename = "multimodalAnalysisModelRef")]
    multimodal_analysis_model_ref: Option<OpaqueJson>,
    #[serde(rename = "multimodalAnalysisVideoPrompt")]
    multimodal_analysis_video_prompt: Option<String>,
    #[serde(rename = "multimodalAnalysisImagePrompt")]
    multimodal_analysis_image_prompt: Option<String>,
}

/// The stored `retrievalConfig`; pydantic coerces it into `RetrievalConfig`,
/// filling each field's default.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct StoredRetrievalConfig {
    retriever_name: Option<String>,
    #[serde(rename = "retrieverNamespace", alias = "retriever_namespace")]
    retriever_namespace: Option<String>,
    #[serde(rename = "embeddingConfig", alias = "embedding_config")]
    embedding_config: Option<EmbeddingConfigResponse>,
    #[serde(rename = "retrievalMode", alias = "retrieval_mode")]
    retrieval_mode: Option<String>,
    top_k: Option<i64>,
    #[serde(rename = "scoreThreshold", alias = "score_threshold")]
    score_threshold: Option<f64>,
    #[serde(rename = "hybridWeights", alias = "hybrid_weights")]
    hybrid_weights: Option<HybridWeights>,
}

/// `KnowledgeBaseResponse.from_kind(kind, document_count=spec.document_count)`.
pub(crate) fn build_response(
    id: i64,
    user_id: i64,
    namespace: &str,
    is_active: bool,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    spec: &KbSpec,
) -> KnowledgeBaseResponse {
    // `derive_retrieval_capabilities(spec.get("retrievalConfig"))`.
    let capabilities = derive_retrieval_capabilities(spec.retrieval_config.as_ref());

    // `_normalize_retrieval_config_for_response`: keep the config only when
    // both `retriever_name` and `embedding_config.model_name` are present.
    let retrieval_config = spec.retrieval_config.as_ref().and_then(|config| {
        let complete = config
            .retriever_name
            .as_deref()
            .is_some_and(|name| !name.is_empty())
            && config
                .embedding_config
                .as_ref()
                .is_some_and(|embedding| !embedding.model_name.is_empty());
        complete.then(|| RetrievalConfigResponse {
            retriever_name: config.retriever_name.clone().unwrap_or_default(),
            retriever_namespace: config
                .retriever_namespace
                .clone()
                .unwrap_or_else(|| "default".to_string()),
            embedding_config: config
                .embedding_config
                .clone()
                .unwrap_or(EmbeddingConfigResponse {
                    model_name: String::new(),
                    model_namespace: "default".to_string(),
                }),
            retrieval_mode: config
                .retrieval_mode
                .clone()
                .unwrap_or_else(|| "vector".to_string()),
            top_k: config.top_k.unwrap_or(5),
            score_threshold: config.score_threshold.unwrap_or(0.5),
            hybrid_weights: config.hybrid_weights.clone(),
        })
    });

    // Call-limit validation: exempt must be strictly below max; otherwise the
    // source falls back to the 10/5 defaults.
    let mut max_calls = spec.max_calls_per_conversation.unwrap_or(10);
    let mut exempt_calls = spec.exempt_calls_before_check.unwrap_or(5);
    if exempt_calls >= max_calls {
        tracing::warn!(kb_id = id, "Invalid KB call-limit config; using defaults");
        max_calls = 10;
        exempt_calls = 5;
    }

    KnowledgeBaseResponse {
        multimodal_analysis_enabled: spec.multimodal_analysis_enabled.unwrap_or(false),
        multimodal_analysis_model_ref: spec.multimodal_analysis_model_ref.clone(),
        multimodal_analysis_video_prompt: spec.multimodal_analysis_video_prompt.clone(),
        multimodal_analysis_image_prompt: spec.multimodal_analysis_image_prompt.clone(),
        id,
        // `spec.get("name", "")`: an absent name renders as the empty string.
        name: spec.name.clone().unwrap_or_default(),
        // `spec.get("description") or None`: an empty string becomes null.
        description: spec
            .description
            .clone()
            .filter(|description| !description.is_empty()),
        user_id,
        namespace: namespace.to_string(),
        direct_access_requirement: spec
            .direct_access_requirement
            .clone()
            .unwrap_or_else(|| "read".to_string()),
        allow_document_download: spec.allow_document_download,
        source: spec.source.clone(),
        language: spec.language.clone(),
        show_generation_task: spec.show_generation_task.unwrap_or(false),
        generation_strategy: spec.generation_strategy.clone(),
        kb_type: spec
            .kb_type
            .clone()
            .unwrap_or_else(|| "notebook".to_string()),
        document_count: spec.document_count.unwrap_or(0),
        is_active,
        retrieval_config,
        retrieval_capabilities: capabilities,
        dingtalk_auto_sync_enabled: spec.dingtalk_auto_sync_enabled.unwrap_or(false),
        summary_enabled: spec.summary_enabled.unwrap_or(false),
        summary_model_ref: spec.summary_model_ref.clone(),
        execution_model_ref: spec.execution_model_ref.clone(),
        summary: spec.summary.clone(),
        guided_questions: spec.guided_questions.clone(),
        max_calls_per_conversation: max_calls,
        exempt_calls_before_check: exempt_calls,
        created_at: pydantic_datetime(created_at),
        updated_at: pydantic_datetime(updated_at),
    }
}

/// `derive_retrieval_capabilities`: optional query hints per retrieval mode;
/// an absent or unknown mode renders all-false with a null mode.
fn derive_retrieval_capabilities(config: Option<&StoredRetrievalConfig>) -> RetrievalCapabilities {
    let mode = config
        .and_then(|config| config.retrieval_mode.as_deref())
        .filter(|mode| matches!(*mode, "vector" | "keyword" | "hybrid"));
    match mode {
        Some(mode) => RetrievalCapabilities {
            retrieval_mode: Some(mode.to_string()),
            semantic_query: mode == "hybrid",
            keywords: mode == "keyword" || mode == "hybrid",
            phrases: mode == "keyword" || mode == "hybrid",
        },
        None => RetrievalCapabilities {
            retrieval_mode: None,
            semantic_query: false,
            keywords: false,
            phrases: false,
        },
    }
}

/// Pydantic serializes a DB `datetime` as `YYYY-MM-DDTHH:MM:SS`, plus
/// six-digit microseconds when the stored value has a fractional part.
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        format!(
            "{}.{:06}",
            value.format("%Y-%m-%dT%H:%M:%S"),
            value.and_utc().timestamp_subsec_micros()
        )
    }
}
