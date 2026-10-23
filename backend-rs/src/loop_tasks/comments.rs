// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}/comments` — the loop item's comments.
//!
//! Mirrors `app.api.endpoints.deliveries.list_loop_item_comments` and its
//! complete call graph:
//!
//! 1. `external_loop_item_provider.is_external_item` (`_find_project`).
//! 2. For an external issue: `_resolve_project` (a second `_find_project`),
//!    `require_cloud_project_role(Viewer)`, `_get_issue`, the
//!    `_response(...)` visibility gate, then the paginated provider comment
//!    list.
//! 3. For a local task: `loop_item_service.get` (`_get_item_row` plus
//!    `_require_item_access`), the comment rows in creation order, and the
//!    author-name lookup for the remaining rows.
use std::collections::{BTreeSet, HashMap};

use brz_http_server::StatusCode;
use chrono::{NaiveDateTime, Utc};

use crate::board_snapshot::external_provider as provider;
use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectRow};
use crate::http_compat::FastApiError;
use crate::loop_item_pages::projection::{datetime_reformat, issue_response};
use crate::state::AppState;

use super::assignments::{
    cloud_project_not_found, get_issue, item_number, require_cloud_project_role, todo_not_found,
};
use super::auth::FlexibleUser;
use super::item_response::metadata_security_level;
use super::loop_repository::{CommentRow, LoopItemRepository, has_permission};

/// `ISSUE_LIST_PAGE_SIZE` (`app.services.loop_items.external_provider`).
const ISSUE_LIST_PAGE_SIZE: usize = 100;
/// `MAX_EXTERNAL_COMMENT_PAGES`.
const MAX_EXTERNAL_COMMENT_PAGES: u32 = 100;

/// `LoopItemCommentResponse` (`app/schemas/delivery.py`), in the pydantic
/// model's field order. Datetimes are preformatted to FastAPI's
/// `jsonable_encoder` isoformat form.
#[derive(Debug, serde::Serialize)]
struct LoopItemCommentResponse {
    id: String,
    body: String,
    author: String,
    web_url: Option<String>,
    created_at: String,
    updated_at: String,
}

/// `GET /api/v1/loop-items/{item_id}/comments`.
#[brz_http_server::get("/api/v1/loop-items/:item_id/comments")]
async fn list_loop_item_comments(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<Vec<LoopItemCommentResponse>, FastApiError> {
    list_comments(state, item_id, current_user.id).await
}

/// `list_loop_item_comments`'s external/local dispatch.
async fn list_comments(
    state: &AppState,
    item_id: &str,
    user_id: i32,
) -> Result<Vec<LoopItemCommentResponse>, FastApiError> {
    let repository = LoopItemRepository::new(&state.mysql);
    // `external_loop_item_provider.is_external_item(db, item_id)`.
    let external = repository
        .find_external_project(item_id)
        .await
        .map_err(internal)?;
    if external.is_some() {
        external_comments(state, item_id, user_id).await
    } else {
        local_comments(state, item_id, user_id).await
    }
}

/// `loop_item_service.list_comments`: `get` then the comment rows.
async fn local_comments(
    state: &AppState,
    item_id: &str,
    user_id: i32,
) -> Result<Vec<LoopItemCommentResponse>, FastApiError> {
    let repository = LoopItemRepository::new(&state.mysql);
    // `_get_item_row`: a 404 when the task row is absent or deleted.
    let item = repository
        .get_task_item_entity(item_id)
        .await
        .map_err(internal)?
        .ok_or_else(todo_not_found)?;
    require_local_item_access(state, &item.cloud_project_id, user_id, &item).await?;

    let comments: Vec<CommentRow> = repository
        .list_comments(item_id)
        .await
        .map_err(internal)?
        .into_iter()
        .filter(kept_comment)
        .collect();
    let author_ids: Vec<i32> = comments
        .iter()
        .filter_map(|comment| comment.created_by_user_id)
        .filter(|id| *id != 0)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let authors: HashMap<i32, String> = repository
        .list_user_names(&author_ids)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|row| (i32::try_from(row.id).unwrap_or_default(), row.user_name))
        .collect();
    comments
        .iter()
        .map(|comment| local_response(comment, &authors))
        .collect()
}

