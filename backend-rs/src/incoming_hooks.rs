// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/incoming-hooks/{token}` — public project event ingestion.
//!
//! Mirrors `app.api.endpoints.project_incoming_hooks.receive_project_incoming_hook`
//! (`public_router` mounted at `/v1/incoming-hooks`) and
//! `project_incoming_hook_service.receive`
//! (`app/services/project_incoming_hooks.py:313-405`):
//! 1. `loop_items` public-id lookup filtered to `resource_type='incoming_hook'`
//!    and the unset-`deleted_at` sentinel set — a miss is 404
//!    "Event subscription not found".
//! 2. A non-`active` subscription is 410 "Event subscription is disabled";
//!    a collection mode outside `webhook`/`hybrid` is 405 "Event subscription
//!    does not accept webhook delivery".
//! 3. `parse_incoming_body`: 1 MiB cap, UTF-8, non-empty, JSON object (unless
//!    the content type announces JSON) — every failure is 400 with the
//!    source's message.
//! 4. The delivery identity is `sha256(f"{hook.id}:{source_type}:{delivery_id}")`
//!    truncated to 36 hex characters; `delivery_id` is the first non-empty
//!    `x-github-delivery`, `x-gitlab-event-uuid`, `idempotency-key`,
//!    `x-request-id`, else `sha256(raw_body)`.
//! 5. An event with that public id already exists -> the duplicate receipt.
//! 6. Otherwise one `incoming_event` row is inserted. The source's
//!    `before_insert` adapter reflects `loop_items` once (`SHOW CREATE TABLE`)
//!    to learn the NOT NULL sentinel columns, writes the row, commits, and
//!    `db.refresh` re-selects it, so the receipt's `eventId` is the persisted
//!    primary key.
//!
//! The route is unauthenticated: the source's public router declares no
//! security dependency, so the token is the only credential.
use brz_http_server::{Body, Response, StatusCode};
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, entity_columns};
use crate::hex_sha256;
use crate::http_compat::FastApiError;
use crate::json_compat::python_json_value;
use crate::state::AppState;

/// `parse_incoming_body`'s `MAX_BODY_BYTES`.
const MAX_BODY_BYTES: usize = 1_048_576;
/// `_event_metadata`'s `MAX_STORED_PAYLOAD_BYTES`.
const MAX_STORED_PAYLOAD_BYTES: usize = 65_536;
/// `_event_metadata` always starts a webhook event at attempt `0`.
const INITIAL_ATTEMPT_COUNT: i64 = 0;

const INCOMING_HOOK: &str = "incoming_hook";
const INCOMING_EVENT: &str = "incoming_event";

/// One `loop_items` subscription row, selected with the source's labeled
/// projection. Only the fields `receive` reads are decoded.
#[derive(Debug, FromMysqlRow)]
struct HookRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_cloud_project_id")]
    cloud_project_id: Option<String>,
    #[mysql(rename = "loop_items_status")]
    status: Option<String>,
    #[mysql(rename = "loop_items_source")]
    source: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    created_by_user_id: Option<i32>,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<OpaqueJson>>,
}

/// The hook metadata document (`metadata_json` on the source model).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct HookMetadata {
    source_type: Option<String>,
    collection_mode: Option<String>,
}

/// The existing-event duplicate probe reads the row id and source.
#[derive(Debug, FromMysqlRow)]
struct ExistingEventRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_source")]
    source: Option<String>,
}

/// `db.refresh(event)` re-selects the persisted primary key.
#[derive(Debug, FromMysqlRow)]
struct RefreshedEventRow {
    #[mysql(rename = "id")]
    id: String,
}

/// `ProjectIncomingReceipt`: aliases render `eventId`; field order follows the
/// source model, and `reason` keeps its explicit JSON `null`.
#[derive(Debug, Serialize)]
struct ProjectIncomingReceipt {
    status: &'static str,
    provider: String,
    #[serde(rename = "eventId")]
    event_id: String,
    reason: Option<String>,
}

impl ProjectIncomingReceipt {
    fn accepted(provider: String, event_id: String) -> Self {
        Self {
            status: "accepted",
            provider,
            event_id,
            reason: None,
        }
    }

    fn duplicate(provider: String, event_id: String) -> Self {
        Self {
            status: "duplicate",
            provider,
            event_id,
            reason: None,
        }
    }
}

