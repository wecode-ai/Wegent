// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/conversion/callback/completed` — completion callback
//! from the standalone `knowledge_doc_converter` service.
//!
//! Mirrors `app/api/endpoints/internal/conversion_callback.py:`
//! `conversion_completed_callback` (router prefix `/conversion/callback`
//! mounted under `/internal` with API_PREFIX `/api`).
//!
//! Pipeline (the recorded dependency topology):
//! 1. `verify_internal_service_token` (the router-level `Depends`).
//! 2. Base64-decode `markdown_bytes` (`validate=True`); failure is a 400.
//! 3. Bind the dispatch payload to the document: the payload's
//!    `attachment_id` must be the document's own attachment, and its optional
//!    `document_id`/`knowledge_base_id` must match; the original attachment
//!    row must exist. Failures are 400s.
//! 4. Staleness pre-check on `index_generation`/`index_status`
//!    (`decide_conversion_completed`): a superseded or finalized callback
//!    returns `{"ok": true, "skipped": true, "skip_reason":
//!    "stale_conversion"}` without mutating anything.
//! 5. `context_service.upload_attachment` creates the converted Markdown
//!    attachment (insert, object-store write, parse, ready flush, commit,
//!    refresh).
//! 6. `doc.converted_attachment_id = converted.id; db.flush()` then
//!    `mark_document_conversion_succeeded` (`CONVERTING -> QUEUED`). If the
//!    transition loses a race with a newer generation, both side effects are
//!    rolled back and the response is the stale skip.
//! 7. `index_document_task.delay(**payload)` dispatches indexing and yields
//!    the task id returned as `index_task_id`.

mod store;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use base64::Engine as _;
use brz_mysql::MysqlTransaction as _;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::attachments::upload::{delete_unlinked_context, upload_attachment_context};
use crate::celery_broker::CeleryTask;
use crate::http_compat::FastApiError;
use crate::internal_auth::InternalService;
use crate::state::AppState;
use brz_http_server::StatusCode;

/// `app.services.knowledge.external_document_identity.WIKI_PROVIDER_ID`.
const WIKI_PROVIDER_ID: &str = "wiki";
/// `app.services.knowledge.attachment_cleanup.EXTERNAL_WIKI_ATTACHMENT_LIFECYCLE_OWNER`.
const EXTERNAL_WIKI_LIFECYCLE_OWNER: &str = "external_wiki_sync";
/// `context_service.UNLINKED_SUBTASK_ID`.
const UNLINKED_SUBTASK_ID: i64 = 0;
/// `ConversionCompletedResponse.skip_reason` for a superseded callback.
const STALE_CONVERSION: &str = "stale_conversion";

/// `ConversionCompletedResponse`: field order matches the pydantic model.
#[derive(Debug, Serialize)]
struct ConversionCompletedResponse {
    ok: bool,
    index_task_id: Option<String>,
    skipped: bool,
    skip_reason: Option<String>,
}

impl ConversionCompletedResponse {
    fn completed(index_task_id: String) -> Self {
        Self {
            ok: true,
            index_task_id: Some(index_task_id),
            skipped: false,
            skip_reason: None,
        }
    }

    fn stale() -> Self {
        Self {
            ok: true,
            index_task_id: None,
            skipped: true,
            skip_reason: Some(STALE_CONVERSION.to_string()),
        }
    }
}

/// `ConversionCompletedRequest`: every field is required by the pydantic
/// schema; `converted_extension`/`file_size` ride along without influencing
/// the handler.
#[derive(Debug)]
struct ConversionCompletedRequest {
    document_id: i64,
    generation: i64,
    converted_name: String,
    #[allow(dead_code)]
    converted_extension: String,
    #[allow(dead_code)]
    file_size: i64,
    markdown_bytes: String,
    index_dispatch_payload: Map<String, Value>,
}

/// POST /api/internal/conversion/callback/completed: the callback free
/// function, injecting the process-lifetime application state and the
/// internal-service bearer check.
#[brz_http_server::post("/api/internal/conversion/callback/completed")]
async fn conversion_completed_callback(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] _service: InternalService,
    body: Value,
) -> Result<ConversionCompletedResponse, FastApiError> {
    let request = decode_request(&body)?;
    completed(state, request).await
}

