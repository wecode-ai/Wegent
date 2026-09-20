// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases/{knowledge_base_id}/artifacts` — list recent
//! Artifacts for a knowledge base
//! (`app.api.endpoints.knowledge_artifacts.list_artifacts` ->
//! `ArtifactService.list`).
//!
//! Source pipeline (recorded cases
//! `api-knowledge-bases-304487-artifacts/4a9d336c` and
//! `api-knowledge-bases-304541-artifacts/7da0e6d2`, Bearer JWT user
//! `yueqi6`, both KBs personal `default` namespaces created by the user):
//!
//! 1. `security.get_current_user` — JWT Bearer, then the user row by name;
//! 2. `_require_read_access` — `KnowledgeService.get_knowledge_base`: the
//!    KB `Kind` record, then the full ACL chain of
//!    `resolve_knowledge_base_permission` + `meets_direct_access_requirement`;
//! 3. `repository.list_by_knowledge_base` — the newest 50 `knowledge_artifacts`
//!    rows (`created_at DESC, artifact_id DESC`);
//! 4. `can_manage_knowledge_base_documents` — the Kind record re-loaded
//!    through `get_user_knowledge_base_permission` (`is_active IS true`
//!    rendering), then the raw ACL chain
//!    (`resolve_knowledge_base_permission`, without the direct-access
//!    requirement step);
//! 5. `_document_source_counts` — one `sum(CASE WHEN ...)` aggregate over
//!    `knowledge_documents`;
//! 6. two `ROLLBACK` session cleanups at request end.
//!
//! Both recorded knowledge bases have no artifact rows, so `items` is empty;
//! the row projection follows the `KnowledgeArtifact` pydantic model for
//! the stored values, and `_apply_execution_health` /
//! `_set_user_capabilities` are the deterministic local tail of
//! `_reconcile_many` (the subtask-driven status sync of active artifacts
//! needs task/subtask evidence no current recording exercises).
use std::sync::Arc;

use brz_http_server::Binary;
use brz_http_server::HttpResponse;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::json;

use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;

use super::knowledge_documents_content::access::{self, KnowledgeBase};
use super::knowledge_documents_content::group_membership;
use super::permissions::EntityResolvers;

/// `KNOWLEDGE_ARTIFACT_UNSET_ID` (`app.models.knowledge_artifact`): `task_id`
/// / `assistant_subtask_id` storage value meaning "unset" (-> `None`).
const UNSET_ID: i64 = 0;

/// `settings.KNOWLEDGE_ARTIFACT_STALL_SECONDS` default (`app.core.config`).
const STALL_SECONDS: i64 = 600;

/// `MYSQL_SESSION_TIMEZONE` (`app.db.timezone`): naive DB datetimes are
/// session-local UTC+8 (`_as_utc_naive`).
const DB_SESSION_OFFSET_SECONDS: i32 = 8 * 3600;

/// `_ACTIVE_STATUSES` (`KnowledgeArtifactStatus.QUEUED` / `RUNNING`).
fn status_is_active(status: &str) -> bool {
    status == "queued" || status == "running"
}

/// `_PROCESSING_DOCUMENT_STATUSES`.
const PROCESSING_STATUSES: &str = "'queued', 'pending_conversion', 'converting', 'indexing'";

/// GET /api/knowledge-bases/:knowledge_base_id/artifacts: the artifacts-list
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/knowledge-bases/:knowledge_base_id/artifacts")]
async fn list_artifacts(
    #[inject(state)] state: &Arc<AppState>,
    knowledge_base_id: i64,
    #[header] authorization: Option<&str>,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let user = crate::auth::get_current_user(&state.auth, &state.mysql, authorization)
        .await
        .map_err(auth_error)?;
    let body = list_artifacts_value(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        knowledge_base_id,
        i64::from(user.id),
    )
    .await?;
    Ok(HttpResponse::new(Binary::new(body)))
}

/// `_execute`'s 404 mapping for `ArtifactNotFoundError`.
fn not_found(detail: &str) -> FastApiError {
    FastApiError::detail(brz_http_server::StatusCode::NOT_FOUND, detail)
}