/// `db.query(ProjectIncomingHook).filter(public_id == token,
/// loop_datetime_is_unset(deleted_at)).first()`.
fn hook_lookup_sql() -> String {
    format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.public_id = ? AND (loop_items.deleted_at IS NULL OR \
         loop_items.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.resource_type IN ('{INCOMING_HOOK}') \n LIMIT 1"
    )
}

/// `db.query(ProjectIncomingEvent).filter(public_id == event_public_id).first()`
/// — the polymorphic filter, without the deleted-at predicate.
fn event_by_public_id_sql() -> String {
    format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.public_id = ? AND \
         loop_items.resource_type IN ('{INCOMING_EVENT}') \n LIMIT 1"
    )
}

/// The source `before_insert` adapter's one-shot table reflection
/// (`loop_node_non_nullable_attributes` -> `inspect(connection).get_columns`),
/// which MySQL serves as `SHOW CREATE TABLE`.
const SHOW_CREATE_TABLE_SQL: &str = "SHOW CREATE TABLE `loop_items`";

/// The source's single-row `INSERT` for an `incoming_event`. Every value the
/// service does not pass is the model default or the MySQL NOT NULL sentinel
/// (`1970-01-01 00:00:01`) written by the `before_insert` adapter.
const INSERT_EVENT_SQL: &str = "INSERT INTO loop_items (id, resource_type, \
     project_space, cloud_project_id, parent_id, loop_item_id, delivery_id, \
     public_id, project_key, name, title, description, storage_prefix, \
     sequence_number, next_item_number, created_by_user_id, updated_by_user_id, \
     assignee_user_id, user_id, added_by_user_id, source, status, priority, \
     start_at, due_at, sort_order, current_delivery_id, local_project_id, \
     device_id, is_default, task_user_id, assignee_agent_id, assignee_team_id, \
     task_id, task_title, backend_task_id, linked_by_user_id, linked_at, \
     unlinked_at, path, kind, display_name, relative_path, object_key, \
     content_type, size_bytes, sha256, source_task_binding_id, \
     source_task_snapshot, markdown_object_key, chat_object_key, \
     manifest_object_key, metadata, version, created_at, updated_at, \
     completed_at, delivered_at, deleted_at) VALUES (?, 'incoming_event', \
     'default', ?, ?, '', '', ?, '', '', ?, '', '', 0, 1, ?, 0, 0, 0, 0, ?, \
     'received', '', '1970-01-01 00:00:01', '1970-01-01 00:00:01', 0, '', 0, \
     '', 0, 0, '', 0, '', '', 0, 0, '1970-01-01 00:00:01', \
     '1970-01-01 00:00:01', '', '', '', '', '', '', 0, '', '', '{}', '', '', \
     '', ?, 1, now(), now(), '1970-01-01 00:00:01', '1970-01-01 00:00:01', \
     '1970-01-01 00:00:01')";

/// `db.refresh(event)`: the ORM re-selects the stored row by primary key with
/// unaliased columns and the polymorphic filter.
fn refresh_event_sql() -> String {
    format!(
        "SELECT {} \nFROM loop_items \n\
         WHERE loop_items.id = ? AND loop_items.resource_type IN ('{INCOMING_EVENT}')",
        entity_columns()
    )
}

/// The request headers the source reads on the ingestion path.
struct IncomingHeaders<'a> {
    content_type: &'a str,
    github_event: &'a str,
    github_delivery: &'a str,
    gitlab_event: &'a str,
    gitlab_event_uuid: &'a str,
    idempotency_key: &'a str,
    request_id: &'a str,
    event_type: &'a str,
}

