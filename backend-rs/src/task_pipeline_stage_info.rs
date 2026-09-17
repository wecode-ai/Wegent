// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/pipeline-stage-info`
//! (`app.api.endpoints.adapter.tasks.get_pipeline_stage_info` ->
//! `task_kinds_service.get_pipeline_stage_info` ->
//! `pipeline_stage_service.get_team_for_task` / `get_stage_info`).
//!
//! Recorded dependency sequence (case `6d1ad6ad`):
//! 1. `security.get_current_user` (`users` row by name);
//! 2. `task_store.get_active_task` on the sharded table, then
//!    `task_access_store.is_member`'s `_get_accessible_task` re-read;
//! 3. team resolution through `kindReader.get_by_name_and_namespace`'s Team
//!    branch (`_get_team`): direct personal/shared reads, the
//!    `_get_team_by_share_permission` candidate scan (per candidate: the
//!    direct member query, the entity query, the active-team re-check) and
//!    and the public fallback;
//! 4. `pipeline_stage_service.get_current_stage_index` and
//!    `get_stage_info` each re-read the task through
//!    `task_member_service.get_task` (`_get_accessible_task`);
//! 5. the `PipelineStageInfo` response body.
//!
//! The team resolution reuses the public `KindCacheStore` contract from the
//! task-skills endpoint.
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

use crate::state::AppState;
use crate::task_pipeline_stage_info_repo as repo;
use crate::task_skills::kinds::KindCacheStore;

/// GET /api/tasks/{task_id}/pipeline-stage-info: the source handler injects
/// only the authenticated user and the task id (no query parameters).
#[brz_http_server::get("/api/tasks/:task_id/pipeline-stage-info")]
async fn get_pipeline_stage_info(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[header] authorization: Option<&str>,
) -> Result<PipelineStageInfo, ApiError> {
    run(state, task_id, authorization).await
}

/// The `PipelineStageInfo` response model (`app.schemas.task.PipelineStageInfo`).
#[derive(Debug, serde::Serialize)]
pub struct PipelineStageInfo {
    current_stage: i64,
    total_stages: i64,
    current_stage_name: String,
    is_pending_confirmation: bool,
    stages: Vec<StageInfo>,
}

/// One `stages` entry: `{"index", "name", "require_confirmation", "status"}`.
#[derive(Debug, serde::Serialize)]
struct StageInfo {
    index: usize,
    name: String,
    require_confirmation: bool,
    status: &'static str,
}

/// Source-compatible `HTTPException` responses.
struct ApiError {
    status: StatusCode,
    detail: String,
    www_authenticate: bool,
}

impl ApiError {
    fn not_found(detail: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: detail.to_string(),
            www_authenticate: false,
        }
    }

    fn unauthorized(detail: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: detail.to_string(),
            www_authenticate: true,
        }
    }

    fn dependency(error: brz_mysql::MysqlError) -> Self {
        tracing::error!(%error, "[pipeline_stage_info] database dependency failure");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_string(),
            www_authenticate: false,
        }
    }
}

impl IntoHttpError for ApiError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let mut response = crate::http_compat::FastApiError::detail(self.status, self.detail)
            .into_http_error(arena);
        if self.www_authenticate {
            let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
            block.extend_from_slice(b"www-authenticate: Bearer\r\n");
            if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
                response = response.headers(header);
            }
        }
        response
    }
}

