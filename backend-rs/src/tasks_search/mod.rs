// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/search` — fuzzy task-title search
//! (`app/api/endpoints/adapter/tasks.py:search_tasks_by_title` ->
//! `task_kinds_service.get_user_tasks_by_title_with_pagination`).
//!
//! Source pipeline: `task_store.list_owned_task_ids` (the current page's owned
//! active non-system tasks), `task_store.list_by_ids`, the title filter
//! (`filter_tasks_with_title_match`), `restore_task_order`,
//! `get_tasks_related_data_batch` (workspaces, teams, the user cache and the
//! group-chat member counts) and `convert_to_task_dict_optimized` restricted to
//! the `TaskInDB` response fields.
//!
//! This route is a literal sibling of `GET /api/tasks/{task_id}`. FastAPI
//! matches the literal `/search` first (declaration order), so the target
//! registers `/api/tasks/search` as a static route: the SDK router resolves
//! static paths before `:task_id` templates, so a non-numeric task id no longer
//! reaches the detail handler and its `i64` binding.

use std::sync::Arc;

use brz_http_server::Query;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::crd::CrdDocument;
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;
use crate::tasks_lite_personal::lite_repository::{TaskCandidateRow, TeamRefs, batch_query_teams};

pub mod statements;

/// `search_tasks_by_title`'s `extra_limit` for the owned-task page.
const EXTRA_LIMIT: i64 = 100;

/// `Query(..., min_length=1)`, `Query(1, ge=1)`, `Query(10, ge=1, le=100)`.
#[derive(Debug, Deserialize)]
pub struct SearchTasksParams {
    title: Option<String>,
    page: Option<i64>,
    limit: Option<i64>,
}

/// Validated `search_tasks_by_title` arguments.
pub(crate) struct ValidatedParams {
    pub(crate) title: String,
    pub(crate) skip: i64,
    pub(crate) limit: i64,
}

impl SearchTasksParams {
    fn validated(self) -> Result<ValidatedParams, FastApiError> {
        let title = match self.title {
            None => {
                return Err(query_error(
                    "missing",
                    "title",
                    "Field required",
                    json!({}),
                    None,
                ));
            }
            Some(title) if !title.is_empty() => title,
            Some(title) => {
                return Err(query_error(
                    "string_too_short",
                    "title",
                    "String should have at least 1 character",
                    json!({"min_length": 1}),
                    Some(json!(title)),
                ));
            }
        };
        let page = match self.page {
            None => 1,
            Some(page) if page >= 1 => page,
            Some(page) => {
                return Err(query_error(
                    "greater_than_equal",
                    "page",
                    "Input should be greater than or equal to 1",
                    json!({"ge": 1}),
                    Some(json!(page)),
                ));
            }
        };
        let limit = match self.limit {
            None => 10,
            Some(limit) if (1..=100).contains(&limit) => limit,
            Some(limit) if limit < 1 => {
                return Err(query_error(
                    "greater_than_equal",
                    "limit",
                    "Input should be greater than or equal to 1",
                    json!({"ge": 1}),
                    Some(json!(limit)),
                ));
            }
            Some(limit) => {
                return Err(query_error(
                    "less_than_equal",
                    "limit",
                    "Input should be less than or equal to 100",
                    json!({"le": 100}),
                    Some(json!(limit)),
                ));
            }
        };
        Ok(ValidatedParams {
            title,
            skip: (page - 1) * limit,
            limit,
        })
    }
}

/// A FastAPI query-parameter validation error entry (`RequestValidationError`).
fn query_error(
    kind: &str,
    field: &str,
    message: &str,
    ctx: Value,
    input: Option<Value>,
) -> FastApiError {
    let mut entry = json!({
        "type": kind,
        "loc": ["query", field],
        "msg": message,
    });
    if !ctx.as_object().is_some_and(serde_json::Map::is_empty) {
        entry["ctx"] = ctx;
    }
    if let Some(input) = input {
        entry["input"] = input;
    }
    FastApiError::validation(json!([entry]))
}

