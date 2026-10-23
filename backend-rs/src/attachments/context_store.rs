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

use brz_json::{JsonProjection, OpaqueJson};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;

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
    /// Media ids persisted by the external storage adapter.
    pub weibo_video_upload: Option<MediaUploadReference>,
    pub weibo_audio_upload: Option<MediaUploadReference>,
    /// Legacy file-platform id of a knowledge-base video
    /// (`weibo_media_service.get_download_url`).
    pub fid: Option<OpaqueJson>,
    /// `type_data.public_asset_type`: the admin-uploaded public team icon
    /// marker (`admin/public_teams.py` `TEAM_ICON_ASSET_TYPE`).
    pub public_asset_type: Option<String>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct VideoMetadata {
    pub video_url: Option<String>,
    pub media_id: Option<OpaqueJson>,
    pub cover_url: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct MediaUploadReference {
    pub media_id: Option<OpaqueJson>,
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

    /// `_attachment_cover_url(context)`: the persisted cover URL from the
    /// decoded `type_data`, `None` for every other attachment.
    pub fn attachment_cover_url(&self) -> Option<String> {
        self.metadata()?.attachment_cover_url()
    }
}

impl AttachmentMetadata {
    /// The stored media reference: the persisted external upload reference as
    /// `(media_type, str(media_id))`, `None` when the attachment carries none.
    pub fn stored_media_reference(&self) -> Option<(&'static str, String)> {
        for (media_type, upload) in [
            ("video", &self.weibo_video_upload),
            ("audio", &self.weibo_audio_upload),
        ] {
            let media_id = upload
                .as_ref()
                .and_then(|upload| upload.media_id.as_ref())
                .and_then(truthy_str);
            if let Some(media_id) = media_id {
                return Some((media_type, media_id));
            }
        }
        let media_id = self
            .video_metadata
            .as_ref()
            .and_then(|video| video.media_id.as_ref())
            .and_then(truthy_str)?;
        Some(("video", media_id))
    }

    /// The legacy playback resolver's file-platform `fid` of a legacy video,
    /// `None` for every other attachment.
    pub fn legacy_weibo_fid(&self) -> Option<String> {
        if self.storage_backend.as_deref() != Some("weibo") {
            return None;
        }
        self.fid.as_ref().and_then(truthy_str)
    }

    /// `_attachment_cover_url`: the persisted cover URL, preferring the
    /// `video_metadata.cover_url` nested value over the top-level
    /// `type_data.cover_url`.
    pub fn attachment_cover_url(&self) -> Option<String> {
        if let Some(cover) = self
            .video_metadata
            .as_ref()
            .and_then(|video| video.cover_url.as_ref())
            .and_then(truthy_str)
        {
            return Some(cover);
        }
        self.cover_url.as_ref().and_then(truthy_str)
    }
}

/// `bool(value)` and `str(value)`: the Python truthiness and string form the
/// resolver applies to the `type_data` scalars it reads.
fn truthy_str(value: &OpaqueJson) -> Option<String> {
    let value = value.to_value();
    let truthy = match &value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(number) => number.as_f64() != Some(0.0),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(values) => !values.is_empty(),
        serde_json::Value::Object(object) => !object.is_empty(),
    };
    truthy.then(|| python_str(&value))
}

