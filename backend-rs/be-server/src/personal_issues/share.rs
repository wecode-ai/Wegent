//! Share selected deliverables while retaining an account-private conversation reference.
use super::*;
use crate::attachments::upload::max_file_size;
use brz_http_server::{Multipart, Redirect};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const LIVE_ITEM: &str = "item.resource_type='task' AND (item.deleted_at IS NULL OR item.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))";
const SOURCE_TYPE: &str = "issue_share_source";
// Bound storage operations per request as well as aggregate payload size.
const MAX_SHARED_ATTACHMENTS: usize = 100;
pub(super) use crate::background_jobs::project::notifications::uuid as random_id;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SourceTask {
    device_id: String,
    task_id: String,
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct SharedAttachment {
    id: String,
    filename: String,
    size: usize,
    object_key: String,
    sha256: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    issue_attachment: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Share {
    #[serde(default)]
    pub(super) files: Vec<SharedAttachment>,
}

pub(super) struct NewShare {
    pub(super) source: SourceTask,
    pub(super) files: Vec<SharedAttachment>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    request_id: String,
    source: SourceTask,
    issue: Input,
    project_id: Option<String>,
    project_status: Option<String>,
}

#[derive(Debug, Serialize, FromMysqlRow)]
struct SharedIssueTarget {
    id: String,
    title: String,
    project_id: Option<String>,
    restricted: bool,
}

const TARGET_SELECT: &str = "SELECT item.id, COALESCE(item.title,'') AS title, NULLIF(item.cloud_project_id,'') AS project_id, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(item.metadata,'$.security_level')) = 'related',false) AS restricted FROM loop_items source JOIN loop_items item ON item.id=source.loop_item_id";

#[brz_http_server::post("/api/v1/personal-issues/share")]
async fn create_shared_issue(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    multipart: Multipart,
) -> Result<SharedIssueTarget, FastApiError> {
    let request: Request = multipart
        .get("metadata")
        .and_then(|field| serde_json::from_slice(&field.bytes).ok())
        .ok_or_else(|| invalid("Invalid share metadata"))?;
    let id = share_id(user.0.id, &request.request_id)?;
    if let Some(target) = share_target(state, user.0.id, &id).await? {
        return Ok(target);
    }
    if !valid_source(&request.source) {
        return Err(invalid("Invalid conversation reference"));
    }
    request.issue.validate()?;
    if !assignee_is_invited(&request.issue, user.0.id) {
        return Err(invalid("Invite the assignee before assigning"));
    }
    let project = request.project_id.map(|project_id| ProjectInput {
        project_id,
        status: request.project_status,
        version: 1,
    });
    if let Some(target) = &project {
        crate::cloud_projects::parse_project_id(&target.project_id)?;
    }
    let files = stage_files(state, &multipart).await?;
    let share = NewShare {
        source: request.source,
        files,
    };
    let result = create_issue_record(
        state,
        user.0.id,
        request.issue,
        &id,
        project.as_ref(),
        Some(&share),
    )
    .await;
    if let Err(error) = result {
        // The transaction may have committed despite a lost response. Only
        // reclaim this attempt's objects after confirming they aren't attached.
        let stored: Vec<StoredFile> = fetch_object_keys(state, &id).await.inspect_err(|_| {
            tracing::warn!(issue_id=%id, attachment_ids=?share.files.iter().map(|file| &file.id).collect::<Vec<_>>(), "Share staging retained after an uncertain commit");
        })?;
        let unattached: Vec<_> = share
            .files
            .into_iter()
            .filter(|file| !stored.iter().any(|row| row.object_key == file.object_key))
            .collect();
        delete_files(state, &unattached).await;
        return share_target(state, user.0.id, &id).await?.ok_or(error);
    }
    share_target(state, user.0.id, &id)
        .await?
        .ok_or_else(missing)
}

#[derive(FromMysqlRow)]
struct StoredFile {
    object_key: String,
}

async fn fetch_object_keys(state: &AppState, id: &str) -> Result<Vec<StoredFile>, FastApiError> {
    state
        .mysql
        .fetch_all(
            "SELECT object_key FROM loop_items WHERE loop_item_id=? AND resource_type='attachment'",
            (id,),
        )
        .await
        .map_err(internal)
}

pub(super) fn association_error(reason: Admission) -> brz_mysql::MysqlError {
    let reason = match reason {
        Admission::Missing => "share_project_missing",
        Admission::InvalidRecipients => "share_project_recipients",
        _ => "share_project_invalid",
    };
    brz_mysql::MysqlError::InvalidQuery {
        reason: reason.into(),
    }
}

pub(super) fn creation_error(error: brz_mysql::MysqlError) -> FastApiError {
    match error {
        brz_mysql::MysqlError::InvalidQuery { reason } if reason == "share_project_missing" => {
            wegent_project_coordination::cloud_projects::cloud_project_not_found()
        }
        brz_mysql::MysqlError::InvalidQuery { reason } if reason == "share_project_invalid" => {
            invalid("Invalid target project or status")
        }
        brz_mysql::MysqlError::InvalidQuery { reason } if reason == "share_project_recipients" => {
            invalid("Some colleagues cannot access issues in this project")
        }
        other => internal(other),
    }
}

async fn share_target(
    state: &AppState,
    user: i32,
    id: &str,
) -> Result<Option<SharedIssueTarget>, FastApiError> {
    state.mysql.fetch_optional(
        format!("{TARGET_SELECT} WHERE source.resource_type='{SOURCE_TYPE}' AND source.created_by_user_id=? AND item.id=? AND {LIVE_ITEM}"),
        (user, id),
    ).await.map_err(internal)
}

#[derive(Deserialize)]
struct SourceQuery {
    device_id: String,
    task_id: String,
}

#[brz_http_server::get("/api/v1/personal-issues/shared-from")]
async fn shared_from(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: Query<SourceQuery>,
) -> Result<Vec<SharedIssueTarget>, FastApiError> {
    state.mysql.fetch_all(
        format!("{TARGET_SELECT} WHERE source.resource_type='{SOURCE_TYPE}' AND source.created_by_user_id=? AND source.device_id=? AND source.task_id=? AND {LIVE_ITEM} ORDER BY item.created_at DESC LIMIT 30"),
        (user.0.id, query.0.device_id, query.0.task_id),
    ).await.map_err(internal)
}

#[brz_http_server::get("/api/v1/personal-issues/:issue_id/source")]
async fn shared_source(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
) -> Result<SourceTask, FastApiError> {
    #[derive(FromMysqlRow)]
    struct SourceRow {
        device_id: String,
        task_id: String,
        task_title: String,
    }
    let row: SourceRow = state.mysql.fetch_optional(
        format!("SELECT source.device_id,source.task_id,source.task_title FROM loop_items source JOIN loop_items item ON item.id=source.loop_item_id WHERE source.resource_type='{SOURCE_TYPE}' AND source.created_by_user_id=? AND item.id=? AND {LIVE_ITEM}"),
        (user.0.id, issue_id),
    ).await.map_err(internal)?.ok_or_else(missing)?;
    Ok(SourceTask {
        device_id: row.device_id,
        task_id: row.task_id,
        title: row.task_title,
    })
}

pub(super) async fn insert_source(
    tx: &mut impl MysqlTransaction,
    required: &HashSet<String>,
    issue_id: &str,
    user: i32,
    source: &SourceTask,
) -> brz_mysql::MysqlResult<()> {
    let sql = crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "loop_item_id",
            "created_by_user_id",
            "device_id",
            "task_id",
            "task_title",
            "description",
            "version",
            "sort_order",
            "next_item_number",
            "created_at",
            "updated_at",
        ],
        &[
            "?",
            "?",
            "?",
            "?",
            "?",
            "?",
            "?",
            "''",
            "1",
            "0",
            "1",
            "UTC_TIMESTAMP(6)",
            "UTC_TIMESTAMP(6)",
        ],
        required,
    );
    tx.execute(
        sql,
        (
            random_id(),
            SOURCE_TYPE,
            issue_id,
            user,
            source.device_id.as_str(),
            source.task_id.as_str(),
            source.title.as_str(),
        ),
    )
    .await?;
    Ok(())
}

