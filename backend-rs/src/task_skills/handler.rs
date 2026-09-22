// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/skills`
//! (`app.api.endpoints.adapter.tasks.get_task_skills` ->
//! `task_kinds_service.get_task_skills` ->
//! `task_skills_resolver.resolve_task_skills`).
//!
//! The dependency sequence of the recorded cases:
//! 1. `get_current_user_jwt_apikey_tasktoken` (task token: `users` row by
//!    id);
//! 2. `task_store.get_active_task` on the sharded table, then
//!    `task_access_store.is_member` (the accessible task re-query — the
//!    owner match needs no further statements);
//! 3. team resolution through the public direct kinds and resource-member
//!    readers (personal/shared/share-permission/public fallbacks);
//! 4. team -> bots -> ghosts (`_batch_load_kinds_by_refs` personal then
//!    public), the ghost skill loop with `find_skill_by_name`
//!    (personal -> bindings + per-binding active Skill -> public);
//! 5. subscription skillRefs (`background_executions` + the Subscription
//!    Kind), the user's default Skill bindings, requested label refs, and
//!    provider skills;
//! 6. the response `{"task_id", "team_id", "team_namespace", "skills",
//!    "preload_skills", "skill_refs", "preload_skill_refs"}` with sorted
//!    name lists and insertion-ordered ref maps.
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

use super::auth;
use super::auth_error::AuthError;
use super::kinds::KindCacheStore;
use super::repository as repo;
use super::resolver::{self, TaskContext};
use crate::state::AppState;

/// GET /api/tasks/{task_id}/skills: the task-skills free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/tasks/:task_id/skills")]
async fn get_task_skills(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[header] authorization: Option<&str>,
    #[header("x-api-key")] x_api_key: Option<&str>,
) -> Result<resolver::TaskSkills, HttpError> {
    // `security.get_current_user_jwt_apikey_tasktoken` (`Depends` runs
    // before the handler).
    let headers = crate::headers::OwnedHeaders::from_pairs([
        ("authorization", authorization),
        ("x-api-key", x_api_key),
    ]);
    let user = auth::get_current_user(&state.auth, &state.mysql, &headers.view()).await?;
    run(state, task_id, user.id).await
}

/// The endpoint flow after authentication.
async fn run(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<resolver::TaskSkills, HttpError> {
    // `task_store.get_active_task`.
    let Some(task) = repo::get_active_task(&state.mysql, task_id)
        .await
        .map_err(HttpError::dependency)?
    else {
        return Err(HttpError::not_found("Task not found"));
    };

    // `task_member_service.is_member`: the accessible task re-query; the
    // owner match short-circuits without further statements.
    if !is_member(state, task_id, task.user_id, user_id).await? {
        return Err(HttpError::not_found("Task not found"));
    }

    let context = TaskContext::from_task_row(task_id, &task);
    let kinds_cache = KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let raw_kinds = crate::remote_workspace_tree::kinds::KindStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
    };
    let resolved =
        resolver::resolve_task_skills(&state.mysql, &kinds_cache, &raw_kinds, &context, user_id)
            .await
            .map_err(HttpError::dependency)?;

    Ok(resolved)
}

/// `task_access_store.is_member`: re-load the accessible task, then the
/// approved member-row check for non-owners.
async fn is_member(
    state: &AppState,
    task_id: i64,
    owner_user_id: i64,
    user_id: i64,
) -> Result<bool, HttpError> {
    if repo::get_active_task(&state.mysql, task_id)
        .await
        .map_err(HttpError::dependency)?
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
        .map_err(HttpError::dependency)?;
    Ok(member.is_some())
}

/// Source-compatible `HTTPException` responses.
struct HttpError {
    status: StatusCode,
    detail: String,
}

impl HttpError {
    fn not_found(detail: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: detail.to_string(),
        }
    }

    fn dependency(error: brz_mysql::MysqlError) -> Self {
        tracing::error!(%error, "task-skills database dependency failure");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_string(),
        }
    }
}

impl IntoHttpError for HttpError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        crate::http_compat::FastApiError::detail(self.status, self.detail).into_http_error(arena)
    }
}

impl From<AuthError> for HttpError {
    fn from(error: AuthError) -> Self {
        Self {
            status: brz_http_server::StatusCode::UNAUTHORIZED,
            detail: error.detail().to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::collections::HashMap;

    fn response_body(resolved: &resolver::TaskSkills) -> Value {
        serde_json::to_value(resolved).unwrap()
    }

    fn meta(skill_id: i64, is_public: bool, hash: Option<&str>) -> resolver::SkillRefMeta {
        resolver::SkillRefMeta {
            skill_id,
            namespace: "default".to_string(),
            is_public,
            content_hash: hash.map(str::to_string),
        }
    }

    #[test]
    fn response_serializes_every_field() {
        let mut skill_refs = HashMap::new();
        skill_refs.insert(
            "sandbox".to_string(),
            meta(110603, true, Some("sha256:abc")),
        );
        skill_refs.insert("docx".to_string(), meta(127445, true, None));
        let mut preload_refs = HashMap::new();
        preload_refs.insert(
            "sandbox".to_string(),
            meta(110603, true, Some("sha256:abc")),
        );
        let resolved = resolver::TaskSkills {
            task_id: 258660110584305,
            team_id: Some(110467),
            team_namespace: "default".to_string(),
            skills: ["docx", "sandbox"].map(str::to_string).to_vec(),
            preload_skills: vec!["sandbox".to_string()],
            skill_refs,
            preload_skill_refs: preload_refs,
        };
        let body = response_body(&resolved);
        assert_eq!(body["task_id"], json!(258660110584305_i64));
        assert_eq!(body["team_id"], json!(110467));
        assert_eq!(body["team_namespace"], json!("default"));
        assert_eq!(body["skills"], json!(["docx", "sandbox"]));
        assert_eq!(body["preload_skills"], json!(["sandbox"]));
        assert_eq!(body["skill_refs"]["docx"]["content_hash"], json!(null));
        assert_eq!(
            body["skill_refs"]["sandbox"]["content_hash"],
            json!("sha256:abc")
        );
        assert_eq!(
            body["preload_skill_refs"]["sandbox"]["skill_id"],
            json!(110603)
        );
    }

    #[test]
    fn team_not_found_serializes_null_team_id() {
        let resolved = resolver::TaskSkills {
            task_id: 1,
            team_id: None,
            team_namespace: "default".to_string(),
            skills: Vec::new(),
            preload_skills: Vec::new(),
            skill_refs: HashMap::new(),
            preload_skill_refs: HashMap::new(),
        };
        let body = response_body(&resolved);
        assert_eq!(body["team_id"], json!(null));
        assert_eq!(body["skills"], json!([]));
    }
}