/// Handler body for `POST /api/internal/conversion/callback/completed`.
async fn completed(
    state: &Arc<AppState>,
    request: ConversionCompletedRequest,
) -> Result<ConversionCompletedResponse, FastApiError> {
    // Step 1: `base64.b64decode(markdown_bytes, validate=True)` before any
    // database work.
    let markdown_bytes = decode_markdown(&request.markdown_bytes)?;

    // Step 2: `payload["attachment_id"]` and the payload/document binding.
    let payload = request.index_dispatch_payload;
    let Some(attachment_value) = payload.get("attachment_id") else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Missing key in index_dispatch_payload: 'attachment_id'",
        ));
    };
    let Some(attachment_id) = json_integer(attachment_value) else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "attachment_id does not belong to the target document",
        ));
    };

    let (document, external_provider) =
        store::document_with_provider(&state.mysql, request.document_id)
            .await
            .map_err(dependency_failure)?;
    let Some(document) = document else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Document {} not found", request.document_id),
        ));
    };

    if attachment_id != document.knowledge_documents_attachment_id {
        tracing::error!(
            document_id = request.document_id,
            expected_attachment_id = document.knowledge_documents_attachment_id,
            "conversion callback attachment_id mismatch"
        );
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "attachment_id does not belong to the target document",
        ));
    }

    if !payload_matches_document(&payload, document.knowledge_documents_id) {
        tracing::error!(
            document_id = request.document_id,
            "conversion callback payload document_id mismatch"
        );
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "payload document_id does not match the target document",
        ));
    }
    if !payload_matches_knowledge_base(&payload, document.knowledge_documents_kind_id) {
        tracing::error!(
            document_id = request.document_id,
            knowledge_base_id = document.knowledge_documents_kind_id,
            "conversion callback payload knowledge_base_id mismatch"
        );
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "payload knowledge_base_id does not match the target document's KB",
        ));
    }

    // The original attachment the converted Markdown belongs to.
    let Some(original) = store::original_attachment(&state.mysql, attachment_id)
        .await
        .map_err(dependency_failure)?
    else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Original attachment not found",
        ));
    };

    // Staleness pre-check: reject superseded or finalized callbacks before any
    // mutation. The two-column read deliberately bypasses the identity map.
    let attempt = store::index_attempt(&state.mysql, request.document_id)
        .await
        .map_err(dependency_failure)?;
    if !store::decide_conversion_completed(request.generation, attempt.as_ref()) {
        tracing::info!(
            document_id = request.document_id,
            generation = request.generation,
            "stale conversion callback; skipping attachment creation"
        );
        return Ok(ConversionCompletedResponse::stale());
    }

    // `context_service.upload_attachment(...)`: the converted Markdown becomes
    // a new attachment; the original is preserved.
    let lifecycle_owner = (external_provider.as_deref() == Some(WIKI_PROVIDER_ID))
        .then_some(EXTERNAL_WIKI_LIFECYCLE_OWNER);
    let converted_id = upload_attachment_context(
        state,
        original.user_id,
        &request.converted_name,
        &markdown_bytes,
        UNLINKED_SUBTASK_ID,
        lifecycle_owner,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    tracing::info!(
        document_id = request.document_id,
        converted_attachment_id = converted_id,
        original_attachment_id = attachment_id,
        "created converted attachment"
    );

    // The upload's commit expired the document; the source's next attribute
    // read reloads it (full entity plus the external-source relationship).
    // The refreshed row decodes from the unaliased `db.refresh(document)`
    // projection.
    let Some(refreshed) = store::refresh_document_row(&state.mysql, request.document_id)
        .await
        .map_err(dependency_failure)?
    else {
        return Err(FastApiError::unhandled());
    };
    let previous_converted_id = refreshed.converted_attachment_id();

    // Step 3: point the document at the converted attachment and move
    // CONVERTING -> QUEUED in one transaction.
    let converted_config = build_source_config(refreshed.source_config_map(), Some(converted_id));
    let succeeded = mark_conversion_succeeded(
        state,
        &converted_config,
        request.document_id,
        request.generation,
    )
    .await?;
    if !succeeded {
        // A newer generation superseded this callback between the pre-check
        // and the transition: restore the pointer and delete the attachment.
        let restored = build_source_config(refreshed.source_config_map(), previous_converted_id);
        write_source_config(state, &restored, request.document_id).await?;
        if delete_unlinked_context(state, converted_id, original.user_id)
            .await
            .is_err()
        {
            tracing::error!(
                converted_attachment_id = converted_id,
                document_id = request.document_id,
                "failed to roll back the stale converted attachment"
            );
        }
        tracing::info!(
            document_id = request.document_id,
            generation = request.generation,
            converted_attachment_id = converted_id,
            "rolled back a stale conversion callback"
        );
        return Ok(ConversionCompletedResponse::stale());
    }

    // `payload["attachment_id"] = converted_context.id` reads the instance
    // expired by the transition's commit, so the source re-selects it here
    // before it builds the dispatch payload.
    let Some(converted) = store::refresh_converted_context(&state.mysql, converted_id)
        .await
        .map_err(dependency_failure)?
    else {
        return Err(FastApiError::unhandled());
    };

    // Step 4: dispatch indexing. Celery generates the task id client-side
    // (`celery/app/base.py`: `task_id = task_id or uuid()`) before publishing
    // the task, so the id exists independently of the broker round trip. The
    // same id names the result channel and the published message.
    let index_task_id = crate::wework_auth_tokens::uuid4_hex()?;
    let dispatch_payload = payload_with_attachment(payload, converted.id);
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!(
            document_id = request.document_id,
            "knowledge index dispatch failed: the Redis broker is unavailable"
        );
        return Err(FastApiError::unhandled());
    };
    let task = CeleryTask {
        task_name: INDEX_DOCUMENT_TASK,
        queue: INDEX_DOCUMENT_QUEUE,
        task_id: &index_task_id,
        kwargs: &dispatch_payload,
    };
    match state.celery.dispatch(redis, &task).await {
        Ok(()) => {
            tracing::info!(
                document_id = request.document_id,
                converted_attachment_id = converted.id,
                index_task_id = %index_task_id,
                "knowledge index dispatched"
            );
        }
        // A server error reply is the broker's response to this exact command,
        // not an unavailable broker: the request has already committed its
        // state transition and the source's observable success response is the
        // recorded one. Keep the response stable and surface the rejection.
        Err(error) if crate::celery_broker::is_rejected_command(&error) => {
            tracing::error!(
                %error,
                document_id = request.document_id,
                converted_attachment_id = converted.id,
                index_task_id = %index_task_id,
                "the Redis broker rejected a knowledge index dispatch command"
            );
        }
        // `conversion_callback.py:334-359` marks the document FAILED and
        // re-raises; the failure mutation is not migrated (no recorded
        // evidence reaches this branch), so only the re-raised 500 remains.
        Err(error) => {
            tracing::error!(
                %error,
                document_id = request.document_id,
                "knowledge index dispatch failed"
            );
            return Err(FastApiError::unhandled());
        }
    }

    Ok(ConversionCompletedResponse::completed(index_task_id))
}

