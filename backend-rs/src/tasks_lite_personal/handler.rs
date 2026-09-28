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
use serde_json::Value;

use crate::crd::CrdDocument;
use serde_json::json;

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
#[derive(serde::Serialize)]
struct LiteTask {
    id: i64,
    title: String,
    status: String,
    task_type: String,
    #[serde(rename = "type")]
    kind: String,
    source: Option<String>,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
    team_id: Option<i64>,
    team_name: String,
    team_namespace: String,
    team_display_name: Option<String>,
    team_icon: Option<String>,
    project_id: i64,
    client_origin: String,
    device_id: Option<String>,
    device_name: Option<String>,
    execution_workspace_source: Option<String>,
    execution_workspace_path: Option<String>,
    git_repo: String,
    is_group_chat: bool,
    knowledge_base_id: Option<i64>,
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
    let padding = "=".repeat(cursor.len() % 4);
    let decoded = base64::engine::general_purpose::URL_SAFE
        .decode(format!("{cursor}{padding}"))
        .map_err(|_| invalid())?;
    let payload: CursorPayload = serde_json::from_slice(&decoded).map_err(|_| invalid())?;
    let created_at = NaiveDateTime::parse_from_str(&payload.created_at, "%Y-%m-%dT%H:%M:%S%.f")
        .map_err(|_| invalid())?;
    Ok(Some((created_at, payload.id)))
}

/// Render a naive datetime exactly like pydantic's default serialization:
/// `YYYY-MM-DDTHH:MM:SS.ffffff` with microsecond precision.
fn format_python_datetime(value: &NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
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
            &state.mysql,
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
        &state.mysql,
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
        batch_query_workspaces(&state.mysql, i64::from(user_id), &workspace_refs).await?;
    let team_data = batch_query_teams(&state.mysql, &team_refs, i64::from(user_id)).await?;
    // `userReader.get_by_id` result only feeds `user_name`, which the lite
    // projection does not return; the registered reader (public direct SQL,
    // or a deployment's cached reader) keeps the source dependency topology.
    let _ = state.user_reader.get_by_id(i64::from(user_id)).await;
    let device_data = device_display_names(state, user_id, &device_ids).await;

    Ok(project_lite_tasks(
        tasks,
        &team_data,
        &workspace_data,
        &device_data,
    ))
}

fn project_lite_tasks(
    tasks: &[TaskCandidateRow],
    team_data: &super::lite_repository::TeamData,
    workspace_data: &std::collections::HashMap<(String, String), String>,
    device_data: &std::collections::HashMap<String, String>,
) -> Vec<LiteTask> {
    let mut items = Vec::with_capacity(tasks.len());
    for task in tasks {
        let crd = CrdDocument::project(&task.json);
        let spec = crd.spec.as_ref();
        let labels = crd
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.labels.as_ref());
        let task_type = labels
            .and_then(|labels| labels.task_type.clone())
            .unwrap_or_else(|| "chat".to_owned());
        let type_value = labels
            .and_then(|labels| labels.legacy_type.clone())
            .unwrap_or_else(|| "online".to_owned());
        let source = labels
            .and_then(|labels| labels.source.clone())
            .filter(|value| !value.is_empty());

        let task_status = crd.status.as_ref();
        let status = task_status
            .and_then(|status| status.status.clone())
            .unwrap_or_else(|| "PENDING".to_owned());
        let datetime = |value: Option<String>, fallback: NaiveDateTime| {
            value
                .and_then(|value| {
                    NaiveDateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M:%S%.f").ok()
                })
                .unwrap_or(fallback)
        };
        let created_at = datetime(
            task_status.and_then(|status| opaque_string(&status.created_at)),
            task.created_at,
        );
        let updated_at = datetime(
            task_status.and_then(|status| opaque_string(&status.updated_at)),
            task.updated_at,
        );

        let team_ref = crd.spec.as_ref().and_then(|spec| spec.team_ref.as_ref());
        let team_name_ref = team_ref
            .map(|reference| reference.name())
            .unwrap_or("")
            .to_owned();
        let team_namespace_ref = team_ref
            .map(|reference| reference.namespace())
            .unwrap_or("default")
            .to_owned();
        let team_user_id = team_ref
            .and_then(|reference| reference.user_id.as_ref())
            .and_then(|id| id.json_integer());
        let team = team_data.resolve(&team_name_ref, &team_namespace_ref, team_user_id);

        let workspace_ref = crd
            .spec
            .as_ref()
            .and_then(|spec| spec.workspace_ref.as_ref());
        let workspace_name = workspace_ref
            .map(|reference| reference.name())
            .unwrap_or("")
            .to_owned();
        let workspace_namespace = workspace_ref
            .map(|reference| reference.namespace())
            .unwrap_or("default")
            .to_owned();
        let git_repo = workspace_data
            .get(&(workspace_name, workspace_namespace))
            .cloned()
            .unwrap_or_default();

        let device_id = spec
            .and_then(|spec| opaque_string(&spec.device_id))
            .filter(|value| !value.is_empty());
        let device_name = device_id
            .as_ref()
            .and_then(|id| device_data.get(id).cloned())
            .unwrap_or_default();

        let is_group_chat = spec.and_then(|spec| spec.is_group_chat).unwrap_or(false);

        let knowledge_base_id = if task_type == "knowledge" {
            spec.and_then(|spec| spec.knowledge_base_refs.as_ref())
                .and_then(|refs| refs.first())
                .and_then(|first| first.as_ref())
                .and_then(|reference| reference.id)
        } else {
            None
        };

        items.push(LiteTask {
            id: task.id,
            title: spec
                .and_then(|spec| opaque_string(&spec.title))
                .unwrap_or_default(),
            status,
            task_type,
            kind: type_value,
            source,
            created_at: format_python_datetime(&created_at),
            updated_at: format_python_datetime(&updated_at),
            completed_at: task_status.and_then(|status| opaque_string(&status.completed_at)),
            team_id: team.id,
            team_name: team.name,
            team_namespace: team.namespace,
            team_display_name: team.display_name,
            team_icon: team.icon,
            project_id: 0,
            client_origin: task
                .client_origin
                .clone()
                .unwrap_or_else(|| "frontend".to_string()),
            device_id,
            device_name: (!device_name.is_empty()).then_some(device_name),
            execution_workspace_source: execution_workspace_field(spec, true),
            execution_workspace_path: execution_workspace_field(spec, false),
            git_repo,
            is_group_chat,
            knowledge_base_id,
        });
    }
    items
}

