// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Attachment context and access storage mirroring
//! `context_service.get_context_optional`, `_get_attachment_context`,
//! `_ensure_attachment_access`, and the subtask/task/kind readers they use.
//!
//! The `subtask_contexts` row keeps the full source column projection (the
//! SQL sent to MySQL matches the source statement); only the fields the
//! download path reads are exposed through accessors.

use crate::json_compat::{JsonProjection, OpaqueJson};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use super::auth::UserRow;
use crate::task_routing::{ByTaskId, ByUserId, TaskPolicy};

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct AttachmentMetadata {
    pub original_filename: Option<String>,
    pub file_extension: Option<String>,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub storage_key: Option<String>,
    pub storage_backend: Option<String>,
    pub is_encrypted: Option<bool>,
    pub video_metadata: Option<VideoMetadata>,
    pub source: Option<String>,
    pub external_media_type: Option<String>,
    pub site: Option<OpaqueJson>,
    pub external_source_url: Option<OpaqueJson>,
    pub cover_url: Option<OpaqueJson>,
    pub comment_count: Option<OpaqueJson>,
    pub fetched_comment_count: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct VideoMetadata {
    pub video_url: Option<String>,
}

/// One `subtask_contexts` row (`SubtaskContext`). Each field decodes from
/// the SQLAlchemy-labeled alias (`subtask_contexts_<column>`) the source
/// statement selects; the replay matcher requires that exact projection.
#[derive(Debug, FromMysqlRow)]
pub struct SubtaskContextRow {
    #[mysql(rename = "subtask_contexts_id")]
    pub id: i64,
    #[mysql(rename = "subtask_contexts_subtask_id")]
    pub subtask_id: i64,
    #[mysql(rename = "subtask_contexts_user_id")]
    pub user_id: i32,
    #[mysql(rename = "subtask_contexts_context_type")]
    pub context_type: String,
    #[mysql(rename = "subtask_contexts_name")]
    pub name: String,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_status")]
    pub status: String,
    #[mysql(rename = "subtask_contexts_error_message")]
    pub error_message: Option<String>,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_binary_data")]
    pub binary_data: Vec<u8>,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_image_base64")]
    pub image_base64: Option<String>,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_extracted_text")]
    pub extracted_text: Option<String>,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_text_length")]
    pub text_length: i32,
    #[mysql(rename = "subtask_contexts_type_data")]
    pub type_data: Option<Json<JsonProjection<AttachmentMetadata>>>,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
}

impl SubtaskContextRow {
    pub fn metadata(&self) -> Option<&AttachmentMetadata> {
        self.type_data.as_ref()?.0.value.as_ref()
    }
    pub fn original_filename(&self) -> String {
        self.metadata()
            .and_then(|data| data.original_filename.as_deref())
            .unwrap_or(&self.name)
            .to_owned()
    }
    pub fn file_extension(&self) -> String {
        self.metadata()
            .and_then(|data| data.file_extension.as_deref())
            .unwrap_or("")
            .to_owned()
    }
    pub fn mime_type(&self) -> String {
        self.metadata()
            .and_then(|data| data.mime_type.as_deref())
            .unwrap_or("")
            .to_owned()
    }
    pub fn file_size(&self) -> i64 {
        self.metadata().and_then(|data| data.file_size).unwrap_or(0)
    }
    pub fn storage_key(&self) -> String {
        self.metadata()
            .and_then(|data| data.storage_key.as_deref())
            .unwrap_or("")
            .to_owned()
    }
    pub fn storage_backend(&self) -> String {
        self.metadata()
            .and_then(|data| data.storage_backend.as_deref())
            .unwrap_or("mysql")
            .to_owned()
    }
    pub fn is_encrypted(&self) -> bool {
        self.metadata()
            .and_then(|data| data.is_encrypted)
            .unwrap_or(false)
    }
    #[allow(dead_code)]
    pub fn video_url(&self) -> Option<&str> {
        self.metadata()?
            .video_metadata
            .as_ref()?
            .video_url
            .as_deref()
            .filter(|url| !url.is_empty())
    }
}

/// `context_service.get_context_optional`: the full source column list for
/// `SELECT ... FROM subtask_contexts WHERE id = ? LIMIT 1`.
pub async fn get_context_optional<M>(
    mysql: &M,
    context_id: i64,
) -> MysqlResult<Option<SubtaskContextRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT subtask_contexts.id AS subtask_contexts_id, \
             subtask_contexts.subtask_id AS subtask_contexts_subtask_id, \
             subtask_contexts.user_id AS subtask_contexts_user_id, \
             subtask_contexts.context_type AS subtask_contexts_context_type, \
             subtask_contexts.name AS subtask_contexts_name, \
             subtask_contexts.status AS subtask_contexts_status, \
             subtask_contexts.error_message AS subtask_contexts_error_message, \
             subtask_contexts.binary_data AS subtask_contexts_binary_data, \
             subtask_contexts.image_base64 AS subtask_contexts_image_base64, \
             subtask_contexts.extracted_text AS subtask_contexts_extracted_text, \
             subtask_contexts.text_length AS subtask_contexts_text_length, \
             subtask_contexts.type_data AS subtask_contexts_type_data, \
             subtask_contexts.created_at AS subtask_contexts_created_at, \
             subtask_contexts.updated_at AS subtask_contexts_updated_at \
             FROM subtask_contexts \
             WHERE subtask_contexts.id = ? \
             LIMIT 1",
            (context_id,),
        )
        .await
}