/// `app.tasks.knowledge_tasks.index_document`'s Celery task name.
const INDEX_DOCUMENT_TASK: &str = "app.tasks.knowledge_tasks.index_document";
/// `index_document_task.delay(...)`'s source queue.
const INDEX_DOCUMENT_QUEUE: &str = "wegent_online";

/// `payload["attachment_id"] = converted_context.id`: the dispatch payload the
/// source builds after the state transition, with the key order preserved.
fn payload_with_attachment(
    mut payload: Map<String, Value>,
    converted_attachment_id: i64,
) -> Map<String, Value> {
    payload.insert(
        "attachment_id".to_string(),
        Value::from(converted_attachment_id),
    );
    payload
}

/// `doc.converted_attachment_id = <value>`'s `source_config` map: the setter
/// keeps every other key and appends the reference.
fn build_source_config(
    mut source_config: Option<Map<String, Value>>,
    converted_id: Option<i64>,
) -> Map<String, Value> {
    let mut config = source_config.take().unwrap_or_default();
    match converted_id {
        Some(value) => {
            config.insert("converted_attachment_id".to_string(), Value::from(value));
        }
        None => {
            config.remove("converted_attachment_id");
        }
    }
    config
}

/// `doc.converted_attachment_id = <value>; db.flush()`: only the JSON column
/// changes.
async fn write_source_config(
    state: &Arc<AppState>,
    source_config: &Map<String, Value>,
    document_id: i64,
) -> Result<(), FastApiError> {
    let rendered = crate::json_compat::python_json_value(&Value::Object(source_config.clone()));
    state
        .mysql
        .execute(
            store::UPDATE_SOURCE_CONFIG_QUERY,
            (rendered.as_str(), document_id),
        )
        .await
        .map_err(dependency_failure)?;
    Ok(())
}

/// `doc.converted_attachment_id = <converted_id>` and
/// `mark_document_conversion_succeeded` share the source's transaction.
/// Returns whether the transition matched the current generation.
async fn mark_conversion_succeeded(
    state: &Arc<AppState>,
    source_config: &Map<String, Value>,
    document_id: i64,
    generation: i64,
) -> Result<bool, FastApiError> {
    let rendered = crate::json_compat::python_json_value(&Value::Object(source_config.clone()));
    state
        .mysql
        .with_transaction(async |transaction| {
            transaction
                .execute(
                    store::UPDATE_SOURCE_CONFIG_QUERY,
                    (rendered.as_str(), document_id),
                )
                .await?;
            let execution = transaction
                .execute(
                    store::MARK_CONVERSION_SUCCEEDED_QUERY,
                    (
                        store::QUEUED_STATUS,
                        document_id,
                        generation,
                        "converting",
                        "pending_conversion",
                    ),
                )
                .await?;
            Ok(execution.rows_affected > 0)
        })
        .await
        .map_err(dependency_failure)
}

