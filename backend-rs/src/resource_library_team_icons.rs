// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/resource-library/assets/team-icons/{asset_id}` — the public team
//! icon asset download
//! (`app.api.endpoints.resource_library.get_public_team_icon`).
//!
//! Source pipeline:
//! 1. `db.get(SubtaskContext, asset_id)` — the ORM identity-map lookup. The
//!    recorded deployment's SQLAlchemy renders it as the bare entity
//!    projection with no labels and no `LIMIT` (the shape `Session.get`
//!    emits on SQLAlchemy 2.1; 2.0 renders the same columns labeled), with
//!    the id bound as one parameter.
//! 2. `type_data.public_asset_type == "public_team_icon"` else the endpoint's
//!    404 `Team icon asset not found`.
//! 3. `context_service.get_attachment_binary_data` from the configured
//!    attachment storage backend (`attachments::storage`; `mysql` bytes or
//!    the MinIO/S3 object store, decrypting when the stored metadata says
//!    so); a `None` read renders the same 404.
//! 4. A `200` binary response with the stored media type,
//!    `Cache-Control: public, max-age=31536000, immutable`, and
//!    `X-Content-Type-Options: nosniff`.
//!
//! The route is public: the source endpoint declares no user dependency.

use brz_http_server::{Binary, HttpResponse, StatusCode};
use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, Mysql};

use crate::attachments::context_store::{AttachmentMetadata, SubtaskContextRow};
use crate::attachments::minio_client::MinioConfig;
use crate::attachments::storage;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `PUBLIC_TEAM_ICON_ASSET_TYPE` (`resource_library.py:37`).
const PUBLIC_TEAM_ICON_ASSET_TYPE: &str = "public_team_icon";
/// `ContextType.ATTACHMENT.value`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";
/// The endpoint's cache header (`resource_library.py:96`).
const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// `db.get(SubtaskContext, asset_id)`: the ORM primary-key lookup SQLAlchemy
/// renders with the bare entity columns — no labels and no `LIMIT` — with the
/// id bound as one parameter. The statement shape must match the recorded
/// exchange for replay.
const ASSET_BY_ID_QUERY: &str = "SELECT subtask_contexts.id, subtask_contexts.subtask_id, \
     subtask_contexts.user_id, subtask_contexts.context_type, subtask_contexts.name, \
     subtask_contexts.status, subtask_contexts.error_message, subtask_contexts.binary_data, \
     subtask_contexts.image_base64, subtask_contexts.extracted_text, subtask_contexts.text_length, \
     subtask_contexts.type_data, subtask_contexts.created_at, subtask_contexts.updated_at \n\
     FROM subtask_contexts \nWHERE subtask_contexts.id = ?";

/// One `subtask_contexts` row from the `db.get` entity projection (the
/// unlabeled column names); every field feeds the storage lookup.
#[derive(Debug, FromMysqlRow)]
struct TeamIconAssetRow {
    id: i64,
    subtask_id: i64,
    user_id: i32,
    context_type: String,
    name: String,
    status: String,
    error_message: Option<String>,
    binary_data: Vec<u8>,
    image_base64: Option<String>,
    extracted_text: Option<String>,
    text_length: i32,
    type_data: Option<Json<JsonProjection<AttachmentMetadata>>>,
    created_at: Option<chrono::NaiveDateTime>,
    updated_at: Option<chrono::NaiveDateTime>,
}

impl From<TeamIconAssetRow> for SubtaskContextRow {
    fn from(row: TeamIconAssetRow) -> Self {
        Self {
            id: row.id,
            subtask_id: row.subtask_id,
            user_id: row.user_id,
            context_type: row.context_type,
            name: row.name,
            status: row.status,
            error_message: row.error_message,
            binary_data: row.binary_data,
            image_base64: row.image_base64,
            extracted_text: row.extracted_text,
            text_length: row.text_length,
            type_data: row.type_data,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// GET /api/resource-library/assets/team-icons/{asset_id}: the public team
/// icon free function, injecting the process-lifetime application state.
#[brz_http_server::get(
    "/api/resource-library/assets/team-icons/:asset_id",
    access = public
)]
async fn get_public_team_icon(
    #[inject(state)] state: &AppState,
    asset_id: &str,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let asset_id = asset_id
        .parse::<i64>()
        .map_err(|_| validation_error(asset_id))?;
    team_icon(&state.mysql, &state.attachment_http, asset_id).await
}

/// `get_public_team_icon`: load the asset, gate on the public-asset marker,
/// then read the bytes from the configured storage backend.
async fn team_icon<M>(
    mysql: &M,
    http: &brz_http::Client,
    asset_id: i64,
) -> Result<HttpResponse<Binary>, FastApiError>
where
    M: Mysql,
{
    let row: Option<TeamIconAssetRow> = mysql
        .fetch_optional(ASSET_BY_ID_QUERY, (asset_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "team icon asset lookup failed");
            FastApiError::unhandled()
        })?;
    let Some(row) = row else {
        return Err(team_icon_not_found());
    };
    // `(asset.type_data or {}).get("public_asset_type") != marker`.
    let is_public_icon = row
        .type_data
        .as_ref()
        .and_then(|data| data.0.value.as_ref())
        .and_then(|data| data.public_asset_type.as_deref())
        .is_some_and(|value| value == PUBLIC_TEAM_ICON_ASSET_TYPE);
    if !is_public_icon {
        return Err(team_icon_not_found());
    }
    let context = SubtaskContextRow::from(row);
    // `get_attachment_binary_data` enforces the `attachment` context type.
    if context.context_type != CONTEXT_TYPE_ATTACHMENT {
        return Err(team_icon_not_found());
    }
    let minio = MinioConfig::from_env();
    let bytes =
        match storage::get_attachment_binary_data(mysql, http, minio.as_ref(), &context).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Err(team_icon_not_found()),
            Err(error) => {
                tracing::error!(%error, "team icon storage read failed");
                return Err(FastApiError::unhandled());
            }
        };
    let media_type = media_type_header(&context.mime_type());
    let mut response = HttpResponse::new(Binary::new(bytes));
    response = response
        .header("content-type", &media_type)
        .map_err(|_| FastApiError::unhandled())?;
    response = response
        .header("cache-control", CACHE_CONTROL)
        .map_err(|_| FastApiError::unhandled())?;
    response = response
        .header("x-content-type-options", "nosniff")
        .map_err(|_| FastApiError::unhandled())?;
    Ok(response)
}

