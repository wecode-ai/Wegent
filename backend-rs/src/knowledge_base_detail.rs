// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases/{knowledge_base_id}`,
//! `GET /api/knowledge-bases/config`, and
//! `GET /api/knowledge-bases/{knowledge_base_id}/document-protection`
//! (`app.api.endpoints.knowledge`: `get_knowledge_base`,
//! `get_knowledge_config`, and `get_document_protection`, mounted at the
//! `/knowledge-bases` prefix).
//!
//! Source pipeline for the detail endpoint:
//!
//! 1. `security.get_current_user` — user by name;
//! 2. `KnowledgeOrchestrator.get_knowledge_base` ->
//!    `KnowledgeService.get_knowledge_base` — the KB `Kind` record, the
//!    user row by id, the full ACL chain of
//!    `resolve_knowledge_base_permission`, and
//!    `meets_direct_access_requirement`;
//! 3. `KnowledgeService.get_document_count` — `count(knowledge_documents)`
//!    filtered by `kind_id`;
//! 4. `KnowledgeBaseResponse.from_kind` over the `kinds.json` spec.
//!
//! The config endpoint reads the `CHUNK_STORAGE_ENABLED` (default false)
//! and `KNOWLEDGE_EXTERNAL_BATCH_IMPORT_MAX` (default 50) settings from the
//! source-compatible environment.
//!
//! The document-protection endpoint reuses the same access pipeline and then
//! applies the selected document-download policy.
use brz_http_server::HttpResponse;
use brz_http_server::StatusCode;
use brz_mysql::{Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Serialize;

use crate::auth::{AuthFailure, get_current_user};
use crate::config::env_or_dotenv;
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;

use crate::knowledge_documents_content::access::{
    KnowledgeBase, knowledge_base_access, knowledge_base_record,
};

/// GET /api/knowledge-bases/{knowledge_base_id}: the knowledge-bases free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/knowledge-bases/:knowledge_base_id")]
async fn get_knowledge_base(
    #[inject(state)] state: &AppState,
    knowledge_base_id: &str,
    #[header] authorization: Option<&str>,
) -> Result<KnowledgeBaseResponse, KbError> {
    let knowledge_base_id = knowledge_base_id
        .parse::<i64>()
        .map_err(|_| validation_error(knowledge_base_id))?;
    get_knowledge_base_inner(state, knowledge_base_id, authorization)
        .await
        .map_err(KbError::from)
}

/// The endpoint's failure shape: a mapped FastAPI-style error (422 path
/// validation, 404/403/400 value errors, 401 auth, or 500 internal).
#[derive(Debug)]
struct KbError(FastApiError);

impl From<FastApiError> for KbError {
    fn from(error: FastApiError) -> Self {
        Self(error)
    }
}

impl brz_http_server::IntoHttpError for KbError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        self.0.into_http_error(arena)
    }
}

/// FastAPI-style 422 for an unparsable path parameter.
fn validation_error(value: &str) -> FastApiError {
    FastApiError::validation([serde_json::json!({
        "type": "int_parsing",
        "loc": ["path", "knowledge_base_id"],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": value,
    })])
}

fn auth_error(error: AuthFailure) -> FastApiError {
    match error {
        AuthFailure::InvalidCredentials => {
            FastApiError::unauthorized("Could not validate credentials")
        }
        AuthFailure::UserNotActivated => FastApiError::unauthorized("User not activated"),
    }
}

