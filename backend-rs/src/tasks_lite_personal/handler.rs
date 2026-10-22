// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/lite/personal` — the current user's personal
//! (non-group-chat) task list
//! (`app.api.endpoints.adapter.tasks.get_personal_tasks_lite`).
//!
//! Source pipeline (recorded request `?limit=50&page=1`, cursor mode because
//! `page == 1`):
//! 1. `security.get_current_user` — JWT session decode plus the `users`
//!    lookup through the public direct SQL reader;
//! 2. `task_kinds_service.get_user_personal_tasks_lite_cursor` —
//!    `task_store.list_personal_task_candidates_after` batches of
//!    `max(limit + 1, 100)` rows from the configured task repository,
//!    filtered by
//!    `_filter_personal_tasks` (online/offline/flow types, `DELETE` excluded);
//! 3. `build_lite_task_list` —
//!    `list_api_workspaces_by_refs` (one `(user, namespace, name) IN` probe
//!    through the configured workspace repository), `_batch_query_teams` (one
//!    `kinds` `(name, namespace, user_id) IN` probe), and
//!    `userReader.get_by_id` direct SQL lookup;
//! 4. the cursor response `{"items", "next_cursor", "has_more"}` with the
//!    next cursor base64-encoded from the last returned task's
//!    `(created_at, id)`.
use std::sync::Arc;

use base64::Engine as _;
use brz_http_server::StatusCode;
use chrono::NaiveDateTime;
use serde::Deserialize;

use crate::crd::CrdDocument;
use serde_json::json;

use super::lite_projection::{
    GroupChatRule, LiteTask, device_display_names, opaque_string, project_lite_tasks,
};
use super::lite_repository::{
    TaskCandidateRow, batch_query_teams, batch_query_workspaces, filter_personal_tasks,
    list_personal_task_candidates_after,
};
use crate::state::AppState;

/// Source `PERSONAL_TASK_CANDIDATE_EXTRA_LIMIT`-driven cursor batch size:
/// `max(limit + 1, 100)`.
fn batch_size(limit: i64) -> i64 {
    (limit + 1).max(100)
}

/// Validated query parameters. `page >= 1` and `limit` in `1..=100` are the
/// source `Query` constraints; `types` defaults to `online,offline` and
/// `client_origin` to `frontend`.
#[derive(serde::Serialize)]
#[serde(untagged)]
enum PersonalTasksResponse {
    Cursor {
        items: Vec<LiteTask>,
        next_cursor: Option<String>,
        has_more: bool,
    },
    Page {
        total: i64,
        items: Vec<LiteTask>,
    },
}

#[derive(Debug, Deserialize)]
pub struct PersonalTasksParams {
    page: Option<i64>,
    limit: Option<i64>,
    #[serde(default)]
    types: Option<String>,
    client_origin: Option<String>,
    cursor: Option<String>,
}

/// Fully validated query parameters.
struct ValidatedParams {
    page: i64,
    limit: i64,
    types: Vec<String>,
    client_origin: String,
    cursor: Option<String>,
}

impl PersonalTasksParams {
    /// FastAPI's `Query(1, ge=1)` / `Query(50, ge=1, le=100)` reject
    /// out-of-range values with 422.
    fn validated(self) -> Result<ValidatedParams, crate::http_compat::FastApiError> {
        let page = match self.page {
            None => 1,
            Some(page) if page >= 1 => page,
            Some(_) => {
                return Err(validation_error(
                    "page",
                    "Input should be greater than or equal to 1",
                ));
            }
        };
        let limit = match self.limit {
            None => 50,
            Some(limit) if (1..=100).contains(&limit) => limit,
            Some(_) => {
                return Err(validation_error(
                    "limit",
                    "Input should be between 1 and 100",
                ));
            }
        };
        let client_origin = self.client_origin.unwrap_or_else(|| "frontend".to_string());
        if !matches!(client_origin.as_str(), "frontend" | "wework") {
            return Err(validation_error(
                "client_origin",
                "String should match pattern '^(frontend|wework)$'",
            ));
        }
        let types = self.types.unwrap_or_else(|| "online,offline".to_string());
        let type_list: Vec<String> = types
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect();
        Ok(ValidatedParams {
            page,
            limit,
            types: type_list,
            client_origin,
            cursor: self.cursor,
        })
    }
}

/// FastAPI-style 422 validation error body.
fn validation_error(field: &str, message: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::validation(json!([
        {
            "type": "value_error",
            "loc": ["query", field],
            "msg": message,
            "input": "",
        }
    ]))
}

