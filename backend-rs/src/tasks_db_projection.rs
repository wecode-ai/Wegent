// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The shared `TaskInDB` projection of the paginated task lists.
//!
//! `GET /api/tasks` (`get_user_tasks_with_pagination`) and
//! `GET /api/tasks/search` (`get_user_tasks_by_title_with_pagination`) both
//! run the source's `load_task*_rows_by_ids` -> `restore_task_order` ->
//! `get_tasks_related_data_batch` -> `convert_to_task_dict_optimized` pipeline
//! (`app/services/adapters/task_kinds/queries.py`); only the id selection, the
//! per-row filter and the reported `total` differ. This module owns the row
//! type, the `TaskListResponse` types, the per-row display filters and the
//! related-data projection so neither endpoint duplicates them.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};

use crate::crd::CrdDocument;
use crate::state::AppState;
use crate::tasks_lite_personal::lite_repository::{
    TaskCandidateRow, TeamData, TeamRefs, batch_query_teams,
};
use brz_json::OpaqueJson;

/// One `tasks`/`tasks_{:04}` row projected for a task-list page.
#[derive(Debug, brz_mysql::FromMysqlRow)]
pub(crate) struct TaskListRow {
    pub(crate) id: i64,
    user_id: i64,
    pub(crate) json: Value,
    created_at: chrono::NaiveDateTime,
    updated_at: chrono::NaiveDateTime,
    project_id: Option<i64>,
    client_origin: Option<String>,
    #[allow(dead_code)]
    is_group_chat: bool,
}

impl TaskListRow {
    pub(crate) fn candidate(&self) -> TaskCandidateRow {
        TaskCandidateRow {
            id: self.id,
            user_id: self.user_id,
            json: self.json.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            project_id: self.project_id,
            client_origin: self.client_origin.clone(),
            is_group_chat: self.is_group_chat,
        }
    }

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

/// One `TaskInDB` item (`app/schemas/task.py`), the `TaskListResponse` element.
#[derive(Debug, Serialize)]
pub(crate) struct TaskListItem {
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
pub(crate) struct TaskListResponse {
    pub(crate) total: i64,
    pub(crate) items: Vec<TaskListItem>,
}

/// A FastAPI query-parameter validation error entry (`RequestValidationError`).
pub(crate) fn query_error(
    kind: &str,
    field: &str,
    message: &str,
    ctx: Value,
    input: Option<Value>,
) -> crate::http_compat::FastApiError {
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
    crate::http_compat::FastApiError::validation(json!([entry]))
}

/// A validated `page`/`limit` pair for the task-list endpoints.
pub(crate) struct PageLimit {
    pub(crate) skip: i64,
    pub(crate) limit: i64,
}

/// `page: int = Query(1, ge=1)`, `limit: int = Query(10, ge=1, le=100)`,
/// producing the source's `skip = (page - 1) * limit`.
pub(crate) fn validate_page_limit(
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<PageLimit, crate::http_compat::FastApiError> {
    let page = match page {
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
    let limit = match limit {
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
    Ok(PageLimit {
        skip: (page - 1) * limit,
        limit,
    })
}

/// `filter_tasks_for_display` (source `filters.py`): keep a task that is not
/// `DELETE`, not a background task and not a non-interacted subscription.
pub(crate) fn is_displayable(crd: &CrdDocument, json: &Value) -> bool {
    let status = crd
        .status
        .as_ref()
        .and_then(|status| status.status.as_deref())
        .unwrap_or("PENDING");
    if status == "DELETE" {
        return false;
    }
    if is_background_task(crd) {
        return false;
    }
    if is_non_interacted_subscription(crd, json) {
        return false;
    }
    true
}

/// `is_background_task` (`filters.py`): a summary, background_executor or
/// `type=background` task hidden from the user task lists.
pub(crate) fn is_background_task(crd: &CrdDocument) -> bool {
    let Some(labels) = crd
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.labels.as_ref())
    else {
        return false;
    };
    labels.task_type.as_deref() == Some("summary")
        || labels.source.as_deref() == Some("background_executor")
        || labels.legacy_type.as_deref() == Some("background")
}

/// `is_non_interacted_subscription_task`: a `subscription`-labelled task the
/// user never interacted with. `userInteracted` is not part of the shared label
/// projection, so it is read from the raw CRD JSON.
pub(crate) fn is_non_interacted_subscription(crd: &CrdDocument, json: &Value) -> bool {
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

/// `get_tasks_related_data_batch` together with
/// `convert_to_task_dict_optimized` restricted to the `TaskInDB` response
/// fields: the ordered page rows plus the endpoint-reported `total`.
pub(crate) async fn assemble_items(
    state: &Arc<AppState>,
    user_id: i64,
    ordered: &[TaskListRow],
    total: i64,
) -> brz_mysql::MysqlResult<TaskListResponse> {
    if ordered.is_empty() {
        return Ok(TaskListResponse {
            total,
            items: Vec::new(),
        });
    }

    // `get_tasks_related_data_batch`: workspaces, then teams, then the user
    // cache; `_add_group_chat_info` runs with the projection.
    let candidates: Vec<TaskCandidateRow> = ordered.iter().map(TaskListRow::candidate).collect();
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
    let group_chat = crate::tasks_lite_personal::lite_repository::approved_group_chat_members(
        &state.mysql,
        &ordered.iter().map(|row| row.id).collect::<Vec<_>>(),
    )
    .await?;

    // `convert_to_task_dict_optimized` restricted to the `TaskInDB` fields.
    let mut items = Vec::with_capacity(ordered.len());
    for row in ordered {
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
) -> brz_mysql::MysqlResult<HashMap<(String, String), WorkspaceGit>> {
    if refs.is_empty() {
        return Ok(HashMap::new());
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
    let mut data = HashMap::new();
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

/// `convert_to_task_dict_optimized` restricted to the `TaskInDB` fields.
fn convert_task_row(
    row: &TaskListRow,
    team_data: &TeamData,
    workspaces: &HashMap<(String, String), WorkspaceGit>,
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

    #[test]
    fn background_and_subscription_labels_drive_the_display_filter() {
        let background = CrdDocument::project(&json!({
            "metadata": {"labels": {"taskType": "summary"}}
        }));
        assert!(is_background_task(&background));
        let subscription = CrdDocument::project(&json!({
            "metadata": {"labels": {"type": "subscription"}}
        }));
        assert!(is_non_interacted_subscription(&subscription, &json!({})));
        assert!(!is_non_interacted_subscription(
            &subscription,
            &json!({"metadata": {"labels": {"userInteracted": "true"}}})
        ));
        assert!(!is_displayable(
            &CrdDocument::project(&json!({"status": {"status": "DELETE"}})),
            &json!({})
        ));
    }
}
