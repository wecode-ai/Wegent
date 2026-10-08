// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT /api/tasks/{task_id}`.
//!
//! Mirrors `TaskKindsService.update_task`
//! (`app/services/adapters/task_kinds/operations.py:497`) and its response
//! builder `convert_to_task_dict`
//! (`app/services/adapters/task_kinds/converters.py:106`).

use brz_http_server::StatusCode;
use serde_json::Value;
use tracing::warn;

use super::models::{TaskInDbResponse, TaskUpdateBody};
use super::task_crd;
use crate::crd::CrdDocument;
use crate::http_compat::FastApiError;
use crate::json_compat::{OpaqueJson, python_json_value};
use crate::state::AppState;
use crate::task_detail_api::repository::get_workspace_by_ref;
use crate::task_store::task_update_timestamp;

/// `PROMPT_MAX_BYTES`: `update_task`'s UTF-8 prompt bound.
const PROMPT_MAX_BYTES: usize = 60_000;

/// `task_kinds_service.update_task` at the route's boundaries.
pub(crate) async fn update_task(
    state: &AppState,
    user_id: i64,
    task_id: i64,
    client_origin: &str,
    update: &TaskUpdateBody,
) -> Result<TaskInDbResponse, FastApiError> {
    let row = state
        .task_store
        .get_owned_active_task(task_id, user_id, Some(client_origin))
        .await
        .map_err(|error| internal(&error))?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Task not found"))?;

    let mut task_json = row
        .get_required::<brz_mysql::Json<Value>>("json")
        .map_err(|error| internal(&error))?
        .0;

    // Prompt length validation: byte length, strictly greater than the bound,
    // only when the field is present and non-null.
    if let Some(prompt) = update.prompt.value()
        && prompt.len() > PROMPT_MAX_BYTES
    {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Prompt content is too long. Maximum allowed size is 60000 bytes in UTF-8 encoding.",
        ));
    }

    // `_update_workspace_if_needed`: only a git field in the update triggers
    // the workspace rewrite.
    if update.git_url.is_present() || update.git_repo_id.is_present() {
        update_workspace(state, user_id, &task_json, update).await?;
    }

    let updated_at = task_update_timestamp();
    task_crd::apply_update(&mut task_json, update, &updated_at);

    let payload = task_crd::dump(&task_json);
    state
        .task_store
        .update_task_json(task_id, user_id, &payload, &updated_at)
        .await
        .map_err(|error| internal(&error))?;
    state
        .mysql
        .execute("COMMIT", ())
        .await
        .map_err(|error| internal(&error))?;

    // `db.refresh(task)` then `convert_to_task_dict(task, db, user_id)`.
    let document = CrdDocument::project(&task_json);
    build_task_in_db(state, &row, &document, user_id).await
}

/// `_update_workspace_if_needed`: rewrite the referenced workspace's json.
async fn update_workspace(
    state: &AppState,
    user_id: i64,
    task_json: &Value,
    update: &TaskUpdateBody,
) -> Result<(), FastApiError> {
    let document = CrdDocument::project(task_json);
    let Some((name, namespace)) = document
        .spec
        .as_ref()
        .and_then(|spec| crate::crd::reference_parts(&spec.workspace_ref))
    else {
        return Ok(());
    };
    let workspace = get_workspace_by_ref(&*state.task_store, user_id, &name, &namespace)
        .await
        .map_err(|error| internal(&error))?;
    let Some(workspace) = workspace else {
        return Ok(());
    };
    let mut workspace_json = workspace.json;
    task_crd::apply_workspace_update(&mut workspace_json, update);
    // `update_json` on the workspace row (no commit here; the caller commits).
    let updated_at = task_update_timestamp();
    state
        .task_store
        .update_task_json(
            workspace.id,
            user_id,
            &python_json_value(&workspace_json),
            &updated_at,
        )
        .await
        .map_err(|error| internal(&error))?;
    Ok(())
}