pub(super) async fn insert_attachment_records(
    tx: &mut impl MysqlTransaction,
    required: &HashSet<String>,
    issue_id: &str,
    user: i32,
    files: &[SharedAttachment],
) -> brz_mysql::MysqlResult<()> {
    if files.is_empty() {
        return Ok(());
    }
    let sql = crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "loop_item_id",
            "display_name",
            "object_key",
            "content_type",
            "size_bytes",
            "sha256",
            "created_by_user_id",
            "description",
            "version",
            "sort_order",
            "next_item_number",
            "created_at",
            "updated_at",
        ],
        &[
            "?",
            "'attachment'",
            "?",
            "?",
            "?",
            "'application/octet-stream'",
            "?",
            "?",
            "?",
            "''",
            "1",
            "0",
            "1",
            "UTC_TIMESTAMP(6)",
            "UTC_TIMESTAMP(6)",
        ],
        required,
    );
    for file in files {
        tx.execute(
            sql.as_str(),
            (
                file.id.as_str(),
                issue_id,
                file.filename.as_str(),
                file.object_key.as_str(),
                file.size as u64,
                file.sha256.as_str(),
                user,
            ),
        )
        .await?;
    }
    Ok(())
}

pub(super) const METADATA_WITH_FILES: &str = "
    CAST(CASE WHEN JSON_TYPE(JSON_EXTRACT(loop_items.metadata,'$.share'))='OBJECT'
    THEN JSON_SET(loop_items.metadata,'$.share.files',COALESCE((
        SELECT JSON_ARRAYAGG(JSON_OBJECT(
            'id',attachment.id,'filename',attachment.display_name,'size',attachment.size_bytes,
            'object_key',attachment.object_key,'sha256',attachment.sha256,
            'issue_attachment',CAST('true' AS JSON)
        )) OVER (ORDER BY attachment.created_at,attachment.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
        FROM loop_items attachment
        WHERE attachment.loop_item_id=loop_items.id AND attachment.resource_type='attachment'
          AND attachment.object_key LIKE 'issue-share/%'
        LIMIT 1
    ),JSON_ARRAY())) ELSE loop_items.metadata END AS JSON)";

fn share_id(user_id: i32, request_id: &str) -> Result<String, FastApiError> {
    let hex = request_id.replace('-', "");
    if hex.len() != 32 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("Invalid share request ID"));
    }
    Ok(format!("share-{user_id}-{}", hex.to_ascii_lowercase()))
}

