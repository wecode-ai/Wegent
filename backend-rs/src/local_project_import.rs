//! Import shared project content without importing private execution identities or credentials.
use std::collections::HashSet;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlRow, MysqlTransaction};
use serde_json::{Value, json};

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

mod model;
use model::{Import, datetime, hash, mapped_id};

#[derive(FromMysqlRow)]
struct Target {
    metadata: Option<Json<Value>>,
    created_by_user_id: i32,
}

#[derive(FromMysqlRow)]
struct Count {
    count: i64,
}

fn invalid(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message)
}

#[brz_http_server::post("/api/v1/cloud-projects/:project_id/import-local")]
#[tracing::instrument(skip_all, name = "collaboration.import_local_project")]
async fn import_local_project(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    project_id: &str,
    body: Import,
) -> Result<Value, FastApiError> {
    let number = project_id
        .parse::<i64>()
        .map_err(|_| invalid("Invalid project"))?;
    let access = crate::cloud_projects::authorized_project(&state.mysql, number, user.0.id)
        .await
        .map_err(|_| FastApiError::internal())?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Project not found"))?;
    if !matches!(access.1, "Owner" | "Maintainer") {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Project not found",
        ));
    }
    let files = body.validate().map_err(invalid)?;
    let digest = hash(serde_json::to_vec(&body).map_err(|_| invalid("Invalid import"))?);
    let prefix = format!("projects/{project_id}/local-import/{digest}");
    // Object keys include the content digest, so a failed or concurrent import never changes a committed object.
    for (file, bytes) in body.attachments.iter().zip(&files) {
        let key = format!("{prefix}/{}", mapped_id(project_id, "attachment", &file.id));
        crate::delivery_storage::write_object(&state.attachment_http, &key, bytes)
            .await
            .map_err(|_| {
                FastApiError::detail(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Attachment storage unavailable; source project is unchanged",
                )
            })?;
    }
    let imported = state.mysql.with_transaction(async |tx| {
        let target: Option<Target> = tx.fetch_optional("SELECT metadata, created_by_user_id FROM loop_items WHERE id=? AND resource_type='project' AND status='active' FOR UPDATE", (project_id,)).await?;
        let Some(target) = target else { return Ok(false); };
        let access: Option<MysqlRow> = tx.fetch_optional(crate::cloud_projects::project_access_statement(user.0.id, Some(number), None), ()).await?;
        let priority: Option<i64> = access.as_ref().map(|row| row.get_required("anon_1_priority")).transpose()?;
        if priority.is_none_or(|priority| priority > 1) { return Ok(false); }
        let mut metadata = target.metadata.map(|value| value.0).unwrap_or_else(|| json!({}));
        if !metadata.is_object() { return Ok(false); }
        if let Some(previous) = metadata.get("local_project_import") {
            return Ok(previous["source"] == body.source && previous["sha256"] == digest && previous["actor"] == user.0.id);
        }
        let count: Option<Count> = tx.fetch_optional("SELECT COUNT(*) AS count FROM loop_items WHERE cloud_project_id=? AND resource_type='task'", (project_id,)).await?;
        if count.is_none_or(|row| row.count != 0) || target.created_by_user_id != user.0.id { return Ok(false); }
        let required = crate::loop_node_storage::required_columns(tx).await?;
        insert_milestones(tx,&required,project_id,user.0.id,&body).await?;
        insert_issues(tx, &required, project_id, user.0.id, &body).await?;
        insert_comments(tx, project_id, user.0.id, &body).await?;
        insert_files(tx, &required, project_id, user.0.id, &body, &prefix, &files).await?;
        for key in ["tags", "board_config", "board_views", "card_display", "default_issue_security"] {
            if let Some(value) = body.settings.get(key) { metadata[key] = value.clone(); }
        }
        metadata["local_project_import"] = json!({"source":body.source,"sha256":digest,"actor":user.0.id,"complete":true});
        let next_number = body.issues.iter().map(|issue| issue.sequence_number).max().unwrap_or(0) + 1;
        tx.execute("UPDATE loop_items SET name=?,description=?,metadata=?,next_item_number=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?", (body.name.as_str(), body.description.as_str(), Json(metadata), next_number, project_id)).await?;
        Ok(true)
    }).await.map_err(|_| FastApiError::internal())?;
    if !imported {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Import target changed or belongs to another source; original local content is unchanged",
        ));
    }
    Ok(
        json!({"project_id":project_id,"source":body.source,"sha256":digest,"issues":body.issues.len(),"comments":body.comments.len(),"attachments":body.attachments.len()}),
    )
}