/// Handler body for `GET /api/knowledge-bases/{knowledge_base_id}`.
async fn get_knowledge_base_inner(
    state: &AppState,
    knowledge_base_id: i64,
    authorization: Option<&str>,
) -> Result<KnowledgeBaseResponse, FastApiError> {
    let user = get_current_user(&state.auth, &state.mysql, authorization)
        .await
        .map_err(auth_error)?;
    let user_id = i64::from(user.id);

    let mysql = &state.mysql;
    let redis = state.redis.as_ref();

    // `KnowledgeService.get_knowledge_base`: record, then the ACL chain.
    // A missing record maps to the source's "not found" branch before any
    // ACL query runs.
    let Some(kb) = knowledge_base_record(mysql, knowledge_base_id)
        .await
        .map_err(|error| internal(&error.to_string()))?
    else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Knowledge base not found",
        ));
    };
    let has_access = knowledge_base_access(mysql, redis, &state.entity_resolvers, &kb, user_id)
        .await
        .map_err(|_| internal("acl failure"))?;
    if !has_access {
        return Err(FastApiError::detail(StatusCode::FORBIDDEN, "Access denied"));
    }

    // `KnowledgeService.get_document_count`.
    let document_count = document_count(mysql, knowledge_base_id)
        .await
        .map_err(|error| internal(&error.to_string()))?;

    // `KnowledgeBaseResponse.from_kind` (over `kind.json.get("spec", {})`).
    let spec = kb
        .kinds_json
        .project::<KbDocument>()
        .unwrap_or_default()
        .spec;
    Ok(build_response(&kb, &spec, document_count))
}

fn internal(message: &str) -> FastApiError {
    tracing::error!(message, "knowledge-bases detail dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// `count(knowledge_documents.id)` filtered by `kind_id`.
async fn document_count<M>(mysql: &M, knowledge_base_id: i64) -> MysqlResult<i64>
where
    M: Mysql,
{
    #[derive(Debug, brz_mysql::FromMysqlRow)]
    struct CountRow {
        count_1: i64,
    }
    let row: Option<CountRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT count(knowledge_documents.id) AS count_1 \nFROM knowledge_documents \
                 \nWHERE knowledge_documents.kind_id = {knowledge_base_id}"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| row.count_1).unwrap_or(0))
}

// ---------------------------------------------------------------------------
// Response model
// ---------------------------------------------------------------------------

/// `KnowledgeBaseResponse` fields in the pydantic model's declaration order
/// (the multimodal mixin first, then the response model's own fields).
#[derive(Debug, Serialize)]
pub struct KnowledgeBaseResponse {
    multimodal_analysis_enabled: bool,
    multimodal_analysis_model_ref: Option<ModelRef>,
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
    summary_enabled: bool,
    summary_model_ref: Option<ModelRef>,
    execution_model_ref: Option<ModelRef>,
    summary: Option<OpaqueJson>,
    guided_questions: Option<Vec<String>>,
    max_calls_per_conversation: i64,
    exempt_calls_before_check: i64,
    created_at: String,
    updated_at: String,
}

/// `RetrievalConfig` with the fields `from_kind` echoes, in the pydantic
/// model's declaration order.
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
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct EmbeddingConfigResponse {
    model_name: String,
    #[serde(default = "default_namespace")]
    model_namespace: String,
}

/// `HybridWeights`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct HybridWeights {
    #[serde(default = "default_vector_weight")]
    vector_weight: f64,
    #[serde(default = "default_keyword_weight")]
    keyword_weight: f64,
}

/// `derive_retrieval_capabilities`.
#[derive(Debug, Serialize)]
struct RetrievalCapabilities {
    retrieval_mode: Option<String>,
    semantic_query: bool,
    keywords: bool,
    phrases: bool,
}

/// A `{name, namespace, type}` model reference (`SummaryModelRef` shape);
/// unknown keys are ignored on decode and absent on encode.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ModelRef {
    name: String,
    #[serde(default = "default_namespace")]
    namespace: String,
    #[serde(default = "default_public")]
    r#type: String,
}

fn default_namespace() -> String {
    "default".to_string()
}

fn default_public() -> String {
    "public".to_string()
}

fn default_vector_weight() -> f64 {
    0.7
}

fn default_keyword_weight() -> f64 {
    0.3
}

/// The `kinds.json` document wrapper: `from_kind` reads only `spec`.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct KbDocument {
    spec: KbSpec,
}