/// The endpoint flow after route dispatch.
async fn run(
    state: &AppState,
    task_id: i64,
    authorization: Option<&str>,
) -> Result<PipelineStageInfo, ApiError> {
    // `security.get_current_user` (`Depends` runs before the handler).
    let user = crate::auth::get_current_user(&state.auth, &state.mysql, authorization)
        .await
        .map_err(|failure| match failure {
            crate::auth::AuthFailure::InvalidCredentials => {
                ApiError::unauthorized("Could not validate credentials")
            }
            crate::auth::AuthFailure::UserNotActivated => {
                ApiError::unauthorized("User not activated")
            }
        })?;
    let user_id = i64::from(user.id);

    // `task_store.get_active_task`.
    let Some(task) = repo::get_active_task(&state.mysql, task_id)
        .await
        .map_err(ApiError::dependency)?
    else {
        return Err(ApiError::not_found("Task not found"));
    };

    // `task_access_store.is_member`: the accessible-task re-read; the owner
    // match short-circuits without a member-row query.
    if !is_member(state, task_id, task.user_id, user_id).await? {
        return Err(ApiError::not_found("Task not found"));
    }

    // `Task.model_validate(task.json)` + `get_team_for_task` ->
    // `kindReader.get_by_name_and_namespace` (Team branch).
    let context = TeamContext::from_task_row(&task);
    let kinds_cache = KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let Some(team) = kinds_cache
        .resolve_team(task.user_id, &context.team_namespace, &context.team_name)
        .await
        .map_err(ApiError::dependency)?
    else {
        return Err(ApiError::not_found("Team not found"));
    };

    // `Team.model_validate(team.json)`.
    let team_crd = TeamProjection::project(&team.kinds_json.0);
    let members = team_crd.members;

    // Non-pipeline teams return the default document.
    if team_crd.collaboration_model.as_deref() != Some("pipeline") {
        return Ok(PipelineStageInfo {
            current_stage: 0,
            total_stages: 1,
            current_stage_name: "default".to_string(),
            is_pending_confirmation: false,
            stages: Vec::new(),
        });
    }

    stage_info(state, task_id, &task, &members).await
}

/// `task_access_store.is_member`: re-load the accessible task, then the
/// approved member-row check for non-owners.
async fn is_member(
    state: &AppState,
    task_id: i64,
    owner_user_id: i64,
    user_id: i64,
) -> Result<bool, ApiError> {
    if repo::get_active_task(&state.mysql, task_id)
        .await
        .map_err(ApiError::dependency)?
        .is_none()
    {
        return Ok(false);
    }
    if owner_user_id == user_id {
        return Ok(true);
    }
    #[derive(brz_mysql::FromMysqlRow)]
    struct MemberId {
        #[allow(dead_code)]
        resource_members_id: i64,
    }
    let member: Option<MemberId> = state
        .mysql
        .fetch_optional(
            "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
             WHERE resource_members.resource_type = 'Task' \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' \
             AND resource_members.copied_resource_id = 0 \n\
             LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await
        .map_err(ApiError::dependency)?;
    Ok(member.is_some())
}

/// `pipeline_stage_service.get_stage_info` (pipeline teams).
async fn stage_info(
    state: &AppState,
    task_id: i64,
    task: &repo::TaskRow,
    members: &[TeamMember],
) -> Result<PipelineStageInfo, ApiError> {
    let total_stages = members.len();
    if total_stages == 0 {
        return Ok(PipelineStageInfo {
            current_stage: 0,
            total_stages: 0,
            current_stage_name: String::new(),
            is_pending_confirmation: false,
            stages: Vec::new(),
        });
    }

    // `get_current_stage_index`: re-reads the task through
    // `task_member_service.get_task`; a missing task logs a warning and
    // yields stage 0 (the previously loaded row backs the same session).
    let current_stage = match repo::get_active_task(&state.mysql, task_id).await {
        Ok(refreshed) => current_stage_index(refreshed.as_ref(), task, total_stages),
        Err(error) => return Err(ApiError::dependency(error)),
    };

    // `get_stage_info` re-reads the task a second time for the status.
    let status_task = match repo::get_active_task(&state.mysql, task_id).await {
        Ok(refreshed) => refreshed,
        Err(error) => return Err(ApiError::dependency(error)),
    };
    let row = status_task.as_ref().unwrap_or(task);
    let task_crd = TaskProjection::project(&row.json);
    let task_status = task_crd.status.as_deref().unwrap_or("PENDING");
    let is_pending_confirmation = task_status == "PENDING_CONFIRMATION";
    let is_task_completed = task_status == "COMPLETED";

    let mut stages = Vec::with_capacity(total_stages);
    for (index, member) in members.iter().enumerate() {
        let status: &'static str = if index < current_stage {
            "completed"
        } else if index == current_stage {
            if is_task_completed {
                "completed"
            } else if is_pending_confirmation {
                "pending_confirmation"
            } else {
                "running"
            }
        } else {
            "pending"
        };
        stages.push(StageInfo {
            index,
            name: member.bot_name.clone(),
            require_confirmation: member.require_confirmation,
            status,
        });
    }

    let current_stage_name = if current_stage < total_stages {
        members[current_stage].bot_name.clone()
    } else {
        String::new()
    };

    Ok(PipelineStageInfo {
        current_stage: current_stage as i64,
        total_stages: total_stages as i64,
        current_stage_name,
        is_pending_confirmation,
        stages,
    })
}

