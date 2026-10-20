// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/conversion/callback/status` — conversion status
//! callbacks from the `knowledge_doc_converter` service.
//!
//! Mirrors `app/api/endpoints/internal/conversion_callback.py:
//! conversion_status_callback` (router `/conversion/callback` mounted under
//! `/internal`), whose router-level dependency is
//! `verify_internal_service_token`:
//!
//! 1. `conversion_started` — `mark_document_conversion_started`
//!    (`app/services/knowledge/index_state_machine.py`): the `FOR UPDATE`
//!    document load with the `selectin` external-source load, the
//!    `queued`/`pending_conversion` pre-state decision, then either the
//!    `index_status='converting'` UPDATE + `COMMIT` or a `ROLLBACK`.
//! 2. `conversion_failed` — the endpoint's document load, then
//!    `mark_document_index_failed`: the locked document reload, the active
//!    generation/state check, the external-refresh snapshot restore, the
//!    stored `source_config.processing_error` payload, the `failed`
//!    transition, and the `COMMIT`.
//! 3. The endpoint reloads the document after `conversion_started` and answers
//!    `ConversionStatusResponse(ok, document_exists)`.
//!
//! The driver interpolates the bound values into the `COM_QUERY` text (the
//! source uses PyMySQL), so the statements are built with the same aliased
//! projection and literal rendering the recorded exchanges contain.
use std::collections::BTreeSet;

use brz_mysql::Mysql;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::attachments::upload::Param;
use crate::http_compat::FastApiError;
use crate::internal_callback::py_json::python_dumps;
use crate::knowledge_documents_content::reader::{self, DocumentRow};
use crate::state::AppState;

/// `CONVERSION_START_STATUSES` (`shared/knowledge_module/documents.py`).
const CONVERSION_START_STATUSES: [&str; 2] = ["queued", "pending_conversion"];
/// `ACTIVE_INDEX_STATUSES` (`shared/knowledge_module/index_state.py`).
const ACTIVE_INDEX_STATUSES: [&str; 4] = ["queued", "pending_conversion", "converting", "indexing"];
/// `EXTERNAL_REFRESH_SNAPSHOT_KEY` (`external_refresh_snapshot.py`).
const REFRESH_SNAPSHOT_KEY: &str = "_pending_external_refresh";
/// `DocumentProcessingStage.CONVERSION`.
const CONVERSION_STAGE: &str = "conversion";
/// `DocumentProcessingStage.SYSTEM`.
const SYSTEM_STAGE: &str = "system";
/// `DocumentProcessingError` field bounds (`app/schemas/knowledge.py`).
const CODE_MAX_CHARS: usize = 64;
const MESSAGE_MAX_CHARS: usize = 1000;
const PROVIDER_MAX_CHARS: usize = 64;
const MODEL_MAX_CHARS: usize = 128;
const REQUEST_ID_MAX_CHARS: usize = 128;
/// `DocumentIndexStatus` / `DocumentStatus` values.
const INDEX_STATUSES: [&str; 7] = [
    "not_indexed",
    "queued",
    "pending_conversion",
    "converting",
    "indexing",
    "success",
    "failed",
];
const DOCUMENT_STATUSES: [&str; 2] = ["enabled", "disabled"];

/// `ConversionStatusRequest.action` (`Literal[...]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Started,
    Failed,
}

/// `ConversionStatusRequest` (`app/schemas/conversion_callback.py`).
#[derive(Debug)]
struct StatusRequest {
    action: Action,
    document_id: i64,
    generation: i64,
    error_message: Option<String>,
    error_code: Option<String>,
    user_message: Option<String>,
    retryable: Option<bool>,
    provider: Option<String>,
    model: Option<String>,
    request_id: Option<String>,
}

/// `ConversionStatusResponse`; field order is the pydantic declaration order.
#[derive(Debug, Serialize)]
struct ConversionStatusResponse {
    ok: bool,
    document_exists: bool,
}

/// `POST /api/internal/conversion/callback/status`.
#[brz_http_server::post("/api/internal/conversion/callback/status")]
async fn conversion_status_callback(
    #[inject(state)] state: &AppState,
    #[auth] _service: crate::internal_auth::InternalService,
    body: Value,
) -> Result<ConversionStatusResponse, FastApiError> {
    let request = parse_status_request(&body)?;
    conversion_status_value(&state.mysql, &request).await
}