/// One `tasks`/`tasks_{:04}` row projected for the search pipeline.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct SearchTaskRow {
    id: i64,
    user_id: i64,
    json: Value,
    created_at: chrono::NaiveDateTime,
    updated_at: chrono::NaiveDateTime,
    project_id: Option<i64>,
    client_origin: Option<String>,
    #[allow(dead_code)]
    is_group_chat: bool,
}

impl SearchTaskRow {
    fn candidate(&self) -> TaskCandidateRow {
        TaskCandidateRow {
            id: self.id,
            user_id: self.user_id,
            json: self.json.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            client_origin: self.client_origin.clone(),
            is_group_chat: self.is_group_chat,
        }
    }
}

/// One `TaskInDB` item (`app/schemas/task.py`), the `TaskListResponse` element.
#[derive(Debug, Serialize)]
struct TaskListItem {
    title: Value,
    #[serde(rename = "type")]
    kind: Value,
    task_type: Value,
    team_id: Value,
    git_url: Value,
    git_repo: Value,
    git_repo_id: Value,
    git_domain: Value,
    branch_name: Value,
    prompt: Value,
    status: Value,
    progress: Value,
    result: Value,
    error_message: Value,
    id: i64,
    user_id: i64,
    user_name: Value,
    project_id: i64,
    client_origin: Value,
    created_at: Value,
    updated_at: Value,
    completed_at: Value,
    is_group_chat: bool,
    preserve_executor: bool,
    execution_workspace_source: Value,
    execution_workspace_path: Value,
}

/// `TaskListResponse`: `{total, items}`.
#[derive(Debug, Serialize)]
struct TaskListResponse {
    total: i64,
    items: Vec<TaskListItem>,
}

/// GET /api/tasks/search: the search free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/tasks/search")]
async fn search_tasks_by_title(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: crate::auth::SessionUser,
    query: Query<SearchTasksParams>,
) -> Result<TaskListResponse, FastApiError> {
    let params = SearchTasksParams {
        title: query.title.clone(),
        page: query.page,
        limit: query.limit,
    }
    .validated()?;
    search_tasks(state, i64::from(current_user.id), &params)
        .await
        .map_err(|_| FastApiError::internal())
}