/// POST /api/v1/incoming-hooks/{token}: the public ingestion free function.
#[brz_http_server::post("/api/v1/incoming-hooks/:token", access = public)]
#[allow(clippy::too_many_arguments)]
async fn receive_project_incoming_hook(
    #[inject(state)] state: &AppState,
    token: &str,
    #[header("content-type")] content_type: Option<&str>,
    #[header("x-github-event")] github_event: Option<&str>,
    #[header("x-github-delivery")] github_delivery: Option<&str>,
    #[header("x-gitlab-event")] gitlab_event: Option<&str>,
    #[header("x-gitlab-event-uuid")] gitlab_event_uuid: Option<&str>,
    #[header("idempotency-key")] idempotency_key: Option<&str>,
    #[header("x-request-id")] request_id: Option<&str>,
    #[header("x-event-type")] event_type: Option<&str>,
    body: Body<'_>,
) -> Result<Response, FastApiError> {
    let headers = IncomingHeaders {
        content_type: content_type.unwrap_or(""),
        github_event: github_event.unwrap_or(""),
        github_delivery: github_delivery.unwrap_or(""),
        gitlab_event: gitlab_event.unwrap_or(""),
        gitlab_event_uuid: gitlab_event_uuid.unwrap_or(""),
        idempotency_key: idempotency_key.unwrap_or(""),
        request_id: request_id.unwrap_or(""),
        event_type: event_type.unwrap_or(""),
    };
    receive(state, token, &headers, body.0).await
}

/// Handler body for `POST /api/v1/incoming-hooks/{token}`.
async fn receive(
    state: &AppState,
    token: &str,
    headers: &IncomingHeaders<'_>,
    raw_body: &[u8],
) -> Result<Response, FastApiError> {
    let hook = state
        .mysql
        .fetch_optional::<_, _, HookRow>(hook_lookup_sql(), (token,))
        .await
        .map_err(dependency_error)?;
    let Some(hook) = hook else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Event subscription not found",
        ));
    };
    if hook.status.as_deref() != Some("active") {
        return Err(FastApiError::detail(
            StatusCode::GONE,
            "Event subscription is disabled",
        ));
    }

    let metadata = hook
        .metadata
        .as_ref()
        .and_then(|value| value.0.project::<HookMetadata>())
        .unwrap_or_default();
    let source_type = non_empty(metadata.source_type)
        .or_else(|| non_empty(hook.source.clone()))
        .unwrap_or_default();
    let collection_mode = non_empty(metadata.collection_mode).unwrap_or_default();
    if !matches!(collection_mode.as_str(), "webhook" | "hybrid") {
        return Err(FastApiError::detail(
            StatusCode::METHOD_NOT_ALLOWED,
            "Event subscription does not accept webhook delivery",
        ));
    }

    let payload = parse_incoming_body(raw_body, headers.content_type)
        .map_err(|message| FastApiError::detail(StatusCode::BAD_REQUEST, message))?;
    let event_public_id = event_public_id(&hook.id, &source_type, headers, raw_body);

    let existing = state
        .mysql
        .fetch_optional::<_, _, ExistingEventRow>(
            event_by_public_id_sql(),
            (event_public_id.as_str(),),
        )
        .await
        .map_err(dependency_error)?;
    if let Some(existing) = existing {
        return receipt_response(duplicate_receipt(&existing, &source_type));
    }

    let event_id = numeric_id();
    let title = delivery_name(&source_type, headers);
    let event_metadata = event_metadata(&payload, raw_body, headers);
    let cloud_project_id = hook.cloud_project_id.clone().unwrap_or_default();
    let created_by_user_id = hook.created_by_user_id.unwrap_or(0);

    // SQLAlchemy flushes the pending insert: the `before_insert` adapter
    // reflects the table once, then the row is written, then the commit.
    state
        .mysql
        .execute(SHOW_CREATE_TABLE_SQL, ())
        .await
        .map_err(dependency_error)?;
    let insert = state
        .mysql
        .execute(
            INSERT_EVENT_SQL,
            (
                event_id.as_str(),
                cloud_project_id.as_str(),
                hook.id.as_str(),
                event_public_id.as_str(),
                title.as_str(),
                created_by_user_id,
                source_type.as_str(),
                event_metadata.as_str(),
            ),
        )
        .await;
    match insert {
        Ok(_) => {}
        // `except IntegrityError`: roll back and return the row the winning
        // writer committed.
        Err(error) if is_duplicate_key(&error) => {
            let _ = state.mysql.execute("ROLLBACK", ()).await;
            let existing = state
                .mysql
                .fetch_one::<_, _, ExistingEventRow>(
                    event_by_public_id_sql(),
                    (event_public_id.as_str(),),
                )
                .await
                .map_err(dependency_error)?;
            return receipt_response(duplicate_receipt(&existing, &source_type));
        }
        Err(error) => return Err(dependency_error(error)),
    }
    state
        .mysql
        .execute("COMMIT", ())
        .await
        .map_err(dependency_error)?;

    // `db.refresh(event)` re-selects the committed row; `event.id` from that
    // read is what the receipt reports.
    let refreshed = state
        .mysql
        .fetch_optional::<_, _, RefreshedEventRow>(refresh_event_sql(), (event_id.as_str(),))
        .await
        .map_err(dependency_error)?;
    let Some(refreshed) = refreshed else {
        return Err(dependency_error(brz_mysql::MysqlError::RowNotFound));
    };
    receipt_response(ProjectIncomingReceipt::accepted(source_type, refreshed.id))
}