fn valid_source(source: &SourceTask) -> bool {
    [(&source.device_id, 100), (&source.task_id, 255)]
        .into_iter()
        .all(|(id, limit)| {
            !id.is_empty() && id.chars().count() <= limit && !id.chars().any(char::is_control)
        })
        && source.title.chars().count() <= 255
}

async fn stage_files(
    state: &AppState,
    multipart: &Multipart,
) -> Result<Vec<SharedAttachment>, FastApiError> {
    let files: Vec<_> = multipart
        .get_all("file")
        .take(MAX_SHARED_ATTACHMENTS + 1)
        .collect();
    validate_attachment_limits(files.len(), files.iter().map(|file| file.bytes.len()).sum())?;
    let mut staged = Vec::new();
    for file in files {
        let filename = file.filename.as_deref().filter(|name| {
            !name.is_empty() && name.chars().count() <= 255 && !name.chars().any(char::is_control)
        });
        let Some(filename) = filename else {
            delete_files(state, &staged).await;
            return Err(invalid("Invalid attachment filename"));
        };
        let id = random_id();
        let object_key = format!("issue-share/{id}");
        staged.push(SharedAttachment {
            id,
            filename: filename.into(),
            size: file.bytes.len(),
            sha256: format!("{:x}", Sha256::digest(&file.bytes)),
            object_key: object_key.clone(),
            issue_attachment: false,
        });
        if crate::delivery_storage::write_object(&state.attachment_http, &object_key, &file.bytes)
            .await
            .is_err()
        {
            delete_files(state, &staged).await;
            return Err(FastApiError::internal());
        }
    }
    Ok(staged)
}

fn validate_attachment_limits(count: usize, total_bytes: usize) -> Result<(), FastApiError> {
    if count > MAX_SHARED_ATTACHMENTS {
        return Err(invalid(
            "A shared Issue can include at most 100 attachments",
        ));
    }
    if total_bytes > max_file_size() as usize {
        return Err(invalid("Shared attachments exceed the upload limit"));
    }
    Ok(())
}

async fn delete_files(state: &AppState, files: &[SharedAttachment]) -> bool {
    let mut complete = true;
    for file in files {
        if crate::delivery_storage::delete_object(&state.attachment_http, &file.object_key)
            .await
            .is_err()
        {
            complete = false;
            tracing::warn!(attachment_id=%file.id, "Share attachment storage cleanup failed");
        }
    }
    complete
}