/// `get_current_stage_index`: `task.spec.currentStage or 0` (a `null` or
/// missing value reads as 0), clamped to `total_stages - 1`.
fn current_stage_index(
    refreshed: Option<&repo::TaskRow>,
    fallback: &repo::TaskRow,
    total_stages: usize,
) -> usize {
    let row = refreshed.unwrap_or(fallback);
    let task_crd = TaskProjection::project(&row.json);
    let current_stage = task_crd.current_stage.unwrap_or(0).max(0);
    let limit = total_stages.saturating_sub(1) as i64;
    (current_stage.min(limit)) as usize
}

/// The task CRD fields this endpoint reads (`Task.model_validate(task.json)`).
struct TeamContext {
    team_name: String,
    team_namespace: String,
}

impl TeamContext {
    fn from_task_row(row: &repo::TaskRow) -> Self {
        let crd = crate::crd::CrdDocument::project_opaque(&row.json);
        let team_ref = crd.spec.as_ref().and_then(|spec| spec.team_ref.as_ref());
        Self {
            team_name: team_ref.map(|r| r.name().to_owned()).unwrap_or_default(),
            team_namespace: team_ref
                .map(|r| r.namespace().to_owned())
                .unwrap_or_else(|| "default".to_owned()),
        }
    }
}

/// `TaskProjection`: the `spec.currentStage` and `status.status` fields.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TaskProjection {
    #[serde(rename = "currentStage")]
    current_stage: Option<i64>,
    status: Option<String>,
}

impl TaskProjection {
    fn project(value: &crate::json_compat::OpaqueJson) -> Self {
        #[derive(Default, serde::Deserialize)]
        #[serde(default)]
        struct Document {
            spec: Option<TaskProjection>,
            status: Option<StatusProjection>,
        }
        #[derive(Default, serde::Deserialize)]
        #[serde(default)]
        struct StatusProjection {
            status: Option<String>,
        }
        let document = value.project::<Document>().unwrap_or_default();
        Self {
            current_stage: document.spec.and_then(|spec| spec.current_stage),
            status: document.status.and_then(|status| status.status),
        }
    }
}

/// One pipeline team member: the bot name and `requireConfirmation`.
#[derive(Debug, Clone)]
struct TeamMember {
    bot_name: String,
    require_confirmation: bool,
}

/// `TeamProjection`: `spec.collaborationModel` and the member list.
#[derive(Default)]
struct TeamProjection {
    collaboration_model: Option<String>,
    members: Vec<TeamMember>,
}