/// Handler body for `POST /api/internal/conversion/callback/status`.
async fn conversion_status_value<M: Mysql>(
    mysql: &M,
    request: &StatusRequest,
) -> Result<ConversionStatusResponse, FastApiError> {
    match request.action {
        Action::Started => {
            let ok = mark_document_conversion_started(mysql, request).await?;
            let document = document_by_id(mysql, request.document_id).await?;
            Ok(ConversionStatusResponse {
                ok,
                document_exists: document.is_some(),
            })
        }
        Action::Failed => {
            // The endpoint loads the document before the failure transition;
            // a missing document skips the transition but still reports
            // `document_exists=false`.
            let document = document_by_id(mysql, request.document_id).await?;
            if document.is_some() {
                let error = build_conversion_callback_error(request);
                mark_document_index_failed(mysql, request, &error).await?;
            }
            Ok(ConversionStatusResponse {
                ok: true,
                document_exists: document.is_some(),
            })
        }
    }
}

/// `mark_document_conversion_started`: lock the row, accept only the
/// `queued`/`pending_conversion` pre-state at the requested generation, then
/// write `converting` and commit.
async fn mark_document_conversion_started<M: Mysql>(
    mysql: &M,
    request: &StatusRequest,
) -> Result<bool, FastApiError> {
    let (document, _) = lock_document(mysql, request.document_id).await?;
    let Some(document) = document else {
        rollback(mysql).await?;
        return Ok(false);
    };
    let status = document_status(&document.knowledge_documents_index_status);
    if !decide_conversion_started(
        request.generation,
        document.knowledge_documents_index_generation,
        status,
    ) {
        rollback(mysql).await?;
        return Ok(false);
    }
    mysql
        .execute(
            "UPDATE knowledge_documents SET index_status='converting', updated_at=now() \
             WHERE knowledge_documents.id = ?"
                .to_string(),
            vec![Param::Int(request.document_id)],
        )
        .await
        .map_err(internal_failure)?;
    commit(mysql).await?;
    Ok(true)
}

/// `shared.knowledge_module.documents.decide_conversion_started`.
fn decide_conversion_started(generation: i64, current_generation: i64, status: &str) -> bool {
    current_generation == generation && CONVERSION_START_STATUSES.contains(&status)
}

/// `mark_document_index_failed` for the callback path
/// (`preserve_active_sync_index=False`, `require_stale=False`).
async fn mark_document_index_failed<M: Mysql>(
    mysql: &M,
    request: &StatusRequest,
    error: &ProcessingError,
) -> Result<bool, FastApiError> {
    let (document, external_rows) = lock_document(mysql, request.document_id).await?;
    let Some(document) = document else {
        rollback(mysql).await?;
        return Ok(false);
    };
    let status = document_status(&document.knowledge_documents_index_status);
    if document.knowledge_documents_index_generation != request.generation
        || !ACTIVE_INDEX_STATUSES.contains(&status)
    {
        rollback(mysql).await?;
        return Ok(false);
    }

    let flushed = FailureColumns::of(&document);
    let mut columns = flushed.clone();
    let cleanup_attachment_ids =
        restore_external_refresh_snapshot(&mut columns, request.generation);
    let snapshot_restored = cleanup_attachment_ids.is_some();
    let sync_enabled = columns.sync_enabled();
    let persisted = normalize_processing_error(error, request.generation);

    if !snapshot_restored {
        columns.source_config.insert(
            "processing_error".to_string(),
            persisted.payload(request.generation),
        );
        columns.index_status = "failed".to_string();
    }
    // `document.has_external_identity` is the `selectin` relationship row.
    let external_identity = external_rows > 0;
    if external_identity
        && (snapshot_restored
            || matches!(
                persisted.code.as_str(),
                "external_source_unavailable" | "external_source_missing"
            ))
    {
        columns.update_external_health(&persisted, sync_enabled);
    }

    if let Some((sql, params)) = columns.statement(&flushed, request.document_id) {
        mysql.execute(sql, params).await.map_err(internal_failure)?;
    }
    commit(mysql).await?;

    if let Some(attachment_ids) = cleanup_attachment_ids
        && !attachment_ids.is_empty()
    {
        // The source reaps the superseded/staged bodies best-effort after the
        // commit (`_cleanup_external_refresh_attachments`). The callback's
        // recorded behavior never reaches this branch; the physical attachment
        // deletion is left to the attachment lifecycle owner.
        tracing::warn!(
            document_id = request.document_id,
            ?attachment_ids,
            "converted refresh snapshot restored with superseded attachments"
        );
    }
    Ok(true)
}