/// `get_task_execution_workspace_source` / `get_task_execution_workspace_path`
/// (`spec.execution.workspace.{source,path}`, trimmed non-empty strings).
fn opaque_string(field: &Option<crate::json_compat::OpaqueJson>) -> Option<String> {
    field.as_ref()?.project::<String>()
}

fn execution_workspace_field(spec: Option<&crate::crd::CrdSpec>, source: bool) -> Option<String> {
    let workspace = spec?.execution.as_ref()?.workspace.as_ref()?;
    let value = if source {
        &workspace.source
    } else {
        &workspace.path
    };
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// `_batch_query_devices`: display names for the page's device references.
async fn device_display_names(
    state: &Arc<AppState>,
    user_id: i32,
    device_ids: &[String],
) -> std::collections::HashMap<String, String> {
    let mut result = std::collections::HashMap::new();
    if device_ids.is_empty() {
        return result;
    }
    let placeholders = vec!["?"; device_ids.len()].join(", ");
    let sql = format!(
        "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
         kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
         kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
         kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
         kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
         WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
         AND kinds.namespace = 'default' AND kinds.name IN ({placeholders}) \
         AND kinds.is_active IS true"
    );
    // Bind with recorded literal kinds: `user_id` int, device names strings
    // (`serde_json::Value` would serialize every parameter as a string).
    let mut args: Vec<super::lite_repository::UnionArg> =
        vec![super::lite_repository::UnionArg::Int(i64::from(user_id))];
    args.extend(
        device_ids
            .iter()
            .map(|id| super::lite_repository::UnionArg::Str(id.clone())),
    );
    let rows: Result<Vec<super::lite_repository::TeamKindRow>, _> =
        state.mysql.fetch_all(sql.as_str(), args).await;
    if let Ok(rows) = rows {
        for row in rows {
            let display_name = row
                .json
                .as_ref()
                .and_then(|json| {
                    json.get("spec")
                        .and_then(|spec| spec.get("displayName"))
                        .and_then(Value::as_str)
                        .or_else(|| {
                            json.get("metadata")
                                .and_then(|metadata| metadata.get("displayName"))
                                .and_then(Value::as_str)
                        })
                })
                .map(str::to_string)
                .unwrap_or_else(|| row.name.clone());
            result.insert(row.name, display_name);
        }
    }
    result
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
            format_python_datetime(&parsed),
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
        let tasks: Vec<_> = [json!({}), Value::Null, json!({"metadata":{"labels":{"taskType":"knowledge","type":"","source":null}},"spec":{"title":null,"teamRef":{"name":"team"},"execution":{"workspace":{"source":"  git_worktree  ","path":""}},"knowledgeBaseRefs":[{"id":7}]}}),
            json!({"spec":{"device_id":"device","is_group_chat":true},"status":{"status":"COMPLETED","createdAt":"invalid","completedAt":""}})
        ].into_iter().map(|json| TaskCandidateRow { id:1, user_id:1, json, created_at:now, updated_at:now, client_origin:None, is_group_chat:false }).collect();
        let output = project_lite_tasks(
            &tasks,
            &super::super::lite_repository::TeamData::default(),
            &Default::default(),
            &Default::default(),
        );
        crate::json_contract_tests::assert_fixture("personal_tasks", output);
    }
}