impl TeamProjection {
    fn project(value: &crate::json_compat::OpaqueJson) -> Self {
        #[derive(Default, serde::Deserialize)]
        #[serde(default)]
        struct Document {
            spec: Option<Spec>,
        }
        #[derive(Default, serde::Deserialize)]
        #[serde(default)]
        struct Spec {
            #[serde(rename = "collaborationModel")]
            collaboration_model: Option<String>,
            members: Option<Vec<Option<Member>>>,
        }
        #[derive(Default, serde::Deserialize)]
        #[serde(default)]
        struct Member {
            #[serde(rename = "botRef")]
            bot_ref: Option<BotRef>,
            #[serde(rename = "requireConfirmation")]
            require_confirmation: Option<bool>,
        }
        #[derive(Default, serde::Deserialize)]
        #[serde(default)]
        struct BotRef {
            name: Option<String>,
        }
        let document = value.project::<Document>().unwrap_or_default();
        let spec = document.spec.unwrap_or_default();
        let members = spec
            .members
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .map(|member| TeamMember {
                bot_name: member
                    .bot_ref
                    .and_then(|bot_ref| bot_ref.name)
                    .unwrap_or_default(),
                require_confirmation: member.require_confirmation.unwrap_or(false),
            })
            .collect();
        Self {
            collaboration_model: spec.collaboration_model,
            members,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque(json: serde_json::Value) -> crate::json_compat::OpaqueJson {
        crate::json_compat::OpaqueJson::from(json)
    }

    #[test]
    fn non_pipeline_response_uses_the_source_defaults() {
        let body = serde_json::to_value(PipelineStageInfo {
            current_stage: 0,
            total_stages: 1,
            current_stage_name: "default".to_string(),
            is_pending_confirmation: false,
            stages: Vec::new(),
        })
        .unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "current_stage": 0,
                "total_stages": 1,
                "current_stage_name": "default",
                "is_pending_confirmation": false,
                "stages": [],
            })
        );
    }

    #[test]
    fn task_projection_reads_current_stage_and_status() {
        let crd = TaskProjection::project(&opaque(serde_json::json!({
            "spec": {"currentStage": null, "teamRef": {"name": "spec-dev-team"}},
            "status": {"status": "PENDING_CONFIRMATION", "progress": 100},
        })));
        assert_eq!(crd.current_stage, None);
        assert_eq!(crd.status.as_deref(), Some("PENDING_CONFIRMATION"));

        let crd = TaskProjection::project(&opaque(serde_json::json!({
            "spec": {"currentStage": 1},
            "status": {"status": "COMPLETED"},
        })));
        assert_eq!(crd.current_stage, Some(1));
        assert_eq!(crd.status.as_deref(), Some("COMPLETED"));
    }

    #[test]
    fn team_projection_reads_members_and_collaboration_model() {
        let team = TeamProjection::project(&opaque(serde_json::json!({
            "kind": "Team",
            "spec": {
                "collaborationModel": "pipeline",
                "members": [
                    {"role": "leader", "botRef": {"name": "spec-bot", "namespace": "default"},
                     "requireConfirmation": true},
                    {"botRef": {"name": "developer-bot", "namespace": "default"}}
                ]
            }
        })));
        assert_eq!(team.collaboration_model.as_deref(), Some("pipeline"));
        assert_eq!(team.members.len(), 2);
        assert_eq!(team.members[0].bot_name, "spec-bot");
        assert!(team.members[0].require_confirmation);
        assert_eq!(team.members[1].bot_name, "developer-bot");
        assert!(!team.members[1].require_confirmation);
    }

    #[test]
    fn current_stage_index_clamps_to_member_range() {
        let row = repo::TaskRow {
            user_id: 3983,
            json: opaque(serde_json::json!({"spec": {"currentStage": 7}})),
        };
        assert_eq!(current_stage_index(None, &row, 2), 1);
        let row = repo::TaskRow {
            user_id: 3983,
            json: opaque(serde_json::json!({"spec": {"currentStage": null}})),
        };
        assert_eq!(current_stage_index(None, &row, 2), 0);
        let row = repo::TaskRow {
            user_id: 3983,
            json: opaque(serde_json::json!({"spec": {}})),
        };
        assert_eq!(current_stage_index(None, &row, 3), 0);
    }

    #[test]
    fn stage_statuses_follow_the_recorded_case() {
        // Case 6d1ad6ad shape: currentStage null -> 0, task status
        // PENDING_CONFIRMATION. Stage 0 renders pending_confirmation, stage
        // 1 renders pending, exactly like the recorded response body.
        let task_crd = TaskProjection::project(&opaque(serde_json::json!({
            "spec": {"currentStage": null},
            "status": {"status": "PENDING_CONFIRMATION"},
        })));
        let is_pending_confirmation =
            task_crd.status.as_deref().unwrap_or("PENDING") == "PENDING_CONFIRMATION";
        let is_task_completed = task_crd.status.as_deref().unwrap_or("PENDING") == "COMPLETED";
        assert!(is_pending_confirmation);
        assert!(!is_task_completed);

        let current_stage = 0;
        let stage_status = |index: usize| -> &'static str {
            if index < current_stage {
                "completed"
            } else if index == current_stage {
                if is_task_completed {
                    "completed"
                } else if is_pending_confirmation {
                    "pending_confirmation"
                } else {
                    "running"
                }
            } else {
                "pending"
            }
        };
        assert_eq!(stage_status(0), "pending_confirmation");
        assert_eq!(stage_status(1), "pending");
    }
}