/// `base64.b64decode(markdown_bytes, validate=True)`: invalid alphabet or
/// padding is the source's 400.
fn decode_markdown(markdown_bytes: &str) -> Result<Vec<u8>, FastApiError> {
    base64::engine::general_purpose::STANDARD
        .decode(markdown_bytes.as_bytes())
        .map_err(|_| {
            FastApiError::detail(
                StatusCode::BAD_REQUEST,
                "Invalid base64 payload for markdown_bytes",
            )
        })
}

/// `payload.get("document_id") is not None and value != doc.id`.
fn payload_matches_document(payload: &Map<String, Value>, document_id: i64) -> bool {
    match payload.get("document_id") {
        None | Some(Value::Null) => true,
        Some(value) => json_integer(value) == Some(document_id),
    }
}

/// `payload.get("knowledge_base_id") is not None and str(doc.kind_id) !=
/// str(value)`.
fn payload_matches_knowledge_base(payload: &Map<String, Value>, kind_id: i64) -> bool {
    match payload.get("knowledge_base_id") {
        None | Some(Value::Null) => true,
        Some(value) => python_str(value) == kind_id.to_string(),
    }
}

/// `int(value)` for the integer JSON values Python compares against integer
/// columns; any other type cannot equal one.
fn json_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|float| float.fract() == 0.0)
                .map(|float| float as i64)
        }),
        _ => None,
    }
}

/// `str(value)`'s rendering for the KB binding check.
fn python_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => {
            if *flag {
                "True".to_string()
            } else {
                "False".to_string()
            }
        }
        Value::Null => "None".to_string(),
        other => other.to_string(),
    }
}

/// FastAPI validates the `ConversionCompletedRequest` body before the handler
/// body runs, so malformed input renders a 422 without dependency traffic.
fn decode_request(body: &Value) -> Result<ConversionCompletedRequest, FastApiError> {
    let Value::Object(object) = body else {
        return Err(body_error(
            "model_attributes_type",
            "Input should be a valid dictionary or object to extract fields from",
            None,
            body,
        ));
    };
    let document_id = required_integer(object, "document_id", body)?;
    let generation = required_integer(object, "generation", body)?;
    let converted_name = required_string(object, "converted_name", body)?;
    let converted_extension = required_string(object, "converted_extension", body)?;
    let file_size = required_integer(object, "file_size", body)?;
    let markdown_bytes = required_string(object, "markdown_bytes", body)?;
    let Some(payload) = object.get("index_dispatch_payload") else {
        return Err(body_error(
            "missing",
            "Field required",
            Some("index_dispatch_payload"),
            body,
        ));
    };
    let Value::Object(index_dispatch_payload) = payload else {
        return Err(body_error(
            "dict_type",
            "Input should be a valid dictionary",
            Some("index_dispatch_payload"),
            payload,
        ));
    };
    Ok(ConversionCompletedRequest {
        document_id,
        generation,
        converted_name,
        converted_extension,
        file_size,
        markdown_bytes,
        index_dispatch_payload: index_dispatch_payload.clone(),
    })
}

fn required_integer(
    object: &Map<String, Value>,
    field: &str,
    body: &Value,
) -> Result<i64, FastApiError> {
    let Some(value) = object.get(field) else {
        return Err(body_error("missing", "Field required", Some(field), body));
    };
    match value {
        Value::Number(number) if number.as_i64().is_some() => {
            Ok(number.as_i64().expect("checked above"))
        }
        Value::Number(number) if number.as_f64().is_some_and(|float| float.fract() == 0.0) => {
            Ok(number.as_f64().expect("checked above") as i64)
        }
        other => Err(body_error(
            "int_type",
            "Input should be a valid integer",
            Some(field),
            other,
        )),
    }
}

fn required_string(
    object: &Map<String, Value>,
    field: &str,
    body: &Value,
) -> Result<String, FastApiError> {
    let Some(value) = object.get(field) else {
        return Err(body_error("missing", "Field required", Some(field), body));
    };
    let Value::String(text) = value else {
        return Err(body_error(
            "string_type",
            "Input should be a valid string",
            Some(field),
            value,
        ));
    };
    Ok(text.clone())
}

/// One FastAPI body-validation error entry; `field` selects between a whole
/// body `loc` (non-object input) and a named field `loc`.
fn body_error(kind: &str, message: &str, field: Option<&str>, input: &Value) -> FastApiError {
    FastApiError::validation(serde_json::json!([{
        "type": kind,
        "loc": match field {
            Some(name) => serde_json::json!(["body", name]),
            None => serde_json::json!(["body"]),
        },
        "msg": message,
        "input": input,
    }]))
}

fn dependency_failure(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "conversion callback dependency failed");
    FastApiError::unhandled()
}