/// The duplicate receipt, using `existing.source or source_type`.
fn duplicate_receipt(existing: &ExistingEventRow, source_type: &str) -> ProjectIncomingReceipt {
    let provider = non_empty(existing.source.clone()).unwrap_or_else(|| source_type.to_string());
    ProjectIncomingReceipt::duplicate(provider, existing.id.clone())
}

/// FastAPI renders the receipt through its `JSONResponse` (status 202).
fn receipt_response(receipt: ProjectIncomingReceipt) -> Result<Response, FastApiError> {
    let body = serde_json::to_vec(&receipt)
        .map_err(|error| dependency_error_message("incoming-hook receipt serialization", &error))?;
    Ok(Response::owned_bytes(StatusCode::ACCEPTED, body).content_type("application/json"))
}

/// `_event_public_id`: `sha256(f"{hook.id}:{source_type}:{delivery_id}")[:36]`.
fn event_public_id(
    hook_id: &str,
    source_type: &str,
    headers: &IncomingHeaders<'_>,
    raw_body: &[u8],
) -> String {
    let delivery_id = first_non_empty(&[
        headers.github_delivery,
        headers.gitlab_event_uuid,
        headers.idempotency_key,
        headers.request_id,
    ])
    .unwrap_or_else(|| hex_sha256(raw_body));
    let identity = format!("{hook_id}:{source_type}:{delivery_id}");
    hex_sha256(identity.as_bytes())[..36].to_string()
}

/// `_delivery_name`: `f"{source_type}: {event_name}"[:255]`.
fn delivery_name(source_type: &str, headers: &IncomingHeaders<'_>) -> String {
    let event_name = first_non_empty(&[
        headers.github_event,
        headers.gitlab_event,
        headers.event_type,
    ])
    .unwrap_or_else(|| "event".to_string());
    format!("{source_type}: {event_name}")
        .chars()
        .take(255)
        .collect()
}

/// `_event_metadata`, serialized by SQLAlchemy's `json.dumps` default
/// (`", "`/`": "` separators, `ensure_ascii=True`, dict insertion order).
fn event_metadata(payload: &Value, raw_body: &[u8], headers: &IncomingHeaders<'_>) -> String {
    let mut document = Map::new();
    document.insert("schema_version".to_string(), json!(1));
    document.insert("collection_mode".to_string(), json!("webhook"));
    document.insert("attempt_count".to_string(), json!(INITIAL_ATTEMPT_COUNT));
    if raw_body.len() <= MAX_STORED_PAYLOAD_BYTES {
        document.insert("payload".to_string(), payload.clone());
    }
    document.insert("payload_sha256".to_string(), json!(hex_sha256(raw_body)));
    document.insert("payload_size".to_string(), json!(raw_body.len()));
    let mut stored_headers = Map::new();
    for (name, value) in [
        ("content-type", headers.content_type),
        ("x-github-event", headers.github_event),
        ("x-github-delivery", headers.github_delivery),
        ("x-gitlab-event", headers.gitlab_event),
        ("x-gitlab-event-uuid", headers.gitlab_event_uuid),
        ("idempotency-key", headers.idempotency_key),
    ] {
        if !value.is_empty() {
            stored_headers.insert(name.to_string(), json!(value));
        }
    }
    document.insert("headers".to_string(), Value::Object(stored_headers));
    python_json_value(&Value::Object(document))
}