pub(super) async fn clean_deleted_share(
    state: &AppState,
    id: &str,
) -> brz_mysql::MysqlResult<bool> {
    let mut complete = true;
    let attachments: Vec<(String, String)> = state.mysql.fetch_all(
        "SELECT id,object_key FROM loop_items WHERE resource_type='attachment' AND loop_item_id=?",
        (id,),
    ).await?;
    for (attachment_id, key) in attachments {
        if crate::delivery_storage::delete_object(&state.attachment_http, &key)
            .await
            .is_err()
        {
            complete = false;
            tracing::warn!(%attachment_id, "Issue attachment storage cleanup failed");
            continue;
        }
        state.mysql.execute(
            "DELETE FROM loop_items WHERE id=? AND resource_type='attachment' AND loop_item_id=?",
            (attachment_id.as_str(), id),
        ).await?;
    }
    // The committed tombstone retains the keys until storage confirms deletion.
    let metadata = if complete {
        "JSON_REMOVE(metadata,'$.share')"
    } else {
        "metadata"
    };
    state.mysql.execute(
        format!("UPDATE loop_items SET metadata={metadata},updated_at={DATABASE_NOW_SQL} WHERE id=? AND deleted_at>'1970-01-01 00:00:01'"),
        (id,),
    ).await?;
    Ok(complete)
}

pub(crate) async fn retry_deleted_shares(state: &AppState) -> anyhow::Result<Value> {
    let rows: Vec<(String,)> = state.mysql.fetch_all(
        "SELECT issue.id FROM loop_items issue WHERE issue.resource_type='task' AND (issue.cloud_project_id IS NULL OR issue.cloud_project_id='') AND issue.deleted_at>'1970-01-01 00:00:01' AND EXISTS (SELECT 1 FROM loop_items attachment WHERE attachment.resource_type='attachment' AND attachment.loop_item_id=issue.id) ORDER BY issue.updated_at,issue.id LIMIT 32",
        (),
    ).await?;
    let mut completed = 0;
    let mut pending = 0;
    for (id,) in rows {
        if clean_deleted_share(state, &id).await? {
            completed += 1;
        } else {
            pending += 1;
        }
    }
    Ok(json!({"completed":completed,"pending":pending}))
}

#[brz_http_server::get("/api/v1/personal-issues/:issue_id/attachments/:attachment_id")]
pub(super) async fn redirect_shared_attachment(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    attachment_id: &str,
) -> Result<Redirect, FastApiError> {
    let scope = crate::loop_tasks::item_access::IssueReadScope::load(&state.mysql, issue_id)
        .await
        .map_err(internal)?
        .filter(|scope| scope.project_id.is_none())
        .ok_or_else(missing)?;
    scope.require(&state.mysql, issue_id, user.0.id).await?;
    let attachment: Option<(String,)> = state
        .mysql
        .fetch_optional(
            "SELECT attachment.id FROM loop_items attachment
             JOIN loop_items issue ON issue.id=attachment.loop_item_id
             WHERE attachment.id=? AND attachment.resource_type='attachment'
               AND attachment.loop_item_id=? AND attachment.object_key LIKE 'issue-share/%'
               AND JSON_TYPE(JSON_EXTRACT(issue.metadata,'$.share'))='OBJECT'",
            (attachment_id, issue_id),
        )
        .await
        .map_err(internal)?;
    let (id,) = attachment.ok_or_else(missing)?;
    Ok(Redirect::temporary(shared_attachment_location(&id)))
}

fn shared_attachment_location(id: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
    format!(
        "/api/v1/loop-item-attachments/{}/content",
        encoded.replace('+', "%20")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_request_ids_are_scoped_by_account() {
        let request = "60029fa1-2f7f-4429-bb06-65f839fa196e";
        assert_ne!(share_id(3, request).unwrap(), share_id(4, request).unwrap());
        assert!(share_id(3, "../../issue").is_err());
    }

    #[test]
    fn sharing_limits_storage_operations_even_for_empty_attachments() {
        let max_bytes = max_file_size() as usize;
        assert!(validate_attachment_limits(MAX_SHARED_ATTACHMENTS, max_bytes).is_ok());
        assert!(validate_attachment_limits(MAX_SHARED_ATTACHMENTS + 1, 0).is_err());
        assert!(validate_attachment_limits(1, max_bytes + 1).is_err());
    }

    #[test]
    fn attachment_redirect_keeps_the_id_in_one_path_segment() {
        assert_eq!(
            shared_attachment_location("file #1/?"),
            "/api/v1/loop-item-attachments/file%20%231%2F%3F/content"
        );
    }
}