/// Cursor payload (`_encode_personal_task_cursor` /
/// `_decode_personal_task_cursor`).
#[derive(serde::Serialize, serde::Deserialize)]
struct CursorPayload {
    created_at: String,
    id: i64,
}

fn encode_cursor(created_at: &NaiveDateTime, task_id: i64) -> String {
    let payload = CursorPayload {
        // Python's `isoformat()` omits the microsecond part when it is zero.
        created_at: if created_at.and_utc().timestamp_subsec_micros() == 0 {
            created_at.format("%Y-%m-%dT%H:%M:%S").to_string()
        } else {
            created_at.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
        },
        id: task_id,
    };
    let encoded = serde_json::to_string(&payload).unwrap_or_default();
    base64::engine::general_purpose::URL_SAFE
        .encode(encoded.as_bytes())
        .trim_end_matches('=')
        .to_string()
}

#[allow(clippy::result_large_err)]
fn decode_cursor(
    cursor: &str,
) -> Result<Option<(NaiveDateTime, i64)>, crate::http_compat::FastApiError> {
    if cursor.is_empty() {
        return Ok(None);
    }
    let invalid = || {
        crate::http_compat::FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid task cursor",
        )
    };
    // Source `padding = "=" * (-len(cursor) % 4)` pads the unpadded cursor up
    // to the next multiple of four; `URL_SAFE` rejects any other count.
    let padding = "=".repeat((4 - cursor.len() % 4) % 4);
    let decoded = base64::engine::general_purpose::URL_SAFE
        .decode(format!("{cursor}{padding}"))
        .map_err(|_| invalid())?;
    let payload: CursorPayload = serde_json::from_slice(&decoded).map_err(|_| invalid())?;
    let created_at = NaiveDateTime::parse_from_str(&payload.created_at, "%Y-%m-%dT%H:%M:%S%.f")
        .map_err(|_| invalid())?;
    Ok(Some((created_at, payload.id)))
}

/// GET /api/tasks/lite/personal: the personal tasks-lite free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/tasks/lite/personal")]
async fn get_personal_tasks_lite(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: crate::auth::SessionUser,
    query: brz_http_server::Query<PersonalTasksParams>,
) -> Result<PersonalTasksResponse, crate::http_compat::FastApiError> {
    personal_tasks_lite(state, &current_user, &query).await
}

/// Handler body for `GET /api/tasks/lite/personal`.
async fn personal_tasks_lite(
    state: &Arc<AppState>,
    current_user: &crate::auth::SessionUser,
    params: &PersonalTasksParams,
) -> Result<PersonalTasksResponse, crate::http_compat::FastApiError> {
    let params = PersonalTasksParams {
        page: params.page,
        limit: params.limit,
        types: params.types.clone(),
        client_origin: params.client_origin.clone(),
        cursor: params.cursor.clone(),
    }
    .validated()?;

    let cursor_value = match params.cursor.as_deref().map(decode_cursor) {
        None => None,
        Some(result) => match result {
            Ok(value) => value,
            Err(response) => return Err(response),
        },
    };

    // `cursor is not None or page == 1` selects the keyset flow.
    let result = if cursor_value.is_some() || params.page == 1 {
        personal_tasks_cursor(
            state,
            current_user.id,
            params.limit,
            cursor_value,
            &params.types,
            &params.client_origin,
        )
        .await
        .map_err(internal_error)?
    } else {
        personal_tasks_paged(
            state,
            current_user.id,
            params.page,
            params.limit,
            &params.types,
            &params.client_origin,
        )
        .await
        .map_err(internal_error)?
    };
    Ok(result)
}