/// The `kinds.json` `spec` fields `from_kind` reads (camelCase keys); all
/// other keys are ignored.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct KbSpec {
    name: Option<String>,
    description: Option<String>,
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
    #[serde(rename = "summaryEnabled")]
    summary_enabled: Option<bool>,
    #[serde(rename = "summaryModelRef")]
    summary_model_ref: Option<ModelRef>,
    #[serde(rename = "executionModelRef")]
    execution_model_ref: Option<ModelRef>,
    summary: Option<OpaqueJson>,
    #[serde(rename = "guidedQuestions")]
    guided_questions: Option<Vec<String>>,
    #[serde(rename = "maxCallsPerConversation")]
    max_calls_per_conversation: Option<i64>,
    #[serde(rename = "exemptCallsBeforeCheck")]
    exempt_calls_before_check: Option<i64>,
    #[serde(rename = "multimodalAnalysisEnabled")]
    multimodal_analysis_enabled: Option<bool>,
    #[serde(rename = "multimodalAnalysisModelRef")]
    multimodal_analysis_model_ref: Option<ModelRef>,
    #[serde(rename = "multimodalAnalysisVideoPrompt")]
    multimodal_analysis_video_prompt: Option<String>,
    #[serde(rename = "multimodalAnalysisImagePrompt")]
    multimodal_analysis_image_prompt: Option<String>,
}

/// The stored `retrievalConfig`; `_normalize_retrieval_config_for_response`
/// keeps it only when both `retriever_name` and
/// `embedding_config.model_name` are present.
#[derive(Debug, Default, serde::Deserialize)]
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

/// `KnowledgeBaseResponse.from_kind`.
fn build_response(kb: &KnowledgeBase, spec: &KbSpec, document_count: i64) -> KnowledgeBaseResponse {
    // `derive_retrieval_capabilities(retrievalConfig)`.
    let capabilities = derive_retrieval_capabilities(spec.retrieval_config.as_ref());

    // `_normalize_retrieval_config_for_response`: keep the config only when
    // complete (retriever_name and embedding model_name present).
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

    // Call-limit validation: exempt must be strictly below max; otherwise
    // the source falls back to the 10/5 defaults.
    let mut max_calls = spec.max_calls_per_conversation.unwrap_or(10);
    let mut exempt_calls = spec.exempt_calls_before_check.unwrap_or(5);
    if exempt_calls >= max_calls {
        tracing::warn!(
            kb_id = kb.kinds_id,
            "Invalid KB call-limit config; using defaults"
        );
        max_calls = 10;
        exempt_calls = 5;
    }

    KnowledgeBaseResponse {
        multimodal_analysis_enabled: spec.multimodal_analysis_enabled.unwrap_or(false),
        multimodal_analysis_model_ref: spec.multimodal_analysis_model_ref.clone(),
        multimodal_analysis_video_prompt: spec.multimodal_analysis_video_prompt.clone(),
        multimodal_analysis_image_prompt: spec.multimodal_analysis_image_prompt.clone(),
        id: kb.kinds_id,
        // `spec.get("name", "")`: an absent name renders as the empty
        // string, a present one verbatim.
        name: spec.name.clone().unwrap_or_default(),
        // `spec.get("description") or None`: an empty string becomes null.
        description: spec
            .description
            .clone()
            .filter(|description| !description.is_empty()),
        user_id: kb.kinds_user_id,
        namespace: kb.kinds_namespace.clone(),
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
        document_count,
        is_active: true,
        retrieval_config,
        retrieval_capabilities: capabilities,
        summary_enabled: spec.summary_enabled.unwrap_or(false),
        summary_model_ref: spec.summary_model_ref.clone(),
        execution_model_ref: spec.execution_model_ref.clone(),
        summary: spec.summary.clone(),
        guided_questions: spec.guided_questions.clone(),
        max_calls_per_conversation: max_calls,
        exempt_calls_before_check: exempt_calls,
        created_at: format_datetime(kb.kinds_created_at),
        updated_at: format_datetime(kb.kinds_updated_at),
    }
}

/// `derive_retrieval_capabilities`: optional query hints per retrieval
/// mode; an absent or unknown mode renders all-false with a null mode.
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

/// Pydantic's `datetime` JSON rendering for a naive column value.
fn format_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S").to_string()
}