/// `str(value)` for the JSON scalars the resolver reads.
fn python_str(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Bool(flag) => if *flag { "True" } else { "False" }.to_string(),
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::Null => "None".to_string(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// The Python `str()` form of one stored media-reference scalar, shared by
/// the legacy playback resolver and the history reference resolver.
pub fn python_media_scalar(value: &serde_json::Value) -> String {
    python_str(value)
}

impl AttachmentMetadata {
    /// Decode the metadata projection from a raw `type_data` JSON value
    /// (`JsonProjection`'s tolerant decode: wrong-shape JSON is `None`).
    pub fn from_json_value(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// `context_service.get_context_optional`: the full source column list for
/// `SELECT ... FROM subtask_contexts WHERE id = ? LIMIT 1`.
pub const CONTEXT_BY_ID_QUERY: &str = "SELECT subtask_contexts.id AS subtask_contexts_id, \
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
     LIMIT 1";

pub async fn get_context_optional<M>(
    mysql: &M,
    context_id: i64,
) -> MysqlResult<Option<SubtaskContextRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(CONTEXT_BY_ID_QUERY, (context_id,))
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
    #[allow(
        dead_code,
        reason = "selected to match the source projection; the store compares ids before decoding"
    )]
    pub id: i64,
    #[allow(dead_code)]
    pub user_id: i32,
    pub task_id: i64,
}

/// `subtask_store.get_by_id`: the configured repository resolves the table
/// from the subtask id. The public policy performs one base-table read; the
/// private migration policy retains the fallback probe for moved rows.
pub async fn get_subtask_by_id(
    task_store: &dyn crate::task_store::TaskStore,
    subtask_id: i64,
) -> MysqlResult<Option<SubtaskRow>> {
    let row = task_store.get_subtask_ref(subtask_id).await?;
    row.map(SubtaskRow::from_mysql_row).transpose()
}

/// `subtask_store.list_by_user` (limit 1): the public policy reads the base
/// table; the private migration policy additionally checks the owner's shard
/// and merges by descending id.
pub async fn get_latest_subtask_by_user(
    task_store: &dyn crate::task_store::TaskStore,
    user_id: i32,
) -> MysqlResult<Option<SubtaskRow>> {
    let row = task_store.get_latest_subtask_ref_for_user(user_id).await?;
    row.map(SubtaskRow::from_mysql_row).transpose()
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
pub async fn get_task_by_id(
    task_store: &dyn crate::task_store::TaskStore,
    task_id: i64,
) -> MysqlResult<Option<TaskRow>> {
    let row = task_store.get_task_ref(task_id).await?;
    row.map(TaskRow::from_mysql_row).transpose()
}

/// `resource_members` approved-membership probe (`_check_task_access`).
///
/// The source issues `db.query(ResourceMember).filter(...).first()`, so the
/// statement selects the full mapped projection in mapper order and filters
/// only on the five source predicates. `copied_resource_id` is not part of
/// this query: an approved member of a shared task copy still matches the
/// source's ownership check.
pub async fn is_task_member<M>(mysql: &M, task_id: i64, user_id: i32) -> MysqlResult<bool>
where
    M: Mysql,
{
    let member: Option<MysqlRow> = mysql
        .fetch_optional(
            "SELECT resource_members.id AS resource_members_id, \
             resource_members.resource_type AS resource_members_resource_type, \
             resource_members.resource_id AS resource_members_resource_id, \
             resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, \
             resource_members.entity_display_name AS resource_members_entity_display_name, \
             resource_members.user_id AS resource_members_user_id, \
             resource_members.`role` AS resource_members_role, \
             resource_members.status AS resource_members_status, \
             resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
             resource_members.share_link_id AS resource_members_share_link_id, \
             resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
             resource_members.reviewed_at AS resource_members_reviewed_at, \
             resource_members.copied_resource_id AS resource_members_copied_resource_id, \
             resource_members.requested_at AS resource_members_requested_at, \
             resource_members.created_at AS resource_members_created_at, \
             resource_members.updated_at AS resource_members_updated_at \
             FROM resource_members \
             WHERE resource_members.resource_type = 'Task' \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' \
             LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await?;
    Ok(member.is_some())
}

/// `_check_knowledge_base_access`: `None` when the attachment is not a
/// knowledge-base document; otherwise the KB ACL verdict.
///
/// The source's `db.query(KnowledgeDocument).filter(attachment_id ==
/// id).first()` renders the full labeled projection as one statement, then
/// the ORM's `lazy="selectin"` external-source relationship fires for the
/// loaded document. `KnowledgeService.get_knowledge_base` is the shared KB
/// ACL port (`knowledge_documents_content::access`), which reproduces the
/// creator/direct-member/organization/group/entity resolution sequence.
pub async fn check_knowledge_base_access<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    attachment_id: i64,
    user_id: i32,
) -> MysqlResult<Option<bool>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    #[derive(Debug, FromMysqlRow)]
    struct KnowledgeDocumentRow {
        #[mysql(rename = "knowledge_documents_id")]
        id: i64,
        #[mysql(rename = "knowledge_documents_kind_id")]
        kind_id: i32,
    }
    let document: Option<KnowledgeDocumentRow> = mysql
        .fetch_optional(
            "SELECT knowledge_documents.id AS knowledge_documents_id, \
             knowledge_documents.kind_id AS knowledge_documents_kind_id, \
             knowledge_documents.attachment_id AS knowledge_documents_attachment_id, \
             knowledge_documents.name AS knowledge_documents_name, \
             knowledge_documents.file_extension AS knowledge_documents_file_extension, \
             knowledge_documents.file_size AS knowledge_documents_file_size, \
             knowledge_documents.status AS knowledge_documents_status, \
             knowledge_documents.user_id AS knowledge_documents_user_id, \
             knowledge_documents.is_active AS knowledge_documents_is_active, \
             knowledge_documents.index_status AS knowledge_documents_index_status, \
             knowledge_documents.index_generation AS knowledge_documents_index_generation, \
             knowledge_documents.splitter_config AS knowledge_documents_splitter_config, \
             knowledge_documents.source_type AS knowledge_documents_source_type, \
             knowledge_documents.source_config AS knowledge_documents_source_config, \
             knowledge_documents.origin AS knowledge_documents_origin, \
             knowledge_documents.folder_id AS knowledge_documents_folder_id, \
             knowledge_documents.summary AS knowledge_documents_summary, \
             knowledge_documents.chunks AS knowledge_documents_chunks, \
             knowledge_documents.created_at AS knowledge_documents_created_at, \
             knowledge_documents.updated_at AS knowledge_documents_updated_at \
             FROM knowledge_documents \
             WHERE knowledge_documents.attachment_id = ? \
             LIMIT 1",
            (attachment_id,),
        )
        .await?;
    let Some(document) = document else {
        return Ok(None);
    };
    // `external_source` (`lazy="selectin"`): loads with the document row.
    crate::knowledge_documents_content::reader::external_sources_by_document_ids(
        mysql,
        &[document.id],
    )
    .await?;
    let Some(knowledge_base) = crate::knowledge_documents_content::access::knowledge_base_record(
        mysql,
        i64::from(document.kind_id),
    )
    .await?
    else {
        return Ok(Some(false));
    };
    let access = crate::knowledge_documents_content::access::knowledge_base_access(
        mysql,
        redis,
        resolvers,
        &knowledge_base,
        i64::from(user_id),
    )
    .await
    .map_err(|_| brz_mysql::MysqlError::InvalidQuery {
        reason: "knowledge base access check failed".to_owned(),
    })?;
    Ok(Some(access))
}

/// `_ensure_attachment_access`: uploader, task owner/member through the
/// subtask linkage, knowledge-base ACL, or the owner-fallback subtask probe.
pub async fn ensure_attachment_access<R: brz_redis::Redis>(
    task_store: &dyn crate::task_store::TaskStore,
    mysql: &brz_mysql::MysqlService,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    context: &SubtaskContextRow,
    user_id: i32,
) -> MysqlResult<bool> {
    // 1. Uploader.
    if context.user_id == user_id {
        return Ok(true);
    }

    let mut task_id: Option<i64> = None;
    if context.subtask_id > 0 {
        // 2. Linked attachment: find the task via the subtask.
        if let Some(subtask) = get_subtask_by_id(task_store, context.subtask_id).await? {
            task_id = Some(subtask.task_id);
        }
    } else {
        // 3. Unlinked: knowledge-base ACL first (hard verdicts), then the
        // executor-uploaded legacy fallback through the owner's subtask.
        match check_knowledge_base_access(mysql, redis, resolvers, context.id, user_id).await? {
            Some(access) => return Ok(access),
            None => {
                if let Some(subtask) =
                    get_latest_subtask_by_user(task_store, context.user_id).await?
                {
                    task_id = Some(subtask.task_id);
                }
            }
        }
    }

    if let Some(task_id) = task_id {
        return check_task_access(task_store, mysql, task_id, user_id).await;
    }
    Ok(false)
}

/// `_check_task_access`: task owner or approved task member.
async fn check_task_access(
    task_store: &dyn crate::task_store::TaskStore,
    mysql: &brz_mysql::MysqlService,
    task_id: i64,
    user_id: i32,
) -> MysqlResult<bool> {
    if let Some(task) = get_task_by_id(task_store, task_id).await?
        && task.kind == "Task"
        && task.user_id == user_id
    {
        return Ok(true);
    }
    is_task_member(mysql, task_id, user_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(value: serde_json::Value) -> AttachmentMetadata {
        serde_json::from_value(value).expect("type_data decodes")
    }

    #[test]
    fn attachment_cover_url_prefers_video_metadata_then_the_top_level() {
        assert_eq!(
            metadata(serde_json::json!({
                "video_metadata": {"cover_url": "https://media.example.test/c.jpg"},
                "cover_url": "https://media.example.test/top.jpg",
            }))
            .attachment_cover_url()
            .as_deref(),
            Some("https://media.example.test/c.jpg")
        );
        assert_eq!(
            metadata(serde_json::json!({"cover_url": "https://a.example/c.jpg"}))
                .attachment_cover_url()
                .as_deref(),
            Some("https://a.example/c.jpg")
        );
        // Falsy values fall through exactly like `_attachment_cover_url`.
        for value in [
            serde_json::json!({"video_metadata": {"cover_url": ""}}),
            serde_json::json!({"video_metadata": {}}),
            serde_json::json!({}),
        ] {
            assert_eq!(metadata(value).attachment_cover_url(), None);
        }
    }

    #[test]
    fn stored_media_references_report_the_python_string_form() {
        // The stored media reference: the three persisted upload shapes, as
        // `str(media_id)`.
        assert_eq!(
            metadata(serde_json::json!({
                "weibo_video_upload": {"media_id": 1000000000000001_u64}
            }))
            .stored_media_reference(),
            Some(("video", "1000000000000001".to_string()))
        );
        assert_eq!(
            metadata(serde_json::json!({"weibo_audio_upload": {"media_id": "42"}}))
                .stored_media_reference(),
            Some(("audio", "42".to_string()))
        );
        assert_eq!(
            metadata(serde_json::json!({"video_metadata": {"media_id": 7}}))
                .stored_media_reference(),
            Some(("video", "7".to_string()))
        );
        // `upload.get("media_id")` truthiness, and the local-storage case.
        for value in [
            serde_json::json!({"weibo_video_upload": {"media_id": ""}}),
            serde_json::json!({"weibo_video_upload": {"media_id": 0}}),
            serde_json::json!({"weibo_video_upload": {"upload_id": "E"}}),
            serde_json::json!({"video_metadata": {"video_url": "http://a"}}),
            serde_json::json!({
                "mime_type": "text/markdown",
                "storage_backend": "minio",
                "storage_key": "attachments/c4dc99e190f2_20260924074255_1731_1344271"
            }),
        ] {
            assert_eq!(metadata(value).stored_media_reference(), None);
        }
        assert_eq!(AttachmentMetadata::default().stored_media_reference(), None);
    }

    #[test]
    fn legacy_weibo_fids_need_the_weibo_backend() {
        let legacy = metadata(serde_json::json!({
            "mime_type": "video/mp4",
            "file_extension": ".mp4",
            "storage_backend": "weibo",
            "fid": 1000000000000002_u64
        }));
        assert_eq!(
            legacy.legacy_weibo_fid(),
            Some("1000000000000002".to_string())
        );
        assert_eq!(legacy.stored_media_reference(), None);
        // The legacy playback resolver needs the `weibo` backend and a truthy id.
        assert_eq!(
            metadata(serde_json::json!({"fid": 1000000000000002_u64})).legacy_weibo_fid(),
            None
        );
        assert_eq!(
            metadata(serde_json::json!({"storage_backend": "weibo", "fid": 0})).legacy_weibo_fid(),
            None
        );
        assert_eq!(AttachmentMetadata::default().legacy_weibo_fid(), None);
    }

    /// `_check_task_access` issues `db.query(ResourceMember).filter(...).first()`:
    /// the full mapper projection and only the five source predicates. The
    /// replay matcher compares the normalized statement, so a narrowed
    /// projection or an extra `copied_resource_id` filter would diverge from
    /// the recorded source exchange.
    #[tokio::test]
    async fn membership_probe_renders_the_source_statement() {
        let capture = crate::sql_test_support::KindQueryCapture::default();
        let member = is_task_member(&capture, 327929343134391, 845)
            .await
            .expect("capture answers an empty result set");
        assert!(!member);
        let queries = capture.queries();
        assert_eq!(queries.len(), 1);
        let sql = &queries[0].sql;
        assert!(
            sql.starts_with("SELECT resource_members.id AS resource_members_id,"),
            "{sql}"
        );
        assert!(
            sql.contains(
                "resource_members.copied_resource_id AS resource_members_copied_resource_id"
            ),
            "the projection keeps the mapped column: {sql}"
        );
        assert_eq!(
            sql.split(" WHERE ").nth(1),
            Some(
                "resource_members.resource_type = 'Task' \
                 AND resource_members.resource_id = ? \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = ? \
                 AND resource_members.status = 'approved' \
                 LIMIT 1"
            ),
            "{sql}"
        );
        assert_eq!(queries[0].args, 2);
        assert_eq!(queries[0].first_integer, Some(327929343134391));
    }
}