/// The document load shared by both callback branches
/// (`db.query(KnowledgeDocument).filter(id).first()` plus the `selectin`
/// external-source load).
async fn document_by_id<M: Mysql>(
    mysql: &M,
    document_id: i64,
) -> Result<Option<DocumentRow>, FastApiError> {
    reader::document_by_id(mysql, document_id)
        .await
        .map_err(internal_failure)
}

/// `db.query(KnowledgeDocument).with_for_update().first()`: the row lock and
/// the `selectin` external-source load, with the loaded identity-row count.
async fn lock_document<M: Mysql>(
    mysql: &M,
    document_id: i64,
) -> Result<(Option<DocumentRow>, usize), FastApiError> {
    let row: Option<DocumentRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {columns} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.id = {document_id} \n LIMIT 1 FOR UPDATE",
                columns = reader::DOCUMENT_COLUMNS
            ),
            (),
        )
        .await
        .map_err(internal_failure)?;
    let external_rows = reader::external_source_rows(mysql, &[document_id])
        .await
        .map_err(internal_failure)?;
    Ok((row, external_rows))
}

async fn commit<M: Mysql>(mysql: &M) -> Result<(), FastApiError> {
    mysql
        .execute("COMMIT", ())
        .await
        .map(|_| ())
        .map_err(internal_failure)
}

async fn rollback<M: Mysql>(mysql: &M) -> Result<(), FastApiError> {
    mysql
        .execute("ROLLBACK", ())
        .await
        .map(|_| ())
        .map_err(internal_failure)
}

fn internal_failure(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "conversion callback database dependency failure");
    FastApiError::unhandled()
}

/// `index_status or DocumentIndexStatus.NOT_INDEXED`.
fn document_status(status: &str) -> &str {
    if status.is_empty() {
        "not_indexed"
    } else {
        status
    }
}

// --- Failure transition state -------------------------------------------------

/// The mutable `knowledge_documents` projection the failure transition writes,
/// in mapper column order.
#[derive(Clone, Debug)]
struct FailureColumns {
    attachment_id: i64,
    file_extension: String,
    file_size: i64,
    status: String,
    is_active: i64,
    index_status: String,
    source_config: Map<String, Value>,
}

impl FailureColumns {
    fn of(document: &DocumentRow) -> Self {
        Self {
            attachment_id: document.knowledge_documents_attachment_id,
            file_extension: document.knowledge_documents_file_extension.clone(),
            file_size: document.knowledge_documents_file_size,
            status: document.knowledge_documents_status.clone(),
            is_active: i64::from(document.knowledge_documents_is_active),
            index_status: document_status(&document.knowledge_documents_index_status).to_string(),
            // `dict(self.source_config or {})`.
            source_config: document.source_config_map().unwrap_or_default(),
        }
    }