/// `convert_to_task_dict`: assemble the `TaskInDB` response from the refreshed
/// task row and JSON.
async fn build_task_in_db(
    state: &AppState,
    row: &brz_mysql::MysqlRow,
    document: &CrdDocument,
    user_id: i64,
) -> Result<TaskInDbResponse, FastApiError> {
    let task_id = row
        .get_required::<i64>("id")
        .map_err(|error| internal(&error))?;
    let owner_user_id = row
        .get_required::<i64>("user_id")
        .map_err(|error| internal(&error))?;
    let project_id = row
        .get::<i64>("project_id")
        .map_err(|error| internal(&error))?
        .unwrap_or(0);
    let client_origin = row
        .get::<String>("client_origin")
        .map_err(|error| internal(&error))?
        .unwrap_or_else(|| "frontend".to_owned());

    let spec = document.spec.as_ref();
    let status = document.status.as_ref();

    // Workspace git fields.
    let mut git_url = String::new();
    let mut git_repo = String::new();
    let mut git_repo_id = 0i64;
    let mut git_domain = String::new();
    let mut branch_name = String::new();
    if let Some((name, namespace)) =
        spec.and_then(|spec| crate::crd::reference_parts(&spec.workspace_ref))
        && let Some(workspace) =
            get_workspace_by_ref(&*state.task_store, owner_user_id, &name, &namespace)
                .await
                .map_err(|error| internal(&error))?
        && let Some(repository) = workspace
            .json
            .get("spec")
            .and_then(|spec| spec.get("repository"))
    {
        git_url = json_string(repository, "gitUrl").unwrap_or_default();
        git_repo = json_string(repository, "gitRepo").unwrap_or_default();
        git_repo_id = repository
            .get("gitRepoId")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        git_domain = json_string(repository, "gitDomain").unwrap_or_default();
        branch_name = json_string(repository, "branchName").unwrap_or_default();
    }

    // `resolve_task_ref_team`: only the resolved team's id is consumed.
    let team_id = resolve_team_id(state, user_id, document).await?;

    let user_name = state
        .user_reader
        .get_by_id(user_id)
        .await
        .map_err(|error| anyhow_internal(&error))?
        .map(|user| user.user_name)
        .unwrap_or_default();

    let labels = document
        .metadata
        .as_ref()
        .and_then(|meta| meta.labels.as_ref());
    let kind = labels
        .and_then(|labels| labels.legacy_type.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "online".to_owned());
    let task_type = labels
        .and_then(|labels| labels.task_type.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "chat".to_owned());
    let preserve_executor =
        labels.and_then(|labels| labels.preserve_executor.as_deref()) == Some("true");

    let status_value = status
        .and_then(|status| status.status.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "PENDING".to_owned());
    let progress = opaque_or(
        status.and_then(|status| status.progress.as_ref()),
        OpaqueJson::from_serializable(0),
    );
    let result = opaque_option(status.and_then(|status| status.result.as_ref()));
    let error_message = opaque_option(status.and_then(|status| status.error_message.as_ref()));
    let created_at = opaque_or_else(status.and_then(|status| status.created_at.as_ref()), || {
        row_datetime(row, "created_at")
    });
    let updated_at = opaque_or_else(status.and_then(|status| status.updated_at.as_ref()), || {
        row_datetime(row, "updated_at")
    });
    let completed_at = opaque_option(status.and_then(|status| status.completed_at.as_ref()));

    let is_group_chat = spec.and_then(|spec| spec.is_group_chat).unwrap_or(false);
    let execution_workspace = spec
        .and_then(|spec| spec.execution.as_ref())
        .and_then(|execution| execution.workspace.as_ref());
    let execution_workspace_source = execution_workspace
        .and_then(|workspace| workspace.source.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let execution_workspace_path = execution_workspace
        .and_then(|workspace| workspace.path.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    Ok(TaskInDbResponse {
        title: opaque_or(
            spec.and_then(|spec| spec.title.as_ref()),
            task_crd::json_null(),
        ),
        kind,
        task_type,
        team_id,
        git_url,
        git_repo,
        git_repo_id,
        git_domain,
        branch_name,
        prompt: opaque_or(
            spec.and_then(|spec| spec.prompt.as_ref()),
            task_crd::json_null(),
        ),
        status: status_value,
        progress,
        result,
        error_message,
        id: task_id,
        user_id: owner_user_id,
        user_name,
        project_id,
        client_origin,
        created_at: Some(created_at),
        updated_at: Some(updated_at),
        completed_at,
        is_group_chat,
        preserve_executor,
        execution_workspace_source,
        execution_workspace_path,
    })
}

/// `resolve_task_ref_team`: an explicit `teamRef.user_id` reads the kinds
/// table directly; a null one runs the cached reader.
async fn resolve_team_id(
    state: &AppState,
    user_id: i64,
    document: &CrdDocument,
) -> Result<Option<i64>, FastApiError> {
    let Some(reference) = document
        .spec
        .as_ref()
        .and_then(|spec| spec.team_ref.as_ref())
    else {
        return Ok(None);
    };
    let Some((name, namespace)) = reference.nonempty_parts() else {
        return Ok(None);
    };
    let owner = &reference.user_id;
    if owner.is_none() || owner.as_ref().is_some_and(crate::crd::NumericId::is_null) {
        let cache = crate::task_skills::kinds::KindCacheStore {
            mysql: &state.mysql,
            redis: state.redis.as_ref(),
            erp: Some(state.erp.as_ref()),
            resolvers: Some(&state.entity_resolvers),
        };
        cache
            .get_team_id_by_name_and_namespace(user_id, &namespace, &name)
            .await
            .map_err(|error| {
                warn!(?error, "[update_task] team resolution failed");
                FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            })
    } else {
        Ok(None)
    }
}

/// The opaque value when the source field is present and not null, else null.
fn opaque_option(value: Option<&OpaqueJson>) -> Option<OpaqueJson> {
    value.filter(|value| !value.is_null()).cloned()
}

/// The opaque value when present, else the supplied default.
fn opaque_or(value: Option<&OpaqueJson>, default: OpaqueJson) -> OpaqueJson {
    value
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(default)
}

/// The opaque value when present, else a value derived from the task row.
fn opaque_or_else(value: Option<&OpaqueJson>, fallback: impl FnOnce() -> OpaqueJson) -> OpaqueJson {
    opaque_option(value).unwrap_or_else(fallback)
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn row_datetime(row: &brz_mysql::MysqlRow, column: &str) -> OpaqueJson {
    row.get::<chrono::NaiveDateTime>(column)
        .ok()
        .flatten()
        .map(|value| {
            OpaqueJson::from_serializable(value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string())
        })
        .unwrap_or_else(task_crd::json_null)
}

fn internal(error: &impl std::fmt::Display) -> FastApiError {
    warn!(%error, "[update_task] database error");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn anyhow_internal(error: &impl std::fmt::Display) -> FastApiError {
    warn!(%error, "[update_task] dependency error");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}