/// `_require_item_access`'s view path: `require_cloud_project_role(Viewer)`,
/// the project entity read, then `_item_permissions` (`can_view_item`).
async fn require_local_item_access(
    state: &AppState,
    cloud_project_id: &str,
    user_id: i32,
    item: &super::loop_repository::TaskItemFullRow,
) -> Result<(), FastApiError> {
    let number: i64 = cloud_project_id
        .parse()
        .map_err(|_| cloud_project_not_found())?;
    let repository = BoardSnapshotRepository::new(&state.mysql);
    let access = repository
        .require_cloud_project_role(number, user_id)
        .await
        .map_err(internal)?
        .ok_or_else(cloud_project_not_found)?;
    // `db.get(CloudProject, str(cloud_project_id))` inside the access helper.
    repository.project_entity(number).await.map_err(internal)?;
    if !has_permission(&access.role, "Viewer") {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "Insufficient permission",
        ));
    }
    // `can_view_item`: maintainers and up always see the item; otherwise an
    // `open` item or an item related to the caller.
    let security_level = item
        .metadata()
        .and_then(metadata_security_level)
        .unwrap_or_else(|| access.project.default_issue_security());
    if has_permission(&access.role, "Maintainer")
        || security_level == "open"
        || LoopItemRepository::new(&state.mysql)
            .is_related_item(item.id.as_str(), user_id)
            .await
            .map_err(internal)?
    {
        return Ok(());
    }
    Err(todo_not_found())
}

/// `comment.description or not (metadata.event_type == "assignment")`: an
/// assignment event without a body is hidden from the comment list.
fn kept_comment(comment: &CommentRow) -> bool {
    if comment
        .description
        .as_deref()
        .is_some_and(|body| !body.is_empty())
    {
        return true;
    }
    comment
        .assignment()
        .and_then(|metadata| metadata.event_type.as_deref())
        != Some("assignment")
}

/// One local `LoopItemCommentResponse` (`LoopItemCommentResponse.model_validate`).
fn local_response(
    comment: &CommentRow,
    authors: &HashMap<i32, String>,
) -> Result<LoopItemCommentResponse, FastApiError> {
    let created_at = comment.created_at.ok_or_else(empty_value)?;
    let updated_at = comment.updated_at.ok_or_else(empty_value)?;
    let author = comment
        .created_by_user_id
        .and_then(|id| authors.get(&id))
        .cloned()
        .unwrap_or_default();
    Ok(LoopItemCommentResponse {
        id: comment.id.clone(),
        body: comment.description.clone().unwrap_or_default(),
        author,
        web_url: None,
        created_at: pydantic_naive_datetime(created_at),
        updated_at: pydantic_naive_datetime(updated_at),
    })
}

/// `external_loop_item_provider.list_comments`.
async fn external_comments(
    state: &AppState,
    item_id: &str,
    user_id: i32,
) -> Result<Vec<LoopItemCommentResponse>, FastApiError> {
    let repository = LoopItemRepository::new(&state.mysql);
    // `_resolve_project` re-runs `_find_project`; `None` is the 404.
    let project = repository
        .find_external_project(item_id)
        .await
        .map_err(internal)?
        .ok_or_else(todo_not_found)?;
    let number = item_number(item_id).ok_or_else(todo_not_found)?;
    let access = require_cloud_project_role(state, &project.id, user_id).await?;
    if !has_permission(&access.role, "Viewer") {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "Insufficient permission",
        ));
    }
    let issue = get_issue(state, &project, number).await?;
    let response = issue_response(state, &project, &access.role, user_id, &issue)
        .await
        .map_err(internal)?;
    if !response.can_view_detail() {
        return Err(todo_not_found());
    }
    list_provider_comments(state, &project, number).await
}