// ---------------------------------------------------------------------------
// GET /api/knowledge-bases/config
// ---------------------------------------------------------------------------

/// `get_knowledge_config`: the two system-level feature switches.
#[derive(Debug, Serialize)]
pub struct KnowledgeConfigResponse {
    chunk_storage_enabled: bool,
    external_batch_import_max: i64,
}

/// GET /api/knowledge-bases/config: the knowledge-bases free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/knowledge-bases/config")]
async fn get_knowledge_config(
    #[inject(state)] _state: &AppState,
) -> Result<KnowledgeConfigResponse, FastApiError> {
    let chunk_storage_enabled = env_or_dotenv("CHUNK_STORAGE_ENABLED")
        .map(|value| value == "true" || value == "1" || value == "True")
        .unwrap_or(false);
    let external_batch_import_max = env_or_dotenv("KNOWLEDGE_EXTERNAL_BATCH_IMPORT_MAX")
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);
    Ok(KnowledgeConfigResponse {
        chunk_storage_enabled,
        external_batch_import_max,
    })
}

// ---------------------------------------------------------------------------
// GET /api/knowledge-bases/{knowledge_base_id}/document-protection
// ---------------------------------------------------------------------------

/// `DocumentProtectionResponse` (`app.schemas.knowledge`): the effective
/// document-export capability of a knowledge-base reader.
#[derive(Debug, Serialize)]
struct DocumentProtectionResponse {
    original_download_allowed: bool,
    watermark_text: Option<String>,
}

/// GET /api/knowledge-bases/:knowledge_base_id/document-protection: the
/// knowledge-bases free function, injecting the process-lifetime application
/// state.
#[brz_http_server::get("/api/knowledge-bases/:knowledge_base_id/document-protection")]
async fn get_document_protection(
    #[inject(state)] state: &AppState,
    knowledge_base_id: &str,
    #[header] authorization: Option<&str>,
) -> Result<HttpResponse<DocumentProtectionResponse>, KbError> {
    let knowledge_base_id = knowledge_base_id
        .parse::<i64>()
        .map_err(|_| validation_error(knowledge_base_id))?;
    let body = document_protection_inner(state, knowledge_base_id, authorization)
        .await
        .map_err(KbError::from)?;
    // `response.headers["Cache-Control"] = "private, no-store"`.
    HttpResponse::new(body)
        .header("cache-control", "private, no-store")
        .map_err(|error| KbError::from(internal(&error.to_string())))
}

/// Handler body for `GET /api/knowledge-bases/{knowledge_base_id}/document-protection`.
async fn document_protection_inner(
    state: &AppState,
    knowledge_base_id: i64,
    authorization: Option<&str>,
) -> Result<DocumentProtectionResponse, FastApiError> {
    let user = get_current_user(&state.auth, &state.mysql, authorization)
        .await
        .map_err(auth_error)?;
    let user_id = i64::from(user.id);

    let mysql = &state.mysql;
    let redis = state.redis.as_ref();

    // `KnowledgeService.get_knowledge_base`: the record, then the ACL chain.
    // The source maps both a missing record and denied access to this
    // endpoint's 404.
    let Some(kb) = knowledge_base_record(mysql, knowledge_base_id)
        .await
        .map_err(|error| internal(&error.to_string()))?
    else {
        return Err(knowledge_base_not_found());
    };
    let has_access = knowledge_base_access(mysql, redis, &state.entity_resolvers, &kb, user_id)
        .await
        .map_err(|_| internal("acl failure"))?;
    if !has_access {
        return Err(knowledge_base_not_found());
    }

    let configured = kb
        .kinds_json
        .project::<KbDocument>()
        .unwrap_or_default()
        .spec
        .allow_document_download;
    let download_allowed = state
        .document_download_policy
        .original_download_allowed(mysql, &kb.kinds_namespace, configured)
        .await
        .map_err(|error| internal(&error.to_string()))?;

    Ok(DocumentProtectionResponse {
        original_download_allowed: download_allowed,
        // `None if download_allowed else current_user.user_name`.
        watermark_text: (!download_allowed).then(|| user.user_name.clone()),
    })
}