/// `get_user_personal_tasks_lite_cursor`: batched candidate scans until more
/// than `limit` matches exist or a short batch ends the scan, then one page
/// with `has_more` and the next cursor.
async fn personal_tasks_cursor(
    state: &Arc<AppState>,
    user_id: i32,
    limit: i64,
    cursor: Option<(NaiveDateTime, i64)>,
    types: &[String],
    client_origin: &str,
) -> Result<PersonalTasksResponse, brz_mysql::MysqlError> {
    let mut cursor_created_at = cursor.map(|(created_at, _)| created_at);
    let mut cursor_id = cursor.map(|(_, id)| id);
    let mut matched: Vec<TaskCandidateRow> = Vec::new();
    let size = batch_size(limit);

    loop {
        let candidates = list_personal_task_candidates_after(
            &*state.task_store,
            i64::from(user_id),
            size,
            cursor_created_at.zip(cursor_id),
            Some(client_origin),
        )
        .await?;
        if candidates.is_empty() {
            break;
        }
        let scanned = candidates.len() as i64;
        // Advance the keyset cursor with `candidates[-1]` (the smallest
        // `created_at, id` of the scanned window) before filtering.
        let last_candidate = candidates.last().expect("checked non-empty").clone_dyn();
        matched.extend(filter_personal_tasks(candidates, types));
        cursor_created_at = Some(last_candidate.0);
        cursor_id = Some(last_candidate.1);
        // The source loop is `while len(matched) <= limit`: stop scanning as
        // soon as one more page of matches exists, even on a full batch.
        if matched.len() > limit as usize {
            break;
        }
        if scanned < size {
            break;
        }
    }

    let has_more = matched.len() > limit as usize;
    let page_tasks: Vec<TaskCandidateRow> = matched.into_iter().take(limit as usize).collect();
    let next_cursor = if has_more && !page_tasks.is_empty() {
        let last_task = page_tasks.last().expect("checked non-empty");
        Some(encode_cursor(&last_task.created_at, last_task.id))
    } else {
        None
    };
    let items = build_lite_task_list(state, &page_tasks, user_id).await?;
    Ok(PersonalTasksResponse::Cursor {
        items,
        next_cursor,
        has_more,
    })
}

/// `get_user_personal_tasks_lite`: offset pagination with a total count and
/// up to `limit + PERSONAL_TASK_CANDIDATE_EXTRA_LIMIT` candidates per scan.
async fn personal_tasks_paged(
    state: &Arc<AppState>,
    user_id: i32,
    page: i64,
    limit: i64,
    types: &[String],
    client_origin: &str,
) -> Result<PersonalTasksResponse, brz_mysql::MysqlError> {
    const EXTRA_LIMIT: i64 = 50;
    let skip = (page - 1) * limit;
    let query_limit = limit + EXTRA_LIMIT;
    // Offset pagination reads `skip + query_limit` candidates and slices in
    // the application, mirroring `list_personal_task_ids`.
    let candidates = list_personal_task_candidates_after(
        &*state.task_store,
        i64::from(user_id),
        skip + query_limit,
        None,
        Some(client_origin),
    )
    .await?;
    let total = candidates.len() as i64;
    let filtered = filter_personal_tasks(candidates, types);
    let page_tasks: Vec<TaskCandidateRow> = filtered
        .into_iter()
        .skip(skip as usize)
        .take(limit as usize)
        .collect();
    let total = total.max(page_tasks.len() as i64);
    let items = build_lite_task_list(state, &page_tasks, user_id).await?;
    Ok(PersonalTasksResponse::Page { total, items })
}

/// `build_lite_task_list` for one resolved page: workspace git repositories,
/// team fields, device names, and the per-item projection.
async fn build_lite_task_list(
    state: &Arc<AppState>,
    tasks: &[TaskCandidateRow],
    user_id: i32,
) -> Result<Vec<LiteTask>, brz_mysql::MysqlError> {
    if tasks.is_empty() {
        return Ok(Vec::new());
    }

    // Collect the distinct workspace references (source uses a set).
    let mut workspace_refs: Vec<(String, String)> = Vec::new();
    let mut device_ids: Vec<String> = Vec::new();
    for task in tasks {
        let crd = CrdDocument::project(&task.json);
        if let Some(workspace_ref) = crd
            .spec
            .as_ref()
            .and_then(|spec| spec.workspace_ref.as_ref())
        {
            let name = workspace_ref.name();
            let namespace = workspace_ref.namespace();
            let key = (name.to_string(), namespace.to_string());
            if !name.is_empty() && !workspace_refs.contains(&key) {
                workspace_refs.push(key);
            }
        }
        if let Some(device_id) = crd
            .spec
            .as_ref()
            .and_then(|spec| opaque_string(&spec.device_id))
            .filter(|value| !value.is_empty())
            && !device_ids.iter().any(|id| id == &device_id)
        {
            device_ids.push(device_id);
        }
    }
    // Team references split into exact-owner and owner-scoped probes
    // (`_batch_query_teams`).
    let team_refs = super::lite_repository::TeamRefs::from_page(tasks);

    let workspace_data =
        batch_query_workspaces(&*state.task_store, i64::from(user_id), &workspace_refs).await?;
    let team_data = batch_query_teams(&state.mysql, &team_refs, i64::from(user_id)).await?;
    // `userReader.get_by_id` result only feeds `user_name`, which the lite
    // projection does not return; the registered reader (public direct SQL,
    // or a deployment's cached reader) keeps the source dependency topology.
    let _ = state.user_reader.get_by_id(i64::from(user_id)).await;
    let device_data = device_display_names(&state.mysql, i64::from(user_id), &device_ids).await;

    Ok(project_lite_tasks(
        tasks,
        &team_data,
        &workspace_data,
        &device_data,
        GroupChatRule::SpecOnly,
    ))
}