/// `_list_comments`: paginated provider comments in creation order.
async fn list_provider_comments(
    state: &AppState,
    project: &ProjectRow,
    number: i64,
) -> Result<Vec<LoopItemCommentResponse>, FastApiError> {
    let task_provider = project.task_provider();
    let (config, token) = provider::resolve_provider_config(&state.auth.jwt_key, project)
        .map_err(|error| FastApiError::detail(StatusCode::CONFLICT, error))?;
    let repository = provider::provider_repository(&config)
        .map_err(|error| FastApiError::detail(StatusCode::CONFLICT, error))?;
    let api_base = provider::api_base(&task_provider, &config);
    let path = if task_provider == "github" {
        format!("/repos/{repository}/issues/{number}/comments")
    } else {
        format!(
            "/projects/{}/issues/{number}/notes",
            provider::url_encode_path(&repository)
        )
    };

    let mut comments = Vec::new();
    for page in 1..=(MAX_EXTERNAL_COMMENT_PAGES + 1) {
        let url = if task_provider == "github" {
            format!(
                "{api_base}{path}?per_page={ISSUE_LIST_PAGE_SIZE}&page={page}\
                 &sort=created&direction=asc"
            )
        } else {
            format!(
                "{api_base}{path}?per_page={ISSUE_LIST_PAGE_SIZE}&page={page}\
                 &order_by=created_at&sort=asc"
            )
        };
        let batch = provider::request_json(&state.attachment_http, &token, &task_provider, &url)
            .await
            .map_err(provider::RequestError::into_fastapi)?;
        let batch = batch.as_array().ok_or_else(empty_value)?;
        if page > MAX_EXTERNAL_COMMENT_PAGES {
            if !batch.is_empty() {
                return Err(FastApiError::detail(
                    StatusCode::BAD_GATEWAY,
                    "Provider comment list exceeds the supported page limit",
                ));
            }
            break;
        }
        let batch_size = batch.len();
        comments.extend(
            batch
                .iter()
                .map(|comment| external_response(&task_provider, comment)),
        );
        if batch_size < ISSUE_LIST_PAGE_SIZE {
            break;
        }
    }
    Ok(comments)
}

/// `_comment_response`: one provider comment value as the response schema.
fn external_response(task_provider: &str, value: &serde_json::Value) -> LoopItemCommentResponse {
    let created_raw = text_value(value.get("created_at")).unwrap_or_else(now_iso);
    let updated_raw = text_value(value.get("updated_at"))
        .or_else(|| text_value(value.get("created_at")))
        .unwrap_or_else(now_iso);
    LoopItemCommentResponse {
        // `str(response.get("id") or "")` and the same for `body`.
        id: python_str(value.get("id").filter(|value| json_truthy(value))),
        body: python_str(value.get("body").filter(|value| json_truthy(value))),
        author: author_value(task_provider, value),
        web_url: web_url_value(value),
        created_at: datetime_reformat(&created_raw),
        updated_at: datetime_reformat(&updated_raw),
    }
}

/// `str((response["user"] or response["author"]).get("login"/"username") or "")`.
fn author_value(task_provider: &str, value: &serde_json::Value) -> String {
    let author = value
        .get("user")
        .filter(|value| json_truthy(value))
        .or_else(|| value.get("author").filter(|value| json_truthy(value)));
    let field = if task_provider == "github" {
        "login"
    } else {
        "username"
    };
    python_str(author.and_then(|author| author.get(field)))
}

/// `response.get("html_url") or response.get("web_url")`.
fn web_url_value(value: &serde_json::Value) -> Option<String> {
    value
        .get("html_url")
        .filter(|value| json_truthy(value))
        .or_else(|| value.get("web_url").filter(|value| json_truthy(value)))
        .map(|value| python_str(Some(value)))
        .filter(|value| !value.is_empty())
}

/// `response.get("created_at")` and friends: the non-empty text form.
fn text_value(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .filter(|value| json_truthy(value))
        .map(|value| python_str(Some(value)))
        .filter(|value| !value.is_empty())
}

/// Python `str(value) or ""` for the provider scalar fields.
fn python_str(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        Some(serde_json::Value::Bool(true)) => "True".to_string(),
        Some(serde_json::Value::Bool(false)) => "False".to_string(),
        _ => String::new(),
    }
}

/// Python truthiness of a JSON value.
fn json_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(values) => !values.is_empty(),
        serde_json::Value::Object(values) => !values.is_empty(),
    }
}

/// `_now()`: `datetime.now(timezone.utc).isoformat()`.
fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