/// `security.get_current_user`'s 401 mapping.
fn auth_error(error: crate::auth::AuthFailure) -> FastApiError {
    match error {
        crate::auth::AuthFailure::InvalidCredentials => {
            FastApiError::unauthorized("Could not validate credentials")
        }
        crate::auth::AuthFailure::UserNotActivated => {
            FastApiError::unauthorized("User not activated")
        }
    }
}

/// `ArtifactService.list`: read access, the stored rows, capabilities, and
/// the document source counts.
async fn list_artifacts_value<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    knowledge_base_id: i64,
    user_id: i64,
) -> Result<Vec<u8>, FastApiError>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    // `_require_read_access`: `get_knowledge_base` -> the KB `Kind` record
    // plus the full ACL chain; missing or inaccessible -> 404.
    let kb = access::knowledge_base_record(mysql, knowledge_base_id)
        .await
        .map_err(internal)?;
    let Some(kb) = kb else {
        return Err(not_found("Knowledge base not found"));
    };
    let has_access = access::knowledge_base_access(mysql, redis, resolvers, &kb, user_id)
        .await
        .map_err(internal)?;
    if !has_access {
        return Err(not_found("Knowledge base not found"));
    }

    // `repository.list_by_knowledge_base` (limit 50).
    let artifacts = list_by_knowledge_base(mysql, knowledge_base_id)
        .await
        .map_err(|_| storage_unavailable())?;

    // `can_manage_knowledge_base_documents` — the raw ACL chain again,
    // without the direct-access requirement step. The source calls
    // `get_user_knowledge_base_permission` without the `kb` argument, so the
    // Kind record is re-loaded with SQLAlchemy's `is_(True)` rendering
    // (`kinds.is_active IS true`) before the ACL sources resolve.
    let can_manage =
        can_manage_knowledge_base_documents(mysql, redis, resolvers, knowledge_base_id, user_id)
            .await
            .map_err(internal)?;

    // `_document_source_counts`.
    let (available_count, processing_count) = document_source_counts(mysql, knowledge_base_id)
        .await
        .map_err(internal)?;

    // `_reconcile_many` tail + `_set_user_capabilities`, then the
    // `KnowledgeArtifactListResponse` field order.
    let items = artifacts
        .iter()
        .map(|artifact| artifact_response(artifact, can_manage))
        .collect::<Vec<_>>();
    let response = json!({
        "items": items,
        "can_manage": can_manage,
        "available_document_count": available_count,
        "processing_document_count": processing_count,
    });
    Ok(serde_json::to_vec(&response).unwrap_or_default())
}

/// `ArtifactStorageError` -> `_execute`'s 503 mapping.
fn storage_unavailable() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::SERVICE_UNAVAILABLE,
        "Artifact storage is unavailable",
    )
}

/// Generic dependency failure -> `_execute`'s RuntimeError 503 mapping.
fn internal(error: impl std::fmt::Debug) -> FastApiError {
    tracing::error!(?error, "knowledge artifacts dependency failure");
    FastApiError::detail(
        brz_http_server::StatusCode::SERVICE_UNAVAILABLE,
        "Artifact generation is unavailable",
    )
}

/// One `knowledge_artifacts` row mapped through `_to_schema` (JSON columns
/// kept as opaque validated pass-through payloads; `task_id` /
/// `assistant_subtask_id` storage `0` converts to `None`).
#[derive(Debug, FromMysqlRow)]
struct ArtifactRow {
    knowledge_artifacts_artifact_id: String,
    knowledge_artifacts_knowledge_base_id: i64,
    knowledge_artifacts_artifact_type: String,
    knowledge_artifacts_title: String,
    knowledge_artifacts_status: String,
    knowledge_artifacts_task_id: i64,
    knowledge_artifacts_assistant_subtask_id: i64,
    knowledge_artifacts_content: Option<String>,
    knowledge_artifacts_source_document_ids:
        Option<brz_mysql::Json<crate::json_compat::OpaqueJson>>,
    knowledge_artifacts_generation_config: Option<brz_mysql::Json<crate::json_compat::OpaqueJson>>,
    knowledge_artifacts_error_message: Option<String>,
    knowledge_artifacts_user_id: i64,
    knowledge_artifacts_attempt: i64,
    knowledge_artifacts_created_at: chrono::NaiveDateTime,
    knowledge_artifacts_updated_at: chrono::NaiveDateTime,
}