fn internal_error(error: brz_mysql::MysqlError) -> crate::http_compat::FastApiError {
    tracing::error!(%error, "tasks/lite/personal dependency failure");
    crate::http_compat::FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trips_the_source_payload() {
        let created_at =
            NaiveDateTime::parse_from_str("2026-04-15 14:44:58", "%Y-%m-%d %H:%M:%S").unwrap();
        let encoded = encode_cursor(&created_at, 1852289);
        assert_eq!(
            encoded,
            "eyJjcmVhdGVkX2F0IjoiMjAyNi0wNC0xNVQxNDo0NDo1OCIsImlkIjoxODUyMjg5fQ"
        );
        let decoded = decode_cursor(&encoded).unwrap().unwrap();
        assert_eq!(decoded, (created_at, 1852289));
    }

    #[test]
    fn invalid_cursor_is_rejected() {
        let response = decode_cursor("not-a-cursor").unwrap_err();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn unpadded_cursor_gains_its_source_padding() {
        // Source `"=" * (-len(cursor) % 4)`: a cursor whose length is 3 mod 4
        // must gain exactly one `=`, and one without fractional seconds must
        // parse. Both payloads below are unpadded base64url.
        let no_fraction = "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMS0wMlQwMzowNDowNSIsImlkIjo0Mn0";
        assert_eq!(no_fraction.len() % 4, 3);
        let decoded = decode_cursor(no_fraction).unwrap().unwrap();
        assert_eq!(decoded.1, 42);
        assert_eq!(
            decoded.0,
            NaiveDateTime::parse_from_str("2026-01-02T03:04:05", "%Y-%m-%dT%H:%M:%S").unwrap()
        );

        let wide_id = "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMS0wMlQwMzowNDowNSIsImlkIjo0MjAwMDAwMDAwMDAwMX0";
        assert_eq!(wide_id.len() % 4, 3);
        assert_eq!(
            decode_cursor(wide_id).unwrap().unwrap().1,
            42_000_000_000_001
        );
    }

    #[test]
    fn batch_size_matches_source() {
        assert_eq!(batch_size(50), 100);
        assert_eq!(batch_size(99), 100);
        assert_eq!(batch_size(100), 101);
    }

    #[test]
    fn datetimes_render_with_microseconds() {
        let parsed =
            NaiveDateTime::parse_from_str("2026-09-01T15:18:26.901656", "%Y-%m-%dT%H:%M:%S%.f")
                .unwrap();
        assert_eq!(
            super::super::lite_projection::format_python_datetime(&parsed),
            "2026-09-01T15:18:26.901656"
        );
    }
}

#[cfg(test)]
mod response_contract_tests {
    use super::*;
    #[test]
    fn personal_tasks_legacy_json_baseline() {
        let now = chrono::DateTime::from_timestamp(0, 123_456_000)
            .unwrap()
            .naive_utc();
        let tasks: Vec<_> = [json!({}), serde_json::Value::Null, json!({"metadata":{"labels":{"taskType":"knowledge","type":"","source":null}},"spec":{"title":null,"teamRef":{"name":"team"},"execution":{"workspace":{"source":"  git_worktree  ","path":""}},"knowledgeBaseRefs":[{"id":7}]}}),
            json!({"spec":{"device_id":"device","is_group_chat":true},"status":{"status":"COMPLETED","createdAt":"invalid","completedAt":""}})
        ].into_iter().map(|json| TaskCandidateRow { id:1, user_id:1, json, created_at:now, updated_at:now, project_id:None, client_origin:None, is_group_chat:false }).collect();
        let output = project_lite_tasks(
            &tasks,
            &super::super::lite_repository::TeamData::default(),
            &Default::default(),
            &Default::default(),
            GroupChatRule::SpecOnly,
        );
        crate::json_contract_tests::assert_fixture("personal_tasks", output);
    }
}