    fn sync_enabled(&self) -> bool {
        self.source_config
            .get("external")
            .and_then(Value::as_object)
            .and_then(|external| external.get("sync"))
            .and_then(Value::as_object)
            .and_then(|sync| sync.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// `document.update_external_source_config(status=..., last_error=...)`.
    fn update_external_health(&mut self, error: &ProcessingError, sync_enabled: bool) {
        let mut external = self
            .source_config
            .get("external")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let source_unavailable = matches!(
            error.code.as_str(),
            "external_source_unavailable" | "external_source_missing"
        );
        external.insert(
            "status".to_string(),
            json!(if source_unavailable {
                "inaccessible"
            } else {
                "sync_error"
            }),
        );
        external.insert("last_error".to_string(), json!(error.message));
        if sync_enabled && let Some(sync) = external.get("sync").and_then(Value::as_object).cloned()
        {
            let mut sync = sync;
            sync.insert("last_error_code".to_string(), json!(error.code));
            external.insert("sync".to_string(), Value::Object(sync));
        }
        self.source_config
            .insert("external".to_string(), Value::Object(external));
    }

    /// The SQLAlchemy flush: the dirty attributes in mapper column order plus
    /// `updated_at=now()`.
    fn statement(&self, flushed: &Self, document_id: i64) -> Option<(String, Vec<Param>)> {
        let mut assignments: Vec<&str> = Vec::new();
        let mut params: Vec<Param> = Vec::new();
        if self.attachment_id != flushed.attachment_id {
            assignments.push("attachment_id=?");
            params.push(Param::Int(self.attachment_id));
        }
        if self.file_extension != flushed.file_extension {
            assignments.push("file_extension=?");
            params.push(Param::Text(self.file_extension.clone()));
        }
        if self.file_size != flushed.file_size {
            assignments.push("file_size=?");
            params.push(Param::Int(self.file_size));
        }
        if self.status != flushed.status {
            assignments.push("status=?");
            params.push(Param::Text(self.status.clone()));
        }
        if self.is_active != flushed.is_active {
            assignments.push("is_active=?");
            params.push(Param::Int(self.is_active));
        }
        if self.index_status != flushed.index_status {
            assignments.push("index_status=?");
            params.push(Param::Text(self.index_status.clone()));
        }
        if self.source_config != flushed.source_config {
            assignments.push("source_config=?");
            // SQLAlchemy's JSON column binds `json.dumps(...)` with CPython's
            // default separators and ASCII escaping.
            params.push(Param::Text(python_dumps(&Value::Object(
                self.source_config.clone(),
            ))));
        }
        if assignments.is_empty() {
            return None;
        }
        let sql = format!(
            "UPDATE knowledge_documents SET {}, updated_at=now() \
             WHERE knowledge_documents.id = ?",
            assignments.join(", ")
        );
        params.push(Param::Int(document_id));
        Some((sql, params))
    }
}

/// `restore_external_refresh_snapshot(document, generation)`: restore the
/// pre-refresh body when a snapshot for this generation is pending, and return
/// the superseded attachment ids to reap.
fn restore_external_refresh_snapshot(
    columns: &mut FailureColumns,
    generation: i64,
) -> Option<BTreeSet<i64>> {
    let snapshot = columns
        .source_config
        .get(REFRESH_SNAPSHOT_KEY)?
        .as_object()?
        .clone();
    if snapshot.get("generation").and_then(Value::as_i64) != Some(generation) {
        return None;
    }

    let current_attachment_id = columns.attachment_id;
    let current_converted_id = columns
        .source_config
        .get("converted_attachment_id")
        .and_then(Value::as_i64);
    let staged_attachment_id = snapshot_int(&snapshot, "staged_attachment_id");
    let previous_attachment_id = snapshot_int(&snapshot, "previous_attachment_id");
    let previous_converted_id = snapshot
        .get("previous_converted_attachment_id")
        .and_then(Value::as_i64);
    let previous_file_extension = snapshot
        .get("previous_file_extension")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&columns.file_extension)
        .to_string();
    let previous_file_size = snapshot_int(&snapshot, "previous_file_size");
    let previous_is_active = snapshot
        .get("previous_is_active")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let previous_index_status = snapshot_string(&snapshot, "previous_index_status")
        .filter(|value| INDEX_STATUSES.contains(value))
        .unwrap_or("failed")
        .to_string();
    let previous_document_status = snapshot_string(&snapshot, "previous_document_status")
        .filter(|value| DOCUMENT_STATUSES.contains(value))
        .unwrap_or(&columns.status)
        .to_string();

    columns.source_config.remove(REFRESH_SNAPSHOT_KEY);
    match previous_converted_id {
        Some(value) => {
            columns
                .source_config
                .insert("converted_attachment_id".to_string(), json!(value));
        }
        None => {
            columns.source_config.remove("converted_attachment_id");
        }
    }
    match snapshot.get("previous_processing_error") {
        Some(Value::Object(value)) => {
            columns
                .source_config
                .insert("processing_error".to_string(), Value::Object(value.clone()));
        }
        _ => {
            columns.source_config.remove("processing_error");
        }
    }

    let mut external = columns
        .source_config
        .get("external")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(sync) = external.get("sync").and_then(Value::as_object).cloned() {
        let mut sync = sync;
        if snapshot
            .get("had_content_version")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            sync.insert(
                "content_version".to_string(),
                snapshot
                    .get("previous_content_version")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
        } else {
            sync.remove("content_version");
        }
        external.insert("sync".to_string(), Value::Object(sync));
    }
    if snapshot
        .get("had_source_update_time")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        external.insert(
            "source_update_time".to_string(),
            snapshot
                .get("previous_source_update_time")
                .cloned()
                .unwrap_or(Value::Null),
        );
    } else {
        external.remove("source_update_time");
    }
    columns
        .source_config
        .insert("external".to_string(), Value::Object(external));