/// Handler body for `GET /api/tasks/search`.
async fn search_tasks(
    state: &Arc<AppState>,
    user_id: i64,
    params: &ValidatedParams,
) -> brz_mysql::MysqlResult<TaskListResponse> {
    use brz_mysql::FromMysqlRow as _;

    // `get_owned_task_ids_and_total`: the page's owned task ids plus the total.
    let page = state
        .task_store
        .list_owned_task_ids(user_id, params.skip, params.limit + EXTRA_LIMIT)
        .await?;

    // `load_tasks_by_ids`: the full rows of the page's ids.
    let raw = state.task_store.list_tasks_by_ids(&page.ids).await?;
    let rows = raw
        .into_iter()
        .map(SearchTaskRow::from_mysql_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;

    // `filter_tasks_with_title_match` keeps the rows whose CRD title contains
    // the lowercased query; `restore_task_order` re-applies the id order and
    // caps the page at `limit`.
    let title_lower = params.title.to_lowercase();
    let mut matched: std::collections::HashMap<i64, (usize, SearchTaskRow)> =
        std::collections::HashMap::new();
    let mut total = 0i64;
    for (index, row) in rows.into_iter().enumerate() {
        let crd = CrdDocument::project(&row.json);
        let status = crd
            .status
            .as_ref()
            .and_then(|status| status.status.clone())
            .unwrap_or_else(|| "PENDING".to_owned());
        if status == "DELETE" {
            continue;
        }
        let task_title = crd
            .spec
            .as_ref()
            .and_then(|spec| spec.title.as_ref())
            .map(|title| {
                title
                    .to_value()
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        if !task_title.to_lowercase().contains(&title_lower) {
            continue;
        }
        if is_non_interacted_subscription(&crd, &row.json) {
            continue;
        }
        total += 1;
        matched.insert(row.id, (index, row));
    }

    // `restore_task_order(task_ids, id_to_task, limit)`.
    let mut ordered: Vec<SearchTaskRow> = Vec::new();
    for id in &page.ids {
        if let Some((_, row)) = matched.remove(id) {
            ordered.push(row);
            if ordered.len() as i64 >= params.limit {
                break;
            }
        }
    }
    if ordered.is_empty() {
        return Ok(TaskListResponse {
            total,
            items: Vec::new(),
        });
    }

    // `get_tasks_related_data_batch`: workspaces, then teams, then the user
    // cache; `_add_group_chat_info` runs with the projection.
    let candidates: Vec<TaskCandidateRow> = ordered.iter().map(SearchTaskRow::candidate).collect();
    let workspace_refs = collect_workspace_refs(&candidates);
    let workspaces = batch_workspace_git(state, user_id, &workspace_refs).await?;
    let team_refs = TeamRefs::from_page(&candidates);
    let team_data = batch_query_teams(&state.mysql, &team_refs, user_id).await?;
    let user_name = state
        .user_reader
        .get_by_id(user_id)
        .await
        .ok()
        .flatten()
        .map(|user| user.user_name)
        .unwrap_or_default();
    let group_chat = batch_group_chat(&state.mysql, &ordered).await?;

    // `convert_to_task_dict_optimized` restricted to the `TaskInDB` fields.
    let mut items = Vec::with_capacity(ordered.len());
    for row in &ordered {
        items.push(convert_task_row(
            row,
            &team_data,
            &workspaces,
            &group_chat,
            &user_name,
        ));
    }
    Ok(TaskListResponse { total, items })
}

/// `is_non_interacted_subscription_task`: a `subscription`-labelled task the
/// user never interacted with. `userInteracted` is not part of the shared label
/// projection, so it is read from the raw CRD JSON.
fn is_non_interacted_subscription(crd: &CrdDocument, json: &Value) -> bool {
    let subscribed = crd
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.labels.as_ref())
        .and_then(|labels| labels.legacy_type.as_deref())
        == Some("subscription");
    if !subscribed {
        return false;
    }
    let interacted = json
        .get("metadata")
        .and_then(|metadata| metadata.get("labels"))
        .and_then(|labels| labels.get("userInteracted"))
        .and_then(Value::as_str)
        == Some("true");
    !interacted
}

/// The `(name, namespace)` workspace references of the page's tasks.
fn collect_workspace_refs(rows: &[TaskCandidateRow]) -> Vec<(String, String)> {
    let mut refs: Vec<(String, String)> = Vec::new();
    for row in rows {
        let crd = CrdDocument::project(&row.json);
        let Some(workspace) = crd
            .spec
            .as_ref()
            .and_then(|spec| spec.workspace_ref.as_ref())
        else {
            continue;
        };
        let name = workspace.name().to_owned();
        if name.is_empty() {
            continue;
        }
        let key = (name, workspace.namespace().to_owned());
        if !refs.contains(&key) {
            refs.push(key);
        }
    }
    refs
}

/// `_batch_query_workspaces`: `git_url`, `git_repo`, `git_repo_id`,
/// `git_domain` and `branch_name` by `(name, namespace)`.
async fn batch_workspace_git(
    state: &Arc<AppState>,
    user_id: i64,
    refs: &[(String, String)],
) -> brz_mysql::MysqlResult<std::collections::HashMap<(String, String), WorkspaceGit>> {
    if refs.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    // `ShardedTaskStore.list_workspaces_by_refs`: the base-table read first,
    // then the owner's shard (`_workspace_refs_by_model`). The tasks-lite list
    // reads the shard alone (`list_api_workspaces_by_refs`), so the store
    // method stays shard-only and the base probe is issued here.
    let statement = crate::task_store::workspaces_by_ref_statement(
        crate::task_store::TASKS_TABLE,
        user_id,
        refs,
    );
    let mut rows = state.mysql.fetch_all(statement, ()).await?;
    rows.extend(
        state
            .task_store
            .list_workspaces_by_ref(user_id, refs)
            .await?,
    );
    let mut data = std::collections::HashMap::new();
    for row in &rows {
        let name: String = row.get_required("name")?;
        let namespace: String = row.get_required("namespace")?;
        let json: Value = row.get_required("json").unwrap_or(Value::Null);
        data.insert((name, namespace), WorkspaceGit::from_crd(&json));
    }
    Ok(data)
}

/// One workspace's `spec.repository` git projection.
#[derive(Debug, Default)]
struct WorkspaceGit {
    git_url: String,
    git_repo: String,
    git_repo_id: i64,
    git_domain: String,
    branch_name: String,
}

impl WorkspaceGit {
    fn from_crd(json: &Value) -> Self {
        let repository = json.get("spec").and_then(|spec| spec.get("repository"));
        let text = |key: &str| {
            repository
                .and_then(|repository| repository.get(key))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        Self {
            git_url: text("gitUrl"),
            git_repo: text("gitRepo"),
            git_repo_id: repository
                .and_then(|repository| repository.get("gitRepoId"))
                .and_then(Value::as_i64)
                .unwrap_or(0),
            git_domain: text("gitDomain"),
            branch_name: text("branchName"),
        }
    }
}

/// `_add_group_chat_info`: the task ids that carry approved group-chat members.
async fn batch_group_chat(
    mysql: &brz_mysql::MysqlService,
    rows: &[SearchTaskRow],
) -> brz_mysql::MysqlResult<std::collections::HashSet<i64>> {
    if rows.is_empty() {
        return Ok(std::collections::HashSet::new());
    }
    let ids = rows
        .iter()
        .map(|row| row.id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT resource_members.resource_id AS resource_members_resource_id, \
         count(resource_members.id) AS count \nFROM resource_members \nWHERE \
         resource_members.resource_type = 'Task' AND resource_members.resource_id IN ({ids}) AND \
         resource_members.status = 'approved' AND resource_members.copied_resource_id = 0 \
         GROUP BY resource_members.resource_id"
    );
    #[derive(Debug, brz_mysql::FromMysqlRow)]
    struct GroupRow {
        #[mysql(rename = "resource_members_resource_id")]
        resource_id: i64,
    }
    let rows: Vec<GroupRow> = mysql.fetch_all(sql.as_str(), ()).await?;
    Ok(rows.into_iter().map(|row| row.resource_id).collect())
}

/// `convert_to_task_dict_optimized` restricted to the `TaskInDB` fields.
fn convert_task_row(
    row: &SearchTaskRow,
    team_data: &crate::tasks_lite_personal::lite_repository::TeamData,
    workspaces: &std::collections::HashMap<(String, String), WorkspaceGit>,
    group_chat: &std::collections::HashSet<i64>,
    user_name: &str,
) -> TaskListItem {
    let crd = CrdDocument::project(&row.json);
    let labels = crd
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.labels.as_ref());
    let spec = crd.spec.as_ref();
    let status = crd.status.as_ref();

    let type_value = labels
        .and_then(|labels| labels.legacy_type.clone())
        .unwrap_or_else(|| "online".to_owned());
    let task_type = labels
        .and_then(|labels| labels.task_type.clone())
        .unwrap_or_else(|| "chat".to_owned());
    let preserve_executor =
        labels.and_then(|labels| labels.preserve_executor.as_deref()) == Some("true");

    let team_id = spec
        .and_then(|spec| spec.team_ref.as_ref())
        .and_then(|team_ref| {
            team_data
                .resolve(
                    team_ref.name(),
                    team_ref.namespace(),
                    team_ref.user_id.as_ref().and_then(numeric_id),
                )
                .id
        });

    let workspace_key = spec
        .and_then(|spec| spec.workspace_ref.as_ref())
        .map(|ws| (ws.name().to_owned(), ws.namespace().to_owned()));
    let workspace = workspace_key
        .as_ref()
        .and_then(|key| workspaces.get(key))
        .map_or_else(WorkspaceGit::default, |git| WorkspaceGit {
            git_url: git.git_url.clone(),
            git_repo: git.git_repo.clone(),
            git_repo_id: git.git_repo_id,
            git_domain: git.git_domain.clone(),
            branch_name: git.branch_name.clone(),
        });

    let execution = spec.and_then(|spec| spec.execution.as_ref());
    let execution_workspace = execution.and_then(|execution| execution.workspace.as_ref());
    let execution_source = execution_workspace
        .and_then(|workspace| workspace.source.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let execution_path = execution_workspace
        .and_then(|workspace| workspace.path.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let is_group_chat = row.is_group_chat
        || spec.and_then(|spec| spec.is_group_chat) == Some(true)
        || group_chat.contains(&row.id);

    let created_at = row
        .status_timestamp(status, StatusField::Created)
        .unwrap_or_else(|| iso_timestamp(&row.created_at));
    let updated_at = row
        .status_timestamp(status, StatusField::Updated)
        .unwrap_or_else(|| iso_timestamp(&row.updated_at));
    let completed_at = row
        .status_timestamp(status, StatusField::Completed)
        .unwrap_or(Value::Null);

    TaskListItem {
        title: spec
            .and_then(|spec| spec.title.as_ref())
            .map_or(Value::Null, OpaqueJson::to_value),
        kind: Value::String(type_value),
        task_type: Value::String(task_type),
        team_id: team_id.map_or(Value::Null, |id| json!(id)),
        git_url: Value::String(workspace.git_url),
        git_repo: Value::String(workspace.git_repo),
        git_repo_id: json!(workspace.git_repo_id),
        git_domain: Value::String(workspace.git_domain),
        branch_name: Value::String(workspace.branch_name),
        prompt: spec
            .and_then(|spec| spec.prompt.as_ref())
            .map_or(Value::Null, OpaqueJson::to_value),
        status: Value::String(
            status
                .and_then(|status| status.status.clone())
                .unwrap_or_else(|| "PENDING".to_owned()),
        ),
        progress: status
            .and_then(|status| status.progress.as_ref())
            .map_or_else(|| json!(0), coerce_int),
        result: status
            .and_then(|status| status.result.as_ref())
            .map_or(Value::Null, OpaqueJson::to_value),
        error_message: status
            .and_then(|status| status.error_message.as_ref())
            .map_or(Value::Null, OpaqueJson::to_value),
        id: row.id,
        user_id: row.user_id,
        user_name: Value::String(user_name.to_owned()),
        project_id: row.project_id.unwrap_or(0),
        client_origin: Value::String(
            row.client_origin
                .clone()
                .unwrap_or_else(|| "frontend".to_owned()),
        ),
        created_at,
        updated_at,
        completed_at,
        is_group_chat,
        preserve_executor,
        execution_workspace_source: opt_string(execution_source),
        execution_workspace_path: opt_string(execution_path),
    }
}

impl SearchTaskRow {
    /// The CRD status timestamp for one field, when present.
    fn status_timestamp(
        &self,
        status: Option<&crate::crd::CrdStatus>,
        field: StatusField,
    ) -> Option<Value> {
        let value = match field {
            StatusField::Created => status.and_then(|status| status.created_at.as_ref()),
            StatusField::Updated => status.and_then(|status| status.updated_at.as_ref()),
            StatusField::Completed => status.and_then(|status| status.completed_at.as_ref()),
        }?;
        Some(value.to_value())
    }
}

/// Which CRD status timestamp to read.
enum StatusField {
    Created,
    Updated,
    Completed,
}

/// Render a naive datetime like pydantic's default serialization.
fn iso_timestamp(value: &chrono::NaiveDateTime) -> Value {
    Value::String(value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string())
}

/// A JSON value as an `Option<String>` for the response model.
fn opt_string(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |value| Value::String(value.to_owned()))
}

/// `TaskInDB.progress`/`git_repo_id`: coerce a JSON scalar to an integer
/// the way pydantic does (`int(value)`), keeping the original on failure.
fn coerce_int(value: &OpaqueJson) -> Value {
    let value = value.to_value();
    match &value {
        Value::Number(number) => json!(number.as_i64().unwrap_or(0)),
        Value::String(text) => text.parse::<i64>().map_or(value, |parsed| json!(parsed)),
        _ => json!(0),
    }
}

/// Read a `NumericId` reference field as an `i64`.
fn numeric_id(value: &crate::crd::NumericId) -> Option<i64> {
    match value {
        crate::crd::NumericId::Number(number) => number.as_i64(),
        crate::crd::NumericId::Text(text) => text.parse().ok(),
        crate::crd::NumericId::Null(()) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_validate_like_the_source_query_constraints() {
        let params = SearchTasksParams {
            title: Some("vdbench".into()),
            page: Some(1),
            limit: Some(20),
        }
        .validated()
        .unwrap();
        assert_eq!(params.title, "vdbench");
        assert_eq!(params.skip, 0);
        assert_eq!(params.limit, 20);

        assert!(
            SearchTasksParams {
                title: None,
                page: None,
                limit: None
            }
            .validated()
            .is_err()
        );
        assert!(
            SearchTasksParams {
                title: Some(String::new()),
                page: None,
                limit: None
            }
            .validated()
            .is_err()
        );
        assert!(
            SearchTasksParams {
                title: Some("x".into()),
                page: Some(0),
                limit: None
            }
            .validated()
            .is_err()
        );
        assert!(
            SearchTasksParams {
                title: Some("x".into()),
                page: None,
                limit: Some(101)
            }
            .validated()
            .is_err()
        );
    }

    #[test]
    fn workspace_git_reads_the_repository_projection() {
        let json = json!({"spec": {"repository": {
            "gitUrl": "https://example/repo.git",
            "gitRepo": "repo",
            "gitRepoId": 12,
            "gitDomain": "example",
            "branchName": "main",
        }}});
        let git = WorkspaceGit::from_crd(&json);
        assert_eq!(git.git_url, "https://example/repo.git");
        assert_eq!(git.git_repo, "repo");
        assert_eq!(git.git_repo_id, 12);
        assert_eq!(git.git_domain, "example");
        assert_eq!(git.branch_name, "main");
        assert_eq!(WorkspaceGit::from_crd(&json!({})).git_repo_id, 0);
    }
}

#[cfg(test)]
mod routing_tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated probe group carrying both the detail template and the literal
    // search sibling, so the router exercises their precedence without the
    // crate's real handlers.
    mod probe {
        brz_http_server::registry!(group = tasks_search_probe, dependencies());
    }

    #[brz_http_server::get(
        "/api/tasks/:task_id",
        group = probe::tasks_search_probe,
        access = public
    )]
    async fn probe_detail(task_id: i64) -> String {
        format!("detail:{task_id}")
    }

    #[brz_http_server::get(
        "/api/tasks/search",
        group = probe::tasks_search_probe,
        access = public
    )]
    async fn probe_search() -> &'static str {
        "search"
    }

    /// Drives the probe router over a real `http-server` socket.
    async fn serve(request: &str) -> String {
        let handler =
            brz_http_server::handlers!(; group = probe::tasks_search_probe).expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client.write_all(request.as_bytes()).await.expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    fn body_of(raw: &str) -> &str {
        raw.split_once("\r\n\r\n").map_or("", |(_, body)| body)
    }

    /// The recorded failure: `/api/tasks/search` reached the `:task_id` template,
    /// whose `i64` binding rejected the literal segment with `400`. The static
    /// route must win so the source's declaration order is reproduced.
    #[tokio::test]
    async fn the_literal_search_route_wins_over_the_task_id_template() {
        let raw = serve(
            "GET /api/tasks/search?title=vdbench HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        assert_eq!(body_of(&raw), "\"search\"");
    }

    /// A numeric id still resolves to the template.
    #[tokio::test]
    async fn a_numeric_id_still_resolves_to_the_detail_template() {
        let raw = serve(
            "GET /api/tasks/42 HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        assert_eq!(body_of(&raw), "\"detail:42\"");
    }
}