/// `context_service.get_context_optional(context_id, user_id=...)`: the
/// same full column list with the ownership filter appended
/// (`executor_download_attachment`; the executor path resolves the row by
/// `id AND user_id` instead of the task/member access chain).
pub async fn get_context_optional_with_user<M>(
    mysql: &M,
    context_id: i64,
    user_id: i64,
) -> MysqlResult<Option<SubtaskContextRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT subtask_contexts.id AS subtask_contexts_id, \
             subtask_contexts.subtask_id AS subtask_contexts_subtask_id, \
             subtask_contexts.user_id AS subtask_contexts_user_id, \
             subtask_contexts.context_type AS subtask_contexts_context_type, \
             subtask_contexts.name AS subtask_contexts_name, \
             subtask_contexts.status AS subtask_contexts_status, \
             subtask_contexts.error_message AS subtask_contexts_error_message, \
             subtask_contexts.binary_data AS subtask_contexts_binary_data, \
             subtask_contexts.image_base64 AS subtask_contexts_image_base64, \
             subtask_contexts.extracted_text AS subtask_contexts_extracted_text, \
             subtask_contexts.text_length AS subtask_contexts_text_length, \
             subtask_contexts.type_data AS subtask_contexts_type_data, \
             subtask_contexts.created_at AS subtask_contexts_created_at, \
             subtask_contexts.updated_at AS subtask_contexts_updated_at \
             FROM subtask_contexts \
             WHERE subtask_contexts.id = ? AND subtask_contexts.user_id = ? \
             LIMIT 1",
            (context_id, user_id),
        )
        .await
}

/// A `subtasks`/`subtasks_{:04}` row restricted to the linkage columns
/// (`SubtaskStore.get_by_id`/`list_by_user` projections).
#[derive(Debug, FromMysqlRow)]
pub struct SubtaskRow {
    pub id: i64,
    #[allow(dead_code)]
    pub user_id: i32,
    pub task_id: i64,
}