/// `parse_incoming_body`: the source's message is the 400 detail.
fn parse_incoming_body(raw_body: &[u8], content_type: &str) -> Result<Value, String> {
    if raw_body.len() > MAX_BODY_BYTES {
        return Err("payload exceeds 1 MiB".to_string());
    }
    let text = std::str::from_utf8(raw_body)
        .map_err(|error| unicode_decode_message(raw_body, error))?
        .trim();
    if text.is_empty() {
        return Err("payload is empty".to_string());
    }
    if !content_type.to_lowercase().contains("application/json") && !text.starts_with('{') {
        return Err("event subscriptions require a JSON object payload".to_string());
    }
    let payload: Value =
        serde_json::from_str(text).map_err(|error| json_decode_message(text, &error))?;
    if !payload.is_object() {
        return Err("JSON payload must be an object".to_string());
    }
    Ok(payload)
}

/// Python's `UnicodeDecodeError` message for the first invalid UTF-8 byte.
fn unicode_decode_message(raw_body: &[u8], error: std::str::Utf8Error) -> String {
    let position = error.valid_up_to();
    let byte = raw_body.get(position).copied().unwrap_or_default();
    let reason = match error.error_len() {
        None => "unexpected end of data",
        Some(1) => "invalid start byte",
        Some(_) => "invalid continuation byte",
    };
    format!("'utf-8' codec can't decode byte 0x{byte:02x} in position {position}: {reason}")
}

/// Python's `json.JSONDecodeError` message for the corresponding syntax
/// failure. `serde_json` reports the same line/column origin; the source's
/// `(char N)` suffix is the zero-based character offset of that position.
fn json_decode_message(text: &str, error: &serde_json::Error) -> String {
    crate::json_decode_error::describe(text, error).to_string()
}

/// The first trimmed non-empty value, mirroring `next(... if value.strip())`.
fn first_non_empty(values: &[&str]) -> Option<String> {
    values
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

/// `value or fallback` for optional strings.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/// Source `_numeric_id` (`app/models/delivery.py`): the `LoopNode.id` default
/// `str(secrets.randbelow(9_000_000_000_000_000_000) + 1)`.
fn numeric_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    let mut value = u64::from_ne_bytes(bytes);
    value %= 9_000_000_000_000_000_000;
    (value + 1).to_string()
}

/// MySQL duplicate-entry error (`except IntegrityError` on the unique
/// `public_id`).
fn is_duplicate_key(error: &brz_mysql::MysqlError) -> bool {
    matches!(
        error,
        brz_mysql::MysqlError::Database {
            code: Some(1062),
            ..
        }
    )
}

/// An unexpected dependency failure escapes to the application's
/// `python_exception_handler` (`{"error_code": 500, "detail": ...}`).
fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    dependency_error_message("incoming-hook dependency failure", &error)
}