impl ArtifactRow {
    /// `record.content or None` / `record.error_message or None`: empty
    /// strings are unavailable (None).
    fn content(&self) -> Option<&str> {
        self.knowledge_artifacts_content
            .as_deref()
            .filter(|content| !content.is_empty())
    }
    fn error_message(&self) -> Option<&str> {
        self.knowledge_artifacts_error_message
            .as_deref()
            .filter(|message| !message.is_empty())
    }
    /// `_id_from_storage`: `KNOWLEDGE_ARTIFACT_UNSET_ID` means None.
    fn task_id(&self) -> Option<i64> {
        (self.knowledge_artifacts_task_id != UNSET_ID).then_some(self.knowledge_artifacts_task_id)
    }
    fn assistant_subtask_id(&self) -> Option<i64> {
        (self.knowledge_artifacts_assistant_subtask_id != UNSET_ID)
            .then_some(self.knowledge_artifacts_assistant_subtask_id)
    }

    /// `_is_stalled`: the artifact's `updated_at` (session-local naive,
    /// UTC+8) is at least `KNOWLEDGE_ARTIFACT_STALL_SECONDS` old.
    fn is_stalled(&self, now_utc_naive: chrono::NaiveDateTime) -> bool {
        let offset =
            chrono::FixedOffset::east_opt(DB_SESSION_OFFSET_SECONDS).expect("valid fixed offset");
        let activity_at = self
            .knowledge_artifacts_updated_at
            .and_local_timezone(offset)
            .single()
            .map(|aware| aware.with_timezone(&chrono::Utc).naive_utc())
            .unwrap_or(self.knowledge_artifacts_updated_at);
        (now_utc_naive - activity_at).num_seconds() >= STALL_SECONDS.max(1)
    }

    /// `_apply_execution_health`: HEALTHY unless an active artifact is
    /// stalled.
    fn execution_health(&self, now_utc_naive: chrono::NaiveDateTime) -> &'static str {
        if status_is_active(&self.knowledge_artifacts_status) && self.is_stalled(now_utc_naive) {
            "stalled"
        } else {
            "healthy"
        }
    }

    /// `artifact.can_retry` after `_apply_execution_health`: FAILED, or an
    /// active artifact acknowledged as stalled.
    fn base_can_retry(&self, now_utc_naive: chrono::NaiveDateTime) -> bool {
        self.knowledge_artifacts_status == "failed"
            || self.execution_health(now_utc_naive) == "stalled"
    }
}

/// `repository.list_by_knowledge_base` — the full SQLAlchemy-labeled
/// projection, ordering, and limit of the source query.
async fn list_by_knowledge_base<M>(
    mysql: &M,
    knowledge_base_id: i64,
) -> MysqlResult<Vec<ArtifactRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT knowledge_artifacts.artifact_id AS knowledge_artifacts_artifact_id, \
                 knowledge_artifacts.knowledge_base_id AS knowledge_artifacts_knowledge_base_id, \
                 knowledge_artifacts.artifact_type AS knowledge_artifacts_artifact_type, \
                 knowledge_artifacts.title AS knowledge_artifacts_title, \
                 knowledge_artifacts.status AS knowledge_artifacts_status, \
                 knowledge_artifacts.task_id AS knowledge_artifacts_task_id, \
                 knowledge_artifacts.assistant_subtask_id AS \
                 knowledge_artifacts_assistant_subtask_id, \
                 knowledge_artifacts.content AS knowledge_artifacts_content, \
                 knowledge_artifacts.source_document_ids AS knowledge_artifacts_source_document_ids, \
                 knowledge_artifacts.generation_config AS knowledge_artifacts_generation_config, \
                 knowledge_artifacts.error_message AS knowledge_artifacts_error_message, \
                 knowledge_artifacts.user_id AS knowledge_artifacts_user_id, \
                 knowledge_artifacts.attempt AS knowledge_artifacts_attempt, \
                 knowledge_artifacts.created_at AS knowledge_artifacts_created_at, \
                 knowledge_artifacts.updated_at AS knowledge_artifacts_updated_at \n\
                 FROM knowledge_artifacts \n\
                 WHERE knowledge_artifacts.knowledge_base_id = {knowledge_base_id} \
                 ORDER BY knowledge_artifacts.created_at DESC, \
                 knowledge_artifacts.artifact_id DESC \n LIMIT 50"
            ),
            (),
        )
        .await
}