    columns.attachment_id = previous_attachment_id;
    columns.file_extension = previous_file_extension;
    columns.file_size = previous_file_size;
    columns.is_active = i64::from(previous_is_active);
    columns.index_status = previous_index_status;
    columns.status = previous_document_status;

    let retained = [previous_attachment_id, previous_converted_id.unwrap_or(0)];
    let mut cleanup: BTreeSet<i64> = BTreeSet::new();
    for attachment_id in [
        current_attachment_id,
        current_converted_id.unwrap_or(0),
        staged_attachment_id,
    ] {
        if attachment_id != 0 && !retained.contains(&attachment_id) {
            cleanup.insert(attachment_id);
        }
    }
    Some(cleanup)
}

fn snapshot_int(snapshot: &Map<String, Value>, key: &str) -> i64 {
    match snapshot.get(key) {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(value)) => value.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn snapshot_string<'a>(snapshot: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    snapshot.get(key).and_then(Value::as_str)
}

// --- Processing errors --------------------------------------------------------

/// `DocumentProcessingError` as the failure transition persists it.
#[derive(Clone, Debug)]
struct ProcessingError {
    stage: &'static str,
    code: String,
    message: String,
    retryable: bool,
    provider: Option<String>,
    model: Option<String>,
    request_id: Option<String>,
}

impl ProcessingError {
    /// `DocumentProcessingError.model_dump(mode="json")`.
    fn payload(&self, generation: i64) -> Value {
        json!({
            "stage": self.stage,
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "generation": generation,
            "occurred_at": iso8601_z(Utc::now()),
            "provider": self.provider,
            "model": self.model,
            "request_id": self.request_id,
        })
    }
}

/// `build_conversion_callback_error`: a validated structured error wins; a
/// malformed one falls back to the legacy message mapping.
fn build_conversion_callback_error(request: &StatusRequest) -> ProcessingError {
    let structured = request
        .error_code
        .as_deref()
        .filter(|value| !value.is_empty())
        .zip(
            request
                .user_message
                .as_deref()
                .filter(|value| !value.is_empty()),
        );
    if let Some((code, message)) = structured {
        let valid = code.chars().count() <= CODE_MAX_CHARS
            && message.chars().count() <= MESSAGE_MAX_CHARS
            && request.generation >= 0
            && field_within(&request.provider, PROVIDER_MAX_CHARS)
            && field_within(&request.model, MODEL_MAX_CHARS)
            && field_within(&request.request_id, REQUEST_ID_MAX_CHARS);
        if valid {
            return ProcessingError {
                stage: CONVERSION_STAGE,
                code: code.to_string(),
                message: message.to_string(),
                retryable: request.retryable.unwrap_or(false),
                provider: request.provider.clone(),
                model: request.model.clone(),
                request_id: request.request_id.clone(),
            };
        }
        tracing::warn!(
            generation = request.generation,
            code_length = code.chars().count(),
            message_length = message.chars().count(),
            "Invalid structured conversion error; using legacy fallback"
        );
    }
    map_legacy_conversion_error(request.error_message.as_deref())
}

fn field_within(value: &Option<String>, max: usize) -> bool {
    value
        .as_deref()
        .is_none_or(|text| text.chars().count() <= max)
}

/// `map_legacy_conversion_error`.
fn map_legacy_conversion_error(error_message: Option<&str>) -> ProcessingError {
    let normalized = error_message.unwrap_or_default().to_lowercase();
    let (code, message, retryable) = if normalized.contains("quota")
        || normalized.contains("额度已用完")
    {
        (
            "model_quota_exhausted",
            "The selected model quota has been exhausted. \
             Switch models or contact an administrator.",
            false,
        )
    } else if normalized.contains("permission_denied") || normalized.contains("permission denied") {
        (
            "model_permission_denied",
            "The selected model is not available to the current account. \
             Check its permissions or select another model.",
            false,
        )
    } else if normalized.contains("timeout") || normalized.contains("deadline") {
        (
            "conversion_timeout",
            "Document conversion timed out. Please retry.",
            true,
        )
    } else if normalized.contains("readerror") || normalized.contains("connecterror") {
        (
            "conversion_service_unavailable",
            "The document conversion service could not be reached. \
             Please retry later.",
            true,
        )
    } else {
        (
            "conversion_failed",
            "Document conversion failed. Please retry.",
            true,
        )
    };
    ProcessingError {
        stage: CONVERSION_STAGE,
        code: code.to_string(),
        message: message.to_string(),
        retryable,
        provider: None,
        model: None,
        request_id: None,
    }
}