/// FastAPI `jsonable_encoder` for a naive DB `datetime`.
fn pydantic_naive_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// A source-unhandled dependency failure (`python_exception_handler` 500).
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "loop-item comments dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// A response-model validation failure or malformed provider payload.
fn empty_value() -> FastApiError {
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::JsonProjection;
    use brz_mysql::Json;
    use chrono::NaiveDate;
    use serde_json::json;

    fn comment(description: Option<&str>, event_type: Option<&str>) -> CommentRow {
        let metadata = match event_type {
            Some(event_type) => json!({"event_type": event_type}),
            None => json!({}),
        };
        CommentRow {
            id: "5336494559207636217".to_owned(),
            loop_item_id: Some("WEWORK2D8526-11".to_owned()),
            description: description.map(str::to_owned),
            created_by_user_id: Some(8),
            created_at: Some(
                NaiveDate::from_ymd_opt(2026, 9, 21)
                    .expect("date")
                    .and_hms_micro_opt(9, 49, 11, 266_722)
                    .expect("time"),
            ),
            updated_at: Some(
                NaiveDate::from_ymd_opt(2026, 9, 21)
                    .expect("date")
                    .and_hms_micro_opt(9, 49, 11, 266_722)
                    .expect("time"),
            ),
            metadata: Some(Json(JsonProjection::from(metadata))),
        }
    }

    #[test]
    fn assignment_events_without_a_body_are_hidden() {
        assert!(!kept_comment(&comment(None, Some("assignment"))));
        assert!(!kept_comment(&comment(Some(""), Some("assignment"))));
        assert!(kept_comment(&comment(Some("hello"), Some("assignment"))));
        assert!(kept_comment(&comment(None, Some("status"))));
        assert!(kept_comment(&comment(Some("hello"), None)));
    }

    #[test]
    fn local_response_matches_the_schema_order_and_datetime_form() {
        let mut authors = HashMap::new();
        authors.insert(8, "jiangyang7".to_owned());
        let response =
            local_response(&comment(Some("hello"), None), &authors).expect("local response");
        assert_eq!(
            serde_json::to_string(&response).expect("serializes"),
            "{\"id\":\"5336494559207636217\",\"body\":\"hello\",\
             \"author\":\"jiangyang7\",\"web_url\":null,\
             \"created_at\":\"2026-09-21T09:49:11.266722\",\
             \"updated_at\":\"2026-09-21T09:49:11.266722\"}"
        );
    }

    #[test]
    fn external_response_maps_the_provider_fields() {
        let value = json!({
            "id": 42,
            "body": "hello",
            "user": {"login": "octocat"},
            "html_url": "https://github.com/acme/repo/issues/1#issuecomment-42",
            "created_at": "2026-09-01T10:00:00Z",
            "updated_at": "2026-09-02T11:30:00Z"
        });
        let response = external_response("github", &value);
        assert_eq!(response.id, "42");
        assert_eq!(response.body, "hello");
        assert_eq!(response.author, "octocat");
        assert_eq!(
            response.web_url.as_deref(),
            Some("https://github.com/acme/repo/issues/1#issuecomment-42")
        );
        assert_eq!(response.created_at, "2026-09-01T10:00:00+00:00");
        assert_eq!(response.updated_at, "2026-09-02T11:30:00+00:00");
    }

    #[test]
    fn external_response_uses_the_gitlab_author_field() {
        let value = json!({
            "id": 7,
            "body": "note",
            "author": {"username": "reviewer"},
            "web_url": "https://gitlab.com/acme/repo/-/issues/1#note_7",
            "created_at": "2026-09-01T10:00:00.500000Z"
        });
        let response = external_response("gitlab", &value);
        assert_eq!(response.author, "reviewer");
        assert_eq!(response.created_at, "2026-09-01T10:00:00.500000+00:00");
        assert_eq!(response.updated_at, response.created_at);
    }

    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/v1/loop-items/:item_id/comments";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(!table.matches(&http::Method::GET, "/api/v1/loop-items/abc/comments"));
        assert!(!table.matches(&http::Method::POST, "/api/v1/loop-items/abc/comments"));

        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