async fn insert_issues<T: MysqlTransaction>(
    tx: &mut T,
    required: &HashSet<String>,
    project: &str,
    user: i32,
    body: &Import,
) -> brz_mysql::MysqlResult<()> {
    let sql = crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "cloud_project_id",
            "title",
            "description",
            "status",
            "priority",
            "sequence_number",
            "created_by_user_id",
            "assignee_user_id",
            "metadata",
            "version",
            "sort_order",
            "next_item_number",
            "created_at",
            "updated_at",
        ],
        &[
            "?", "'task'", "?", "?", "?", "?", "?", "?", "?", "?", "?", "1", "?", "1", "?", "?",
        ],
        required,
    );
    for issue in &body.issues {
        let id = mapped_id(project, "issue", &issue.id);
        let metadata = json!({"tags":issue.tags,"security_level":issue.security_level,"migration_source_id":issue.id,"archived_at":issue.archived_at,"source_assignee_id":issue.assignee_user_id,"milestone_id":issue.milestone_id.as_ref().map(|id|mapped_id(project,"milestone",id))});
        tx.execute(
            sql.clone(),
            (
                id.as_str(),
                project,
                issue.title.as_str(),
                body.rewrite(project, &issue.description),
                issue.status.as_str(),
                issue.priority.as_str(),
                issue.sequence_number,
                user,
                issue
                    .assignee_user_id
                    .filter(|id| *id == 0 || *id == body.local_user_id)
                    .map(|_| user),
                Json(metadata),
                issue.sort_order,
                datetime(&issue.created_at).unwrap(),
                datetime(&issue.updated_at).unwrap(),
            ),
        )
        .await?;
    }
    // Parents are linked after every Issue exists, including arbitrary source ordering.
    for issue in &body.issues {
        let parent = issue
            .parent_id
            .as_ref()
            .map(|id| mapped_id(project, "issue", id));
        tx.execute(
            "UPDATE loop_items SET parent_id=?,start_at=?,due_at=? WHERE id=?",
            (
                parent,
                issue.start_at.as_deref().and_then(|v| datetime(v).ok()),
                issue.due_at.as_deref().and_then(|v| datetime(v).ok()),
                mapped_id(project, "issue", &issue.id),
            ),
        )
        .await?;
    }
    Ok(())
}

async fn insert_comments<T: MysqlTransaction>(
    tx: &mut T,
    project: &str,
    user: i32,
    body: &Import,
) -> brz_mysql::MysqlResult<()> {
    for comment in &body.comments {
        let id = mapped_id(project, "comment", &comment.id);
        let reply = comment
            .reply_to_id
            .as_ref()
            .filter(|id| {
                body.comments
                    .iter()
                    .any(|source| source.id == **id && source.issue_id == comment.issue_id)
            })
            .map(|id| mapped_id(project, "comment", id))
            .unwrap_or_default();
        let root = comment
            .root_id
            .as_ref()
            .map(|id| mapped_id(project, "comment", id))
            .unwrap_or_else(|| id.clone());
        // Imported author labels are provenance, never execution identities or new user grants.
        tx.execute("INSERT INTO project_chat_messages (message_id,client_message_id,project_id,task_id,sender_type,sender_id,sender_name,message_type,content,metadata,trigger_message_id,reply_to_message_id,thread_root_message_id,agent_id,runtime_device_id,runtime_task_id,runtime_activity_key,status,created_at,updated_at,deleted_at) VALUES (?, ?, ?, ?, 'system', ?, ?, 'text', ?, ?, '', ?, ?, '', '', '', ?, 'completed', ?, ?, '1970-01-01 00:00:00')", (id.as_str(),id.as_str(),project,mapped_id(project,"issue",&comment.issue_id),user.to_string(),comment.author.as_str(),body.rewrite(project,&comment.body),Json(json!({"migration_source_id":comment.id,"imported_by":user})),reply,root,id.as_str(),datetime(&comment.created_at).unwrap(),datetime(&comment.updated_at).unwrap())).await?;
    }
    Ok(())
}