fn dependency_error_message(context: &'static str, error: &dyn std::fmt::Display) -> FastApiError {
    tracing::error!(error = %error, "{context}");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers<'a>() -> IncomingHeaders<'a> {
        IncomingHeaders {
            content_type: "application/json",
            github_event: "",
            github_delivery: "",
            gitlab_event: "Note Hook",
            gitlab_event_uuid: "4450ed8f-0e9f-4f61-942f-8a10ff03b3a4",
            idempotency_key: "",
            request_id: "",
            event_type: "",
        }
    }

    #[test]
    fn recorded_identity_matches_the_inserted_public_id() {
        // The recorded INSERT's public_id for the Note Hook delivery.
        assert_eq!(
            event_public_id("7651984495514873872", "gitlab", &headers(), b"{}"),
            "043c5b6e1ce83ca020c20e014453cfd6e544"
        );
    }

    #[test]
    fn delivery_name_keeps_the_source_prefix_and_header() {
        assert_eq!(delivery_name("gitlab", &headers()), "gitlab: Note Hook");
    }

    #[test]
    fn delivery_id_falls_back_to_the_body_digest() {
        let empty = IncomingHeaders {
            content_type: "",
            github_event: "",
            github_delivery: "",
            gitlab_event: "",
            gitlab_event_uuid: "",
            idempotency_key: "",
            request_id: "",
            event_type: "",
        };
        assert_eq!(event_public_id("1", "gitlab", &empty, b"payload"), {
            let digest = hex_sha256(b"payload");
            let identity = format!("1:gitlab:{digest}");
            hex_sha256(identity.as_bytes())[..36].to_string()
        });
    }

    #[test]
    fn body_size_and_shape_errors_match_the_source_messages() {
        assert_eq!(
            parse_incoming_body(&vec![b'a'; MAX_BODY_BYTES + 1], "application/json"),
            Err("payload exceeds 1 MiB".to_string())
        );
        assert_eq!(
            parse_incoming_body(b"   ", "application/json"),
            Err("payload is empty".to_string())
        );
        assert_eq!(
            parse_incoming_body(b"[]", "text/plain"),
            Err("event subscriptions require a JSON object payload".to_string())
        );
        assert_eq!(
            parse_incoming_body(b"[]", "application/json"),
            Err("JSON payload must be an object".to_string())
        );
    }

    #[test]
    fn invalid_json_uses_python_style_messages() {
        assert_eq!(
            parse_incoming_body(b"not json", "application/json"),
            Err("Expecting value: line 1 column 1 (char 0)".to_string())
        );
        assert_eq!(
            parse_incoming_body(b"{", "application/json"),
            Err(
                "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"
                    .to_string()
            )
        );
        assert_eq!(
            parse_incoming_body(br#"{"a": 1"#, "application/json"),
            Err("Expecting ',' delimiter: line 1 column 8 (char 7)".to_string())
        );
        assert_eq!(
            parse_incoming_body(br#"{"a": 1} {}"#, "application/json"),
            Err("Extra data: line 1 column 10 (char 9)".to_string())
        );
    }

    #[test]
    fn str_non_json_content_type_still_parses_a_json_body() {
        assert!(parse_incoming_body(br#"{"a": 1}"#, "text/plain").is_ok());
    }

    #[test]
    fn metadata_renders_like_python_json_dumps() {
        let payload: Value = serde_json::from_str(r#"{"b": 1, "a": "严"}"#).unwrap();
        let rendered = event_metadata(&payload, r#"{"b": 1, "a": "严"}"#.as_bytes(), &headers());
        let expected_prefix = concat!(
            r#"{"schema_version": 1, "collection_mode": "webhook", "attempt_count": 0, "payload": {"b": 1, "a": ""#,
            "\\u4e25",
            r#""}"#,
        );
        assert!(rendered.starts_with(expected_prefix), "{rendered}");
        assert!(rendered.contains(r#""payload_size": 20"#));
        assert!(rendered.ends_with(
            r#""headers": {"content-type": "application/json", "x-gitlab-event": "Note Hook", "x-gitlab-event-uuid": "4450ed8f-0e9f-4f61-942f-8a10ff03b3a4"}}"#
        ));
    }

    #[test]
    fn large_payloads_omit_the_stored_document() {
        let payload = json!({"a": 1});
        let raw_body = vec![b'a'; MAX_STORED_PAYLOAD_BYTES + 1];
        let rendered = event_metadata(&payload, &raw_body, &headers());
        assert!(!rendered.starts_with(
            r#"{"schema_version": 1, "collection_mode": "webhook", "attempt_count": 0, "payload""#
        ));
        assert!(rendered.contains("\"payload_sha256\""));
    }

    #[test]
    fn numeric_ids_stay_positive_and_in_range() {
        for _ in 0..64 {
            let value: u64 = numeric_id().parse().unwrap();
            assert!((1..=9_000_000_000_000_000_000).contains(&value));
        }
    }

    #[test]
    fn insert_template_has_the_source_slots() {
        assert_eq!(INSERT_EVENT_SQL.matches('?').count(), 8);
        assert!(INSERT_EVENT_SQL.contains("'incoming_event'"));
        assert!(INSERT_EVENT_SQL.contains("now(), now()"));
    }

    #[test]
    fn lookup_queries_keep_the_source_filters() {
        assert!(hook_lookup_sql().contains("loop_items.resource_type IN ('incoming_hook')"));
        assert!(
            hook_lookup_sql().contains(
                "loop_items.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')"
            )
        );
        assert!(!event_by_public_id_sql().contains("deleted_at IS NULL"));
        assert!(refresh_event_sql().contains("loop_items.id = ?"));
    }

    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/v1/incoming-hooks/token-value"));
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| {
                    route.path == "/api/v1/incoming-hooks/:token" && route.methods & POST != 0
                });
        assert!(
            registered,
            "POST /api/v1/incoming-hooks/:token must be registered"
        );
    }
}