/// `subtask_store.get_by_id`: the configured repository resolves the table
/// from the subtask id. The public policy performs one base-table read; the
/// private migration policy retains the fallback probe for moved rows.
pub async fn get_subtask_by_id<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    subtask_id: i64,
) -> MysqlResult<Option<SubtaskRow>>
where
    M: Mysql,
{
    let sql = "SELECT id, user_id, task_id FROM {{subtasks}} WHERE id = ? LIMIT 1";
    let row: Option<SubtaskRow> = mysql
        .route(ByTaskId(subtask_id as u64))
        .fetch_optional(sql, (subtask_id,))
        .await?;
    if row.is_some() {
        return Ok(row);
    }
    if !task_policy.resolve_migrated_legacy {
        return Ok(None);
    }
    // Legacy/migrated fallback: the base `subtasks` index row. A legacy id
    // already routes to the base table via `ByTaskId`, so this fallback is
    // only reached when the first query resolved to a shard table and missed.
    let fallback: Option<SubtaskRow> = mysql
        .fetch_optional(
            "SELECT id, user_id, task_id FROM subtasks WHERE id = ? LIMIT 1",
            (subtask_id,),
        )
        .await?;
    Ok(fallback)
}

/// `subtask_store.list_by_user` (limit 1): the public policy reads the base
/// table; the private migration policy additionally checks the owner's shard
/// and merges by descending id.
pub async fn get_latest_subtask_by_user<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    user_id: i32,
) -> MysqlResult<Option<SubtaskRow>>
where
    M: Mysql,
{
    let base: Option<SubtaskRow> = mysql
        .fetch_optional(
            "SELECT id, user_id, task_id FROM subtasks WHERE user_id = ? \
             ORDER BY id DESC LIMIT 1",
            (user_id,),
        )
        .await?;
    if !task_policy.resolve_migrated_legacy {
        return Ok(base);
    }
    let shard: Option<SubtaskRow> = mysql
        .route(ByUserId(user_id as u64))
        .fetch_optional(
            "SELECT id, user_id, task_id FROM {{subtasks}} WHERE user_id = ? \
             ORDER BY id DESC LIMIT 1",
            (user_id,),
        )
        .await?;
    Ok(match (base, shard) {
        (Some(base), Some(shard)) => Some(if base.id >= shard.id { base } else { shard }),
        (base, shard) => base.or(shard),
    })
}

/// A `tasks`/`tasks_{:04}` row restricted to the ownership columns
/// (`TaskStore.get_by_id`).
#[derive(Debug, FromMysqlRow)]
pub struct TaskRow {
    #[allow(dead_code)]
    pub id: i64,
    pub user_id: i32,
    pub kind: String,
}

/// `task_store.get_by_id`: the configured routed table. The public policy
/// performs one base-table read; the private migration policy keeps the
/// fallback probe for a shard miss.
pub async fn get_task_by_id<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    task_id: i64,
) -> MysqlResult<Option<TaskRow>>
where
    M: Mysql,
{
    let sql = "SELECT id, user_id, kind FROM {{tasks}} WHERE id = ? LIMIT 1";
    let row: Option<TaskRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(sql, (task_id,))
        .await?;
    if row.is_some() {
        return Ok(row);
    }
    if !task_policy.resolve_migrated_legacy {
        return Ok(None);
    }
    // Legacy/migrated fallback: the base `tasks` index row. A legacy id
    // already routes to the base table via `ByTaskId`, so this fallback is
    // only reached when the first query resolved to a shard table and missed.
    mysql
        .fetch_optional(
            "SELECT id, user_id, kind FROM tasks WHERE id = ? LIMIT 1",
            (task_id,),
        )
        .await
}

/// `resource_members` approved-membership probe (`_check_task_access`).
pub async fn is_task_member<M>(mysql: &M, task_id: i64, user_id: i32) -> MysqlResult<bool>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct MemberRow {
        #[allow(dead_code)]
        id: i64,
    }
    let member: Option<MemberRow> = mysql
        .fetch_optional(
            "SELECT resource_members.id AS resource_members_id \
             FROM resource_members \
             WHERE resource_members.resource_type = 'Task' \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' \
             AND resource_members.copied_resource_id = 0 \
             LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await?;
    Ok(member.is_some())
}