/// `_normalize_processing_error`: stamp the attempt identity, falling back to
/// the generic system error when the candidate cannot be persisted.
fn normalize_processing_error(candidate: &ProcessingError, generation: i64) -> ProcessingError {
    let valid = generation >= 0
        && !candidate.code.is_empty()
        && candidate.code.chars().count() <= CODE_MAX_CHARS
        && !candidate.message.is_empty()
        && candidate.message.chars().count() <= MESSAGE_MAX_CHARS
        && field_within(&candidate.provider, PROVIDER_MAX_CHARS)
        && field_within(&candidate.model, MODEL_MAX_CHARS)
        && field_within(&candidate.request_id, REQUEST_ID_MAX_CHARS);
    if valid {
        return candidate.clone();
    }
    ProcessingError {
        stage: SYSTEM_STAGE,
        code: "processing_failed".to_string(),
        message: "Document processing failed. Please retry.".to_string(),
        retryable: true,
        provider: None,
        model: None,
        request_id: None,
    }
}

/// Pydantic's JSON rendering of an aware UTC datetime:
/// `2026-10-16T03:40:13.055129Z`, with the fraction omitted at zero micros.
fn iso8601_z(value: DateTime<Utc>) -> String {
    let micros = value.timestamp_subsec_micros();
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if micros == 0 {
        format!("{base}Z")
    } else {
        format!("{base}.{micros:06}Z")
    }
}

// --- Request binding ----------------------------------------------------------

/// FastAPI validates the JSON body against `ConversionStatusRequest` before
/// the endpoint body runs; failures render the pydantic v2 error array.
fn parse_status_request(body: &Value) -> Result<StatusRequest, FastApiError> {
    let Some(object) = body.as_object() else {
        return Err(FastApiError::validation(json!([{
            "type": "model_attributes_type",
            "loc": ["body"],
            "msg": "Input should be a valid dictionary or object to extract fields from",
            "input": body,
        }])));
    };
    let action = match object.get("action") {
        None => {
            return Err(body_field_error(
                "missing",
                "action",
                "Field required".to_string(),
                body,
            ));
        }
        Some(Value::String(value)) if value == "conversion_started" => Action::Started,
        Some(Value::String(value)) if value == "conversion_failed" => Action::Failed,
        Some(value) => {
            return Err(body_field_error(
                "literal_error",
                "action",
                "Input should be 'conversion_started' or 'conversion_failed'".to_string(),
                value,
            ));
        }
    };
    let document_id = required_int(object, "document_id", body)?;
    let generation = required_int(object, "generation", body)?;
    let retryable = match object.get("retryable") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(value) => {
            return Err(body_field_error(
                "bool_type",
                "retryable",
                "Input should be a valid boolean".to_string(),
                value,
            ));
        }
    };
    Ok(StatusRequest {
        action,
        document_id,
        generation,
        error_message: optional_string(object, "error_message")?,
        error_code: optional_string(object, "error_code")?,
        user_message: optional_string(object, "user_message")?,
        retryable,
        provider: optional_string(object, "provider")?,
        model: optional_string(object, "model")?,
        request_id: optional_string(object, "request_id")?,
    })
}

fn required_int(
    object: &Map<String, Value>,
    field: &str,
    body: &Value,
) -> Result<i64, FastApiError> {
    match object.get(field) {
        None => Err(body_field_error(
            "missing",
            field,
            "Field required".to_string(),
            body,
        )),
        Some(value) => pydantic_int(value).ok_or_else(|| {
            body_field_error(
                "int_type",
                field,
                "Input should be a valid integer".to_string(),
                value,
            )
        }),
    }
}

/// Pydantic v2's lax `int` binding: integers, integral floats, and numeric
/// strings. Booleans are not integers.
fn pydantic_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|float| float.fract() == 0.0)
                .map(|float| float as i64)
        }),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, FastApiError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(value) => Err(body_field_error(
            "string_type",
            field,
            "Input should be a valid string".to_string(),
            value,
        )),
    }
}

fn body_field_error(error_type: &str, field: &str, message: String, input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": error_type,
        "loc": ["body", field],
        "msg": message,
        "input": input,
    }]))
}

#[cfg(test)]
#[path = "conversion_callback_tests.rs"]
mod tests;