/// Starlette `Response.init_headers` media-type rendering for this endpoint:
/// the source passes `asset.mime_type` verbatim (the property never returns
/// `None`), so a `text/` type without a charset gains the default one and
/// every other value — including the empty string — is forwarded unchanged.
fn media_type_header(mime_type: &str) -> String {
    const CHARSET: &str = "charset=";
    let carries_charset = mime_type.to_ascii_lowercase().contains(CHARSET);
    if mime_type.starts_with("text/") && !carries_charset {
        return format!("{mime_type}; charset=utf-8");
    }
    mime_type.to_owned()
}

/// `404 {"detail": "Team icon asset not found"}`.
fn team_icon_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Team icon asset not found")
}

/// FastAPI's 422 body for an unparsable integer path parameter
/// (`{type, loc, msg, input}`).
fn validation_error(value: &str) -> FastApiError {
    #[derive(serde::Serialize)]
    struct Entry<'a> {
        #[serde(rename = "type")]
        kind: &'static str,
        loc: [&'static str; 2],
        msg: &'static str,
        input: &'a str,
    }
    FastApiError::validation(vec![Entry {
        kind: "int_parsing",
        loc: ["path", "asset_id"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: value,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cutover is real only when the route table selects the pattern the
    /// handler registers. `config/routes.toml` lists
    /// `/api/resource-library/assets/team-icons/:asset_id`.
    #[test]
    fn route_table_selects_the_registered_team_icon_handler() {
        const PATH: &str = "/api/resource-library/assets/team-icons/:asset_id";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(table.matches(
            &http::Method::GET,
            "/api/resource-library/assets/team-icons/1161376"
        ));
        assert!(!table.matches(
            &http::Method::POST,
            "/api/resource-library/assets/team-icons/1161376"
        ));

        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    /// `Session.get`'s statement: the bare entity columns, no `LIMIT`, one
    /// bound id — the recorded exchange's shape.
    #[test]
    fn asset_query_is_the_unlabeled_primary_key_lookup() {
        assert!(ASSET_BY_ID_QUERY.starts_with("SELECT subtask_contexts.id,"));
        assert!(
            !ASSET_BY_ID_QUERY.contains(" AS subtask_contexts"),
            "Session.get renders no labels"
        );
        assert!(!ASSET_BY_ID_QUERY.contains("LIMIT"));
        assert!(ASSET_BY_ID_QUERY.ends_with("WHERE subtask_contexts.id = ?"));
    }

    #[test]
    fn media_type_header_applies_the_starlette_charset_rule() {
        // The recorded case's media type is forwarded unchanged.
        assert_eq!(media_type_header("image/webp"), "image/webp");
        assert_eq!(media_type_header("text/plain"), "text/plain; charset=utf-8");
        assert_eq!(
            media_type_header("text/csv; charset=us-ascii"),
            "text/csv; charset=us-ascii"
        );
        // The source property never returns None, so an empty media type
        // still renders the (empty) content-type header.
        assert_eq!(media_type_header(""), "");
    }

    #[test]
    fn public_asset_type_gates_only_the_marker_value() {
        let row = |type_data: serde_json::Value| TeamIconAssetRow {
            id: 1161376,
            subtask_id: 0,
            user_id: 2300,
            context_type: "attachment".to_owned(),
            name: "icon.webp".to_owned(),
            status: "ready".to_owned(),
            error_message: None,
            binary_data: Vec::new(),
            image_base64: None,
            extracted_text: None,
            text_length: 0,
            type_data: Some(Json(JsonProjection::from_json(&type_data))),
            created_at: None,
            updated_at: None,
        };
        let is_public_icon = |row: &TeamIconAssetRow| {
            row.type_data
                .as_ref()
                .and_then(|data| data.0.value.as_ref())
                .and_then(|data| data.public_asset_type.as_deref())
                .is_some_and(|value| value == PUBLIC_TEAM_ICON_ASSET_TYPE)
        };
        assert!(is_public_icon(&row(serde_json::json!({
            "public_asset_type": "public_team_icon",
            "mime_type": "image/webp",
        }))));
        // Every other marker, a missing key, and absent type_data all 404.
        assert!(!is_public_icon(&row(
            serde_json::json!({"public_asset_type": "other"})
        )));
        assert!(!is_public_icon(&row(
            serde_json::json!({"mime_type": "image/webp"})
        )));
        assert!(!is_public_icon(&row(serde_json::json!({}))));
        let mut unmarked = row(serde_json::json!({"mime_type": "image/webp"}));
        unmarked.type_data = None;
        assert!(!is_public_icon(&unmarked));
    }
}