/// `_check_knowledge_base_access`: `None` when the attachment is not a
/// knowledge-base document; otherwise the KB ACL verdict.
pub async fn check_knowledge_base_access<M>(
    mysql: &M,
    attachment_id: i64,
    user_id: i32,
) -> MysqlResult<Option<bool>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct KnowledgeDocumentRow {
        kind_id: i32,
    }
    let document: Option<KnowledgeDocumentRow> = mysql
        .fetch_optional(
            "SELECT knowledge_documents.kind_id AS knowledge_documents_kind_id \
             FROM knowledge_documents \
             WHERE knowledge_documents.attachment_id = ? \
             LIMIT 1",
            (attachment_id,),
        )
        .await?;
    let Some(document) = document else {
        return Ok(None);
    };
    Ok(Some(
        knowledge_base_allows_access(mysql, document.kind_id, user_id).await?,
    ))
}

/// `KnowledgeService.get_knowledge_base` restricted to the ACL verdict:
/// creator, approved direct member (RestrictedAnalyst denied), organization
/// namespace, or group membership.
async fn knowledge_base_allows_access<M>(
    mysql: &M,
    knowledge_base_id: i32,
    user_id: i32,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct KindRow {
        #[allow(dead_code)]
        id: i32,
        user_id: i32,
        namespace: String,
        #[allow(dead_code)]
        json: Option<Json<OpaqueJson>>,
    }
    let knowledge_base: Option<KindRow> = mysql
        .fetch_optional(
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json \
             FROM kinds \
             WHERE kinds.id = ? AND kinds.kind = 'KnowledgeBase' \
             AND kinds.is_active = 1 LIMIT 1",
            (knowledge_base_id,),
        )
        .await?;
    let Some(knowledge_base) = knowledge_base else {
        return Ok(false);
    };
    // Creator always has access (`_append_creator_source`).
    if knowledge_base.user_id == user_id {
        return Ok(true);
    }
    // Approved direct membership (`_append_direct_member_source`);
    // RestrictedAnalyst is an explicit denial.
    #[derive(Debug, FromMysqlRow)]
    struct MemberRow {
        role: Option<String>,
    }
    let member: Option<MemberRow> = mysql
        .fetch_optional(
            "SELECT resource_members.role AS resource_members_role \
             FROM resource_members \
             WHERE resource_members.resource_type IN ('KnowledgeBase') \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status IN ('approved', 'APPROVED') \
             LIMIT 1",
            (knowledge_base_id, user_id.to_string()),
        )
        .await?;
    if let Some(member) = member {
        if member.role.as_deref() == Some("RestrictedAnalyst") {
            return Ok(false);
        }
        return Ok(true);
    }
    // Organization namespace: every user has Reporter access.
    let organization = is_organization_namespace(mysql, &knowledge_base.namespace).await?;
    if organization {
        return Ok(true);
    }
    // Group namespace: an effective role grants access.
    if knowledge_base.namespace != "default" {
        return group_role_grants_access(mysql, &knowledge_base.namespace, user_id).await;
    }
    Ok(false)
}

/// `is_organization_namespace`: the namespace row's `level` is `organization`.
async fn is_organization_namespace<M>(mysql: &M, namespace_name: &str) -> MysqlResult<bool>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct NamespaceRow {
        #[allow(dead_code)]
        id: i32,
        level: Option<String>,
    }
    let namespace: Option<NamespaceRow> = mysql
        .fetch_optional(
            "SELECT namespace.id AS namespace_id, namespace.level AS namespace_level \
             FROM namespace \
             WHERE namespace.name = ? AND namespace.is_active = 1 LIMIT 1",
            (namespace_name,),
        )
        .await?;
    Ok(namespace
        .and_then(|namespace| namespace.level)
        .is_some_and(|level| level == "organization"))
}