/// `can_manage_knowledge_base_documents` — the raw ACL facts of
/// `resolve_knowledge_base_permission` (creator/direct/organization/group/
/// entity role sources) without the direct-access requirement step, then
/// `can_manage_accessible_knowledge_base_documents`: creator or a role with
/// at least Developer permission. The Kind record is re-loaded first
/// (`get_user_knowledge_base_permission`'s `is_(True)` query).
async fn can_manage_knowledge_base_documents<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    knowledge_base_id: i64,
    user_id: i64,
) -> MysqlResult<bool>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let Some(kb) = permission_kb_record(mysql, knowledge_base_id).await? else {
        return Ok(false);
    };
    let (has_access, role, is_creator) =
        resolve_permission_facts(mysql, redis, resolvers, &kb, user_id).await?;
    Ok(has_access
        && (is_creator
            || role
                .as_deref()
                .is_some_and(|role| has_permission(role, "Developer"))))
}

/// `get_user_knowledge_base_permission`'s Kind lookup: SQLAlchemy renders
/// `Kind.is_active.is_(True)` as `kinds.is_active IS true` (unlike
/// `knowledge_base_record`'s `== True` rendering).
async fn permission_kb_record<M>(
    mysql: &M,
    knowledge_base_id: i64,
) -> MysqlResult<Option<KnowledgeBase>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        kinds_id: i64,
        kinds_user_id: i64,
        kinds_namespace: String,
        kinds_json: Json<OpaqueJson>,
        kinds_created_at: chrono::NaiveDateTime,
        kinds_updated_at: chrono::NaiveDateTime,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                 kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                 kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                 kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                 kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
                 WHERE kinds.id = {knowledge_base_id} AND kinds.kind = 'KnowledgeBase' \
                 AND kinds.is_active IS true \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| KnowledgeBase {
        kinds_id: row.kinds_id,
        kinds_user_id: row.kinds_user_id,
        kinds_namespace: row.kinds_namespace,
        kinds_json: row.kinds_json.0,
        kinds_created_at: row.kinds_created_at,
        kinds_updated_at: row.kinds_updated_at,
    }))
}

/// `BaseRole` rank comparison (`app.schemas.base_role`): lower is more
/// privileged.
fn role_rank(role: &str) -> Option<u8> {
    match role {
        "Owner" => Some(0),
        "Maintainer" => Some(1),
        "Developer" => Some(2),
        "Reporter" => Some(3),
        "RestrictedAnalyst" => Some(4),
        _ => None,
    }
}

/// `has_permission` (`app.schemas.base_role`).
fn has_permission(user_role: &str, required_role: &str) -> bool {
    match (role_rank(user_role), role_rank(required_role)) {
        (Some(user), Some(required)) => user <= required,
        _ => false,
    }
}

/// The highest role among candidates (`get_highest_role`).
fn highest_role(roles: &[String]) -> Option<String> {
    roles
        .iter()
        .filter(|role| role_rank(role).is_some())
        .min_by_key(|role| role_rank(role).unwrap())
        .cloned()
}