/// `HTTPException(404, "Knowledge base not found")` for the protection
/// endpoint's missing-record and denied-access branches.
fn knowledge_base_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Knowledge base not found")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kb_from_json(json: &str) -> (KnowledgeBase, KbSpec) {
        let kb = KnowledgeBase {
            kinds_id: 17,
            kinds_user_id: 3,
            kinds_namespace: "default".to_string(),
            kinds_json: OpaqueJson::from(serde_json::from_str::<serde_json::Value>(json).unwrap()),
            kinds_created_at: NaiveDateTime::parse_from_str(
                "2026-01-01 16:43:32",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
            kinds_updated_at: NaiveDateTime::parse_from_str(
                "2026-01-01 16:43:32",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        };
        let spec = kb
            .kinds_json
            .project::<KbDocument>()
            .unwrap_or_default()
            .spec;
        (kb, spec)
    }

    /// A representative public knowledge-base document.
    const SAMPLE_SPEC: &str = r#"{"kind":"KnowledgeBase","spec":{"name":"Example","kbType":"notebook","source":null,"language":null,"description":"","document_count":0,"summaryEnabled":true,"retrievalConfig":{"top_k":5,"hybrid_weights":{"vector_weight":0.7,"keyword_weight":0.3},"retrieval_mode":"hybrid","retriever_name":"elasticsearch-dataset","score_threshold":0.4,"embedding_config":{"model_name":"Qwen3-Embedding-0.6B","model_namespace":"default"},"retriever_namespace":"default"},"summaryModelRef":{"name":"sample-model","type":"public","namespace":"default"},"executionModelRef":null,"generationStrategy":null,"showGenerationTask":false,"allowDocumentDownload":true,"publishedGenerationId":0,"exemptCallsBeforeCheck":5,"directAccessRequirement":"read","maxCallsPerConversation":10,"multimodalAnalysisEnabled":false},"status":{"state":"Available"},"metadata":{"name":"kb-3-default-Example","labels":null,"namespace":"default","displayName":null},"apiVersion":"agent.wecode.io/v1"}"#;

    #[test]
    fn recorded_spec_renders_the_expected_response() {
        let (kb, spec) = kb_from_json(SAMPLE_SPEC);
        let response = build_response(&kb, &spec, 0);
        let body = serde_json::to_value(&response).unwrap();
        // Field presence and the key scalar values of the sample.
        assert_eq!(body["id"], 17);
        assert_eq!(body["name"], "Example");
        assert_eq!(body["description"], serde_json::Value::Null);
        assert_eq!(body["user_id"], 3);
        assert_eq!(body["namespace"], "default");
        assert_eq!(body["direct_access_requirement"], "read");
        assert_eq!(body["allow_document_download"], true);
        assert_eq!(body["kb_type"], "notebook");
        assert_eq!(body["document_count"], 0);
        assert_eq!(body["is_active"], true);
        assert_eq!(body["summary_enabled"], true);
        assert_eq!(body["max_calls_per_conversation"], 10);
        assert_eq!(body["exempt_calls_before_check"], 5);
        assert_eq!(body["show_generation_task"], false);
        assert_eq!(body["created_at"], "2026-01-01T16:43:32");
        assert_eq!(body["updated_at"], "2026-01-01T16:43:32");
        assert_eq!(
            body["retrieval_config"]["retriever_name"],
            "elasticsearch-dataset"
        );
        assert_eq!(body["retrieval_config"]["retrieval_mode"], "hybrid");
        assert_eq!(body["retrieval_config"]["top_k"], 5);
        assert_eq!(body["retrieval_config"]["score_threshold"], 0.4);
        assert_eq!(
            body["retrieval_config"]["embedding_config"]["model_name"],
            "Qwen3-Embedding-0.6B"
        );
        assert_eq!(body["retrieval_capabilities"]["retrieval_mode"], "hybrid");
        assert_eq!(body["retrieval_capabilities"]["semantic_query"], true);
        assert_eq!(body["retrieval_capabilities"]["keywords"], true);
        assert_eq!(body["retrieval_capabilities"]["phrases"], true);
        assert_eq!(body["summary_model_ref"]["type"], "public");
    }

    #[test]
    fn response_field_order_matches_pydantic_model() {
        let (kb, spec) = kb_from_json(SAMPLE_SPEC);
        let body = serde_json::to_string(&build_response(&kb, &spec, 0)).unwrap();
        // The multimodal mixin precedes the response model's own fields.
        assert!(body.starts_with(
            r#"{"multimodal_analysis_enabled":false,"multimodal_analysis_model_ref":null,"#
        ));
        assert!(body.contains(r#""id":17,"name":"Example","description":null,"user_id":3"#));
        assert!(body.ends_with(
            r#""created_at":"2026-01-01T16:43:32","updated_at":"2026-01-01T16:43:32"}"#
        ));
    }

    #[test]
    fn empty_description_and_missing_kb_type_default() {
        let (kb, spec) = kb_from_json(r#"{"spec":{"name":"n","description":""}}"#);
        let response = build_response(&kb, &spec, 3);
        assert_eq!(response.description, None);
        assert_eq!(response.kb_type, "notebook");
        assert_eq!(response.document_count, 3);
        assert_eq!(response.direct_access_requirement, "read");
        assert_eq!(response.max_calls_per_conversation, 10);
        assert_eq!(response.exempt_calls_before_check, 5);
        assert_eq!(response.retrieval_config, None);
        assert_eq!(response.retrieval_capabilities.retrieval_mode, None);
        assert!(!response.retrieval_capabilities.semantic_query);
    }

    #[test]
    fn invalid_call_limits_fall_back_to_defaults() {
        let (kb, spec) =
            kb_from_json(r#"{"spec":{"maxCallsPerConversation":3,"exemptCallsBeforeCheck":5}}"#);
        let response = build_response(&kb, &spec, 0);
        assert_eq!(response.max_calls_per_conversation, 10);
        assert_eq!(response.exempt_calls_before_check, 5);
    }

    #[test]
    fn incomplete_retrieval_config_is_dropped() {
        // `retriever_name` without an embedding model is dropped.
        let (kb, spec) = kb_from_json(r#"{"spec":{"retrievalConfig":{"retriever_name":"x"}}}"#);
        let response = build_response(&kb, &spec, 0);
        assert!(response.retrieval_config.is_none());
        // The capabilities still derive from the raw config's mode.
        assert_eq!(response.retrieval_capabilities.retrieval_mode, None);

        let (kb, spec) = kb_from_json(
            r#"{"spec":{"retrievalConfig":{"retriever_name":"x","embedding_config":{"model_name":"m"},"retrieval_mode":"keyword"}}}"#,
        );
        let response = build_response(&kb, &spec, 0);
        assert!(response.retrieval_config.is_some());
        assert_eq!(
            response.retrieval_capabilities.retrieval_mode.as_deref(),
            Some("keyword")
        );
        assert!(!response.retrieval_capabilities.semantic_query);
        assert!(response.retrieval_capabilities.keywords);
    }

    #[test]
    fn config_defaults_match_source() {
        let config = KnowledgeConfigResponse {
            chunk_storage_enabled: false,
            external_batch_import_max: 50,
        };
        assert!(!config.chunk_storage_enabled);
        assert_eq!(config.external_batch_import_max, 50);
    }

    #[test]
    fn protection_response_matches_the_recorded_body() {
        let allowed = DocumentProtectionResponse {
            original_download_allowed: true,
            watermark_text: None,
        };
        assert_eq!(
            serde_json::to_string(&allowed).unwrap(),
            r#"{"original_download_allowed":true,"watermark_text":null}"#
        );
        // A protected knowledge base renders the reader's name as watermark.
        let protected = DocumentProtectionResponse {
            original_download_allowed: false,
            watermark_text: Some("sample-user".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&protected).unwrap(),
            r#"{"original_download_allowed":false,"watermark_text":"sample-user"}"#
        );
    }
}