async fn insert_files<T: MysqlTransaction>(
    tx: &mut T,
    required: &HashSet<String>,
    project: &str,
    user: i32,
    body: &Import,
    prefix: &str,
    bytes: &[Vec<u8>],
) -> brz_mysql::MysqlResult<()> {
    let sql = crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "cloud_project_id",
            "loop_item_id",
            "display_name",
            "content_type",
            "size_bytes",
            "sha256",
            "object_key",
            "created_by_user_id",
            "description",
            "metadata",
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
            "?",
            "?",
            "?",
            "?",
            "?",
            "''",
            "'{}'",
            "1",
            "0",
            "1",
            "?",
            "?",
        ],
        required,
    );
    for (file, content) in body.attachments.iter().zip(bytes) {
        let id = mapped_id(project, "attachment", &file.id);
        tx.execute(
            sql.clone(),
            (
                id.as_str(),
                project,
                mapped_id(project, "issue", &file.issue_id),
                file.display_name.as_str(),
                file.content_type.as_str(),
                content.len() as i64,
                file.sha256.as_str(),
                format!("{prefix}/{id}"),
                user,
                datetime(&file.created_at).unwrap(),
                datetime(&file.created_at).unwrap(),
            ),
        )
        .await?;
    }
    Ok(())
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/import-local")]
async fn import_status(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    project_id: &str,
) -> Result<Value, FastApiError> {
    let number = project_id
        .parse::<i64>()
        .map_err(|_| invalid("Invalid project"))?;
    let access = crate::cloud_projects::authorized_project(&state.mysql, number, user.0.id)
        .await
        .map_err(|_| FastApiError::internal())?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Project not found"))?;
    if !matches!(access.1, "Owner" | "Maintainer") {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Project not found",
        ));
    }
    let row:Option<Target>=state.mysql.fetch_optional("SELECT metadata,created_by_user_id FROM loop_items WHERE id=? AND resource_type='project' AND status='active'",(project_id,)).await.map_err(|_|FastApiError::internal())?;
    let marker = row
        .and_then(|row| row.metadata)
        .map(|json| json.0["local_project_import"].clone())
        .filter(|value| value["actor"] == user.0.id && value["complete"] == true)
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Import not found"))?;
    Ok(json!({"source":marker["source"],"sha256":marker["sha256"],"complete":true}))
}

async fn insert_milestones<T: MysqlTransaction>(
    tx: &mut T,
    required: &HashSet<String>,
    project: &str,
    user: i32,
    body: &Import,
) -> brz_mysql::MysqlResult<()> {
    let sql = crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "cloud_project_id",
            "title",
            "description",
            "status",
            "created_by_user_id",
            "metadata",
            "version",
            "sort_order",
            "next_item_number",
            "created_at",
            "updated_at",
        ],
        &[
            "?",
            "'milestone'",
            "?",
            "?",
            "?",
            "?",
            "?",
            "?",
            "1",
            "0",
            "1",
            "UTC_TIMESTAMP(6)",
            "UTC_TIMESTAMP(6)",
        ],
        required,
    );
    for milestone in &body.milestones {
        tx.execute(
            sql.clone(),
            (
                mapped_id(project, "milestone", &milestone.id),
                project,
                milestone.title.as_str(),
                milestone.description.as_str(),
                milestone.state.as_str(),
                user,
                Json(json!({"due_on":milestone.due_on,"migration_source_id":milestone.id})),
            ),
        )
        .await?;
    }
    Ok(())
}