/// `resolve_knowledge_base_permission` role/creator facts. Shares the
/// source-appending behavior (user row, restricted analyst, direct
/// membership, organization, group, entity sources) with
/// `knowledge_documents_content::access`.
async fn resolve_permission_facts<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    kb: &KnowledgeBase,
    user_id: i64,
) -> MysqlResult<(bool, Option<String>, bool)>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    // `db.query(User)` by id.
    let user = access::user_by_id_row(mysql, user_id).await?;
    let user_role = user.as_ref().map(|row| row.users_role.clone());
    let is_creator = kb.kinds_user_id == user_id;

    let mut roles: Vec<String> = Vec::new();
    if is_creator {
        roles.push("Owner".to_string());
    }

    // Restricted-analyst pre-check (non-default, non-organization
    // namespaces, non-creators) is an explicit denial.
    if !is_creator && kb.kinds_namespace != "default" {
        let is_organization = access::is_organization_namespace(mysql, &kb.kinds_namespace).await?;
        if !is_organization
            && group_membership::is_restricted_analyst(
                mysql,
                redis,
                resolvers,
                user_id,
                &kb.kinds_namespace,
            )
            .await?
        {
            return Ok((false, None, is_creator));
        }
    }

    // Direct KB membership: a RestrictedAnalyst membership is an explicit
    // denial; any other role grants.
    if let Some(role) = access::direct_kb_member_role(mysql, kb.kinds_id, user_id).await? {
        if role == "RestrictedAnalyst" {
            return Ok((false, None, is_creator));
        }
        roles.push(role);
    }

    // Organization source, else group source for non-default namespaces.
    let is_organization = access::is_organization_namespace(mysql, &kb.kinds_namespace).await?;
    if is_organization {
        roles.push(
            if user_role.as_deref() == Some("admin") {
                "Owner"
            } else {
                "Reporter"
            }
            .to_string(),
        );
    } else if kb.kinds_namespace != "default"
        && let Some(group_role) = group_membership::effective_role_in_group(
            mysql,
            redis,
            resolvers,
            user_id,
            &kb.kinds_namespace,
        )
        .await?
    {
        if group_role == "RestrictedAnalyst" {
            return Ok((false, None, is_creator));
        }
        let base = match group_role.as_str() {
            "Owner" => "Owner",
            "Maintainer" => "Maintainer",
            "Developer" => "Developer",
            _ => "Reporter",
        };
        roles.push(base.to_string());
    }

    // Entity sources (`_append_entity_sources`).
    roles.extend(access::entity_source_roles(mysql, redis, resolvers, kb.kinds_id, user_id).await?);

    let has_access = !roles.is_empty() || is_creator;
    Ok((has_access, highest_role(&roles), is_creator))
}

/// `_document_source_counts`: usable (active + success) and processing
/// document counts for the knowledge base. `sum` renders DECIMAL columns;
/// the source converts None to 0 like `int(value or 0)`.
async fn document_source_counts<M>(mysql: &M, knowledge_base_id: i64) -> MysqlResult<(i64, i64)>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct CountRow {
        sum_1: Option<String>,
        sum_2: Option<String>,
    }
    let row: Option<CountRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT sum(CASE WHEN (knowledge_documents.is_active IS true AND \
                 knowledge_documents.index_status = 'success') THEN 1 ELSE 0 END) AS sum_1, \
                 sum(CASE WHEN (knowledge_documents.index_status \
                 IN ({PROCESSING_STATUSES})) THEN 1 ELSE 0 END) AS sum_2 \n\
                 FROM knowledge_documents \n\
                 WHERE knowledge_documents.kind_id = {knowledge_base_id}"
            ),
            (),
        )
        .await?;
    let Some(row) = row else {
        return Ok((0, 0));
    };
    let parse = |value: Option<String>| -> i64 {
        value.and_then(|text| text.trim().parse().ok()).unwrap_or(0)
    };
    Ok((parse(row.sum_1), parse(row.sum_2)))
}