/// `get_effective_role_in_group` (direct membership plus parent-group
/// inheritance) followed by the Reporter-or-above check used by the source
/// group ACL.
async fn group_role_grants_access<M>(mysql: &M, group_name: &str, user_id: i32) -> MysqlResult<bool>
where
    M: Mysql,
{
    if let Some(role) = direct_role_in_group(mysql, group_name, user_id).await? {
        return Ok(is_group_role_or_above(&role));
    }
    if group_name.contains('/') {
        let parts: Vec<&str> = group_name.split('/').collect();
        for index in (1..parts.len()).rev() {
            let parent = parts[..index].join("/");
            if let Some(role) = direct_role_in_group(mysql, &parent, user_id).await? {
                return Ok(is_group_role_or_above(&role));
            }
        }
    }
    Ok(false)
}

async fn direct_role_in_group<M>(
    mysql: &M,
    group_name: &str,
    user_id: i32,
) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct NamespaceIdRow {
        #[allow(dead_code)]
        id: i32,
    }
    let namespace: Option<NamespaceIdRow> = mysql
        .fetch_optional(
            "SELECT namespace.id AS namespace_id FROM namespace \
             WHERE namespace.name = ? AND namespace.is_active = 1 LIMIT 1",
            (group_name,),
        )
        .await?;
    let Some(namespace) = namespace else {
        return Ok(None);
    };
    #[derive(Debug, FromMysqlRow)]
    struct MemberRow {
        role: Option<String>,
    }
    let member: Option<MemberRow> = mysql
        .fetch_optional(
            "SELECT resource_members.role AS resource_members_role \
             FROM resource_members \
             WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' \
             LIMIT 1",
            (namespace.id, user_id.to_string()),
        )
        .await?;
    Ok(member.and_then(|member| member.role))
}

/// Group-role hierarchy check: Reporter (level 3) and above grant access.
fn is_group_role_or_above(role: &str) -> bool {
    fn hierarchy(role: &str) -> Option<u32> {
        match role {
            "Owner" => Some(0),
            "Maintainer" => Some(1),
            "Developer" => Some(2),
            "Reporter" => Some(3),
            "RestrictedAnalyst" => Some(4),
            _ => None,
        }
    }
    hierarchy(role).is_some_and(|level| level <= 3)
}

/// `_ensure_attachment_access`: uploader, task owner/member through the
/// subtask linkage, knowledge-base ACL, or the owner-fallback subtask probe.
pub async fn ensure_attachment_access<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    context: &SubtaskContextRow,
    current_user: &UserRow,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    // 1. Uploader.
    if context.user_id == current_user.users_id {
        return Ok(true);
    }

    let mut task_id: Option<i64> = None;
    if context.subtask_id > 0 {
        // 2. Linked attachment: find the task via the subtask.
        if let Some(subtask) = get_subtask_by_id(mysql, task_policy, context.subtask_id).await? {
            task_id = Some(subtask.task_id);
        }
    } else {
        // 3. Unlinked: knowledge-base ACL first (hard verdicts), then the
        // executor-uploaded legacy fallback through the owner's subtask.
        match check_knowledge_base_access(mysql, context.id, current_user.users_id).await? {
            Some(access) => return Ok(access),
            None => {
                if let Some(subtask) =
                    get_latest_subtask_by_user(mysql, task_policy, context.user_id).await?
                {
                    task_id = Some(subtask.task_id);
                }
            }
        }
    }

    if let Some(task_id) = task_id {
        return check_task_access(mysql, task_policy, task_id, current_user.users_id).await;
    }
    Ok(false)
}

/// `_check_task_access`: task owner or approved task member.
async fn check_task_access<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    task_id: i64,
    user_id: i32,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    if let Some(task) = get_task_by_id(mysql, task_policy, task_id).await?
        && task.kind == "Task"
        && task.user_id == user_id
    {
        return Ok(true);
    }
    is_task_member(mysql, task_id, user_id).await
}