/// The `KnowledgeArtifact` response projection (`items` entries) in the
/// pydantic model's field order, after `_apply_execution_health` and
/// `_set_user_capabilities(can_manage)`.
fn artifact_response(artifact: &ArtifactRow, can_manage: bool) -> serde_json::Value {
    // `datetime.now(timezone.utc).replace(tzinfo=None)` — the health window
    // reference; with empty recorded items this value never renders.
    let now_utc_naive = chrono::Utc::now().naive_utc();
    let execution_health = artifact.execution_health(now_utc_naive);
    // `is_active`: an active status with non-STALLED health.
    let is_active =
        status_is_active(&artifact.knowledge_artifacts_status) && execution_health != "stalled";
    json!({
        "attempt": artifact.knowledge_artifacts_attempt,
        "artifact_id": artifact.knowledge_artifacts_artifact_id,
        "knowledge_base_id": artifact.knowledge_artifacts_knowledge_base_id,
        "artifact_type": artifact.knowledge_artifacts_artifact_type,
        "title": artifact.knowledge_artifacts_title,
        "status": artifact.knowledge_artifacts_status,
        "task_id": artifact.task_id(),
        "assistant_subtask_id": artifact.assistant_subtask_id(),
        "content": artifact.content(),
        "source_document_ids": artifact
            .knowledge_artifacts_source_document_ids
            .as_ref()
            .map(|ids| ids.0.to_value())
            .unwrap_or_else(|| json!([])),
        "generation_config": artifact
            .knowledge_artifacts_generation_config
            .as_ref()
            .map(|config| config.0.to_value())
            .unwrap_or_else(|| json!({})),
        "error_message": artifact.error_message(),
        "execution_health": execution_health,
        "can_retry": can_manage && artifact.base_can_retry(now_utc_naive),
        "can_delete": can_manage && !is_active,
        "user_id": artifact.knowledge_artifacts_user_id,
        "created_at": artifact
            .knowledge_artifacts_created_at
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string(),
        "updated_at": artifact
            .knowledge_artifacts_updated_at
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(status: &str, updated_at: chrono::NaiveDateTime) -> ArtifactRow {
        ArtifactRow {
            knowledge_artifacts_artifact_id: "a1".to_string(),
            knowledge_artifacts_knowledge_base_id: 304487,
            knowledge_artifacts_artifact_type: "briefing".to_string(),
            knowledge_artifacts_title: "t".to_string(),
            knowledge_artifacts_status: status.to_string(),
            knowledge_artifacts_task_id: 0,
            knowledge_artifacts_assistant_subtask_id: 0,
            knowledge_artifacts_content: Some(String::new()),
            knowledge_artifacts_source_document_ids: None,
            knowledge_artifacts_generation_config: None,
            knowledge_artifacts_error_message: Some(String::new()),
            knowledge_artifacts_user_id: 3272,
            knowledge_artifacts_attempt: 1,
            knowledge_artifacts_created_at: updated_at,
            knowledge_artifacts_updated_at: updated_at,
        }
    }

    #[test]
    fn unset_ids_map_to_none() {
        let artifact = row("queued", chrono::NaiveDateTime::default());
        assert_eq!(artifact.task_id(), None);
        assert_eq!(artifact.assistant_subtask_id(), None);
        assert_eq!(artifact.content(), None);
        assert_eq!(artifact.error_message(), None);
    }

    #[test]
    fn active_recent_artifact_is_healthy_and_not_deletable() {
        let now = chrono::Utc::now().naive_utc();
        // The DB stores session-local (UTC+8) naive datetimes: a fresh
        // wall clock is eight hours ahead of the UTC-naive reference.
        let artifact = row("running", now + chrono::Duration::hours(8));
        assert_eq!(artifact.execution_health(now), "healthy");
        let response = artifact_response(&artifact, true);
        assert_eq!(response["execution_health"], "healthy");
        assert_eq!(response["can_delete"], false);
        assert_eq!(response["can_retry"], false);
    }

    #[test]
    fn stale_active_artifact_is_stalled_and_retryable() {
        let now = chrono::Utc::now().naive_utc();
        // The DB stores session-local (UTC+8) naive datetimes; eight hours
        // behind UTC-naive means freshly updated.
        let local = now + chrono::Duration::hours(8) - chrono::Duration::seconds(700);
        let artifact = row("running", local);
        assert_eq!(artifact.execution_health(now), "stalled");
        let response = artifact_response(&artifact, true);
        assert_eq!(response["can_delete"], true);
        assert_eq!(response["can_retry"], true);
    }

    #[test]
    fn failed_artifact_retry_requires_manage() {
        let now = chrono::Utc::now().naive_utc();
        let artifact = row("failed", now + chrono::Duration::hours(8));
        let managed = artifact_response(&artifact, true);
        assert_eq!(managed["can_retry"], true);
        assert_eq!(managed["can_delete"], true);
        let unmanaged = artifact_response(&artifact, false);
        assert_eq!(unmanaged["can_retry"], false);
        assert_eq!(unmanaged["can_delete"], false);
    }

    #[test]
    fn manage_requires_access_and_developer_role() {
        assert!(!has_permission("Reporter", "Developer"));
        assert!(has_permission("Developer", "Developer"));
        assert!(has_permission("Owner", "Developer"));
        assert_eq!(
            highest_role(&["Reporter".to_string(), "Maintainer".to_string()]).as_deref(),
            Some("Maintainer")
        );
    }
}
