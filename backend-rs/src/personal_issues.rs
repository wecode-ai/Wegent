//! First-class Issues with no project or space. Authority is owner or explicit invitation.
use brz_http_server::{Query, StatusCode};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

mod participants;
use participants::{ResourceInvitation, ResourceParticipant};

const SELECT: &str = "SELECT id,COALESCE(title,'') AS title,description,status,priority,created_by_user_id AS creator_id,NULLIF(assignee_user_id,0) AS assignee_id,version,metadata,CAST(created_at AS CHAR) AS created_at,CAST(updated_at AS CHAR) AS updated_at,(SELECT COALESCE(JSON_OBJECTAGG(CAST(u.id AS CHAR),u.user_name),JSON_OBJECT()) FROM users u WHERE u.id=loop_items.created_by_user_id OR JSON_CONTAINS(loop_items.metadata,CAST(u.id AS JSON),'$.participants')) AS people FROM loop_items";
const LIVE: &str = "resource_type='task' AND (cloud_project_id IS NULL OR cloud_project_id='') AND JSON_EXTRACT(metadata,'$.standalone')=true AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Metadata {
    standalone: bool,
    participants: Vec<i32>,
    direct_participants: Option<Vec<i32>>,
    assignee_resource: Option<ResourceInvitation>,
    resource_participants: Vec<ResourceParticipant>,
    archived: bool,
    due_at: Option<String>,
    assigned_at: Option<String>,
}

#[derive(Debug, Serialize, FromMysqlRow)]
struct Issue {
    id: String,
    title: String,
    description: String,
    status: String,
    priority: String,
    creator_id: i32,
    assignee_id: Option<i32>,
    version: i64,
    #[serde(serialize_with = "serialize_metadata")]
    metadata: Json<Metadata>,
    #[serde(serialize_with = "serialize_json")]
    people: Json<std::collections::HashMap<String, String>>,
    created_at: String,
    updated_at: String,
}

fn serialize_metadata<S: serde::Serializer>(
    value: &Json<Metadata>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut public = serde_json::to_value(&value.0).map_err(serde::ser::Error::custom)?;
    if let Some(resources) = public["resource_participants"].as_array_mut() {
        for resource in resources {
            if let Some(resource) = resource.as_object_mut() {
                resource.remove("instructions");
                resource.remove("group_snapshot");
            }
        }
    }
    public.serialize(serializer)
}

fn serialize_json<T: Serialize, S: serde::Serializer>(
    value: &Json<T>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value.0.serialize(serializer)
}

impl Issue {
    fn can_read(&self, user: i32) -> bool {
        self.creator_id == user || self.metadata.0.participants.contains(&user)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default = "pending")]
    status: String,
    #[serde(default = "medium")]
    priority: String,
    assignee_id: Option<i32>,
    #[serde(default)]
    participants: Vec<i32>,
    #[serde(default)]
    resource_participants: Vec<ResourceInvitation>,
    assignee_resource: Option<ResourceInvitation>,
    #[serde(default)]
    archived: bool,
    due_at: Option<String>,
    version: Option<i64>,
}

fn pending() -> String {
    "pending".into()
}
fn medium() -> String {
    "medium".into()
}
fn invalid(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message)
}
fn missing() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Issue not found")
}
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "personal Issue storage failed");
    FastApiError::internal()
}

impl Input {
    fn validate(&self) -> Result<(), FastApiError> {
        if self.title.trim().is_empty()
            || self.title.chars().count() > 255
            || !matches!(
                self.status.as_str(),
                "pending" | "in_progress" | "completed"
            )
            || !matches!(self.priority.as_str(), "low" | "medium" | "high" | "urgent")
            || self.participants.iter().any(|id| *id <= 0)
            || self
                .resource_participants
                .iter()
                .any(|r| r.id <= 0 || !matches!(r.kind.as_str(), "agent" | "group"))
            || self.assignee_id.is_some_and(|id| id <= 0)
            || self
                .due_at
                .as_ref()
                .is_some_and(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err())
        {
            return Err(invalid("Invalid Issue fields"));
        }
        if self
            .assignee_resource
            .as_ref()
            .is_some_and(|r| !self.resource_participants.contains(r))
            || (self.assignee_resource.is_some() && self.assignee_id.is_some())
        {
            return Err(invalid("Invite the resource before assigning"));
        }
        Ok(())
    }

    fn metadata(&self) -> Metadata {
        let mut participants = self.participants.clone();
        participants.sort_unstable();
        participants.dedup();
        Metadata {
            standalone: true,
            direct_participants: Some(participants.clone()),
            resource_participants: Vec::new(),
            assignee_resource: self.assignee_resource.clone(),
            participants,
            archived: self.archived,
            due_at: self.due_at.clone(),
            assigned_at: None,
        }
    }
}

fn identifier() -> Result<String, FastApiError> {
    crate::wework_auth_tokens::uuid4_hex()
        .map(|random| {
            format!(
                "issue-{:020}-{random}",
                chrono::Utc::now().timestamp_micros()
            )
        })
        .map_err(|_| FastApiError::internal())
}

async fn read<M: Mysql>(mysql: &M, id: &str, user: i32) -> Result<Issue, FastApiError> {
    let row: Option<Issue> = mysql
        .fetch_optional(format!("{SELECT} WHERE id=? AND {LIVE}"), (id,))
        .await
        .map_err(internal)?;
    row.filter(|row| row.can_read(user)).ok_or_else(missing)
}

async fn locked<T: MysqlTransaction>(
    tx: &mut T,
    id: &str,
) -> brz_mysql::MysqlResult<Option<Issue>> {
    tx.fetch_optional(format!("{SELECT} WHERE id=? AND {LIVE} FOR UPDATE"), (id,))
        .await
}

mod paging;
#[cfg(test)]
use paging::{ListQuery, list_issues};

#[brz_http_server::get("/api/v1/personal-issues/:issue_id")]
async fn get_issue(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
) -> Result<Issue, FastApiError> {
    read(&state.mysql, issue_id, user.0.id).await
}

#[derive(FromMysqlRow)]
struct UserId {
    id: i32,
}

async fn valid_people<T: MysqlTransaction>(
    tx: &mut T,
    people: &[i32],
) -> brz_mysql::MysqlResult<bool> {
    for user in people {
        let row: Option<UserId> = tx
            .fetch_optional(
                "SELECT id FROM users WHERE id=? AND is_active=true",
                (*user,),
            )
            .await?;
        if row.is_none_or(|row| row.id != *user) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn assignee_is_invited(input: &Input, owner: i32) -> bool {
    input
        .assignee_id
        .is_none_or(|assignee| assignee == owner || input.participants.contains(&assignee))
}

fn insert_sql(required: &std::collections::HashSet<String>) -> String {
    crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "project_space",
            "title",
            "description",
            "status",
            "priority",
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
            "?",
            "'task'",
            "'default'",
            "?",
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
    )
}

#[brz_http_server::post("/api/v1/personal-issues")]
async fn create_issue(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: Input,
) -> Result<Issue, FastApiError> {
    body.validate()?;
    if !assignee_is_invited(&body, user.0.id) {
        return Err(invalid("Invite the assignee before assigning"));
    }
    let id = identifier()?;
    let mut metadata = body.metadata();
    metadata.assigned_at = body.assignee_id.map(|_| {
        chrono::Utc::now()
            .naive_utc()
            .format("%Y-%m-%d %H:%M:%S%.6f")
            .to_string()
    });
    let created = state
        .mysql
        .with_transaction(async |tx| {
            if !valid_people(tx, &body.participants).await? {
                return Ok(false);
            }
            let Some(resources) =
                participants::resolve(tx, user.0.id, &body.resource_participants).await?
            else {
                return Ok(false);
            };
            metadata.resource_participants = resources;
            for resource in &metadata.resource_participants {
                metadata.participants.extend(&resource.human_ids);
            }
            metadata.participants.sort_unstable();
            metadata.participants.dedup();
            if !valid_people(tx, &metadata.participants).await? {
                return Ok(false);
            }
            let required = crate::loop_node_storage::required_columns(tx).await?;
            tx.execute(
                insert_sql(&required),
                (
                    id.as_str(),
                    body.title.trim(),
                    body.description.as_str(),
                    body.status.as_str(),
                    body.priority.as_str(),
                    user.0.id,
                    body.assignee_id,
                    Json(metadata.clone()),
                ),
            )
            .await?;
            Ok(true)
        })
        .await
        .map_err(internal)?;
    if !created {
        return Err(invalid("Invalid participant"));
    }
    read(&state.mysql, &id, user.0.id).await
}

#[derive(Debug, PartialEq)]
enum Admission {
    Allowed,
    Missing,
    Conflict,
    OwnerRequired,
    InvalidPeople,
    InvalidTarget,
}

fn admission(row: &Issue, user: i32, body: &Input) -> Admission {
    if !row.can_read(user) {
        return Admission::Missing;
    }
    if body.version != Some(row.version) {
        return Admission::Conflict;
    }
    let mut previous = row
        .metadata
        .0
        .direct_participants
        .clone()
        .unwrap_or_else(|| row.metadata.0.participants.clone());
    previous.sort_unstable();
    previous.dedup();
    if user != row.creator_id
        && (previous != body.metadata().participants
            || participants::references(&row.metadata.0.resource_participants)
                != body.resource_participants)
    {
        return Admission::OwnerRequired;
    }
    if !assignee_is_invited(body, row.creator_id) {
        return Admission::InvalidPeople;
    }
    Admission::Allowed
}

fn admitted(result: Admission) -> Result<(), FastApiError> {
    match result {
        Admission::Allowed => Ok(()),
        Admission::Missing => Err(missing()),
        Admission::Conflict => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Issue changed; reload before saving",
        )),
        Admission::OwnerRequired => Err(FastApiError::forbidden(
            "Only the creator can manage invitations",
        )),
        Admission::InvalidTarget => Err(invalid(
            "Choose an internal project and a valid target status",
        )),
        Admission::InvalidPeople => Err(invalid("Invalid participant or assignee")),
    }
}

#[brz_http_server::patch("/api/v1/personal-issues/:issue_id")]
async fn update_issue(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    body: Input,
) -> Result<Issue, FastApiError> {
    body.validate()?;
    let result = state.mysql.with_transaction(async |tx| {
        let Some(row) = locked(tx, issue_id).await? else { return Ok(Admission::Missing); };
        let result = admission(&row, user.0.id, &body);
        if result != Admission::Allowed { return Ok(result); }
        let added: Vec<_> = body.participants.iter().copied().filter(|id| !row.metadata.0.participants.contains(id)).collect();
        if !valid_people(tx, &added).await? || (body.assignee_id != row.assignee_id && !valid_people(tx, &body.assignee_id.into_iter().collect::<Vec<_>>()).await?) { return Ok(Admission::InvalidPeople); }
        let mut metadata = body.metadata();
        metadata.resource_participants = if participants::references(&row.metadata.0.resource_participants) == body.resource_participants { row.metadata.0.resource_participants.clone() } else { let Some(resources) = participants::resolve(tx, user.0.id, &body.resource_participants).await? else { return Ok(Admission::InvalidPeople) }; resources };
        for resource in &metadata.resource_participants { metadata.participants.extend(&resource.human_ids); }
        metadata.participants.sort_unstable();
        metadata.participants.dedup();
        if !valid_people(tx, &metadata.participants).await? { return Ok(Admission::InvalidPeople); }
        metadata.assigned_at = if body.assignee_id == row.assignee_id { row.metadata.0.assigned_at } else { body.assignee_id.map(|_| chrono::Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S%.6f").to_string()) };
        tx.execute("UPDATE loop_items SET title=?,description=?,status=?,priority=?,assignee_user_id=?,metadata=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?", (body.title.trim(),body.description.as_str(),body.status.as_str(),body.priority.as_str(),body.assignee_id,Json(metadata),issue_id)).await?;
        Ok(Admission::Allowed)
    }).await.map_err(internal)?;
    admitted(result)?;
    read(&state.mysql, issue_id, user.0.id).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Version {
    version: i64,
}

#[brz_http_server::delete("/api/v1/personal-issues/:issue_id")]
async fn delete_issue(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    body: Version,
) -> Result<Value, FastApiError> {
    let result = state.mysql.with_transaction(async |tx| {
        let Some(row) = locked(tx, issue_id).await? else { return Ok(Admission::Missing); };
        if row.creator_id != user.0.id { return Ok(Admission::Missing); }
        if row.version != body.version { return Ok(Admission::Conflict); }
        tx.execute("UPDATE loop_items SET deleted_at=UTC_TIMESTAMP(6),updated_at=UTC_TIMESTAMP(6),version=version+1 WHERE id=?", (issue_id,)).await?;
        Ok(Admission::Allowed)
    }).await.map_err(internal)?;
    admitted(result)?;
    Ok(json!({"deleted":true}))
}

#[derive(Debug, Serialize, FromMysqlRow)]
struct Comment {
    id: String,
    author_id: i32,
    body: String,
    created_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommentInput {
    body: String,
}

#[brz_http_server::get("/api/v1/personal-issues/:issue_id/comments")]
async fn list_comments(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
) -> Result<Vec<Comment>, FastApiError> {
    let comments = state.mysql.with_transaction(async |tx| {
        let Some(row) = locked(tx, issue_id).await? else { return Ok(None); };
        if !row.can_read(user.0.id) { return Ok(None); }
        let comments: Vec<Comment> = tx.fetch_all("SELECT id,created_by_user_id AS author_id,description AS body,CAST(created_at AS CHAR) AS created_at FROM loop_items WHERE loop_item_id=? AND resource_type='comment' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) ORDER BY created_at,id", (issue_id,)).await?;
        Ok(Some(comments))
    }).await.map_err(internal)?;
    comments.ok_or_else(missing)
}

#[brz_http_server::post("/api/v1/personal-issues/:issue_id/comments")]
async fn comment(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    body: CommentInput,
) -> Result<Value, FastApiError> {
    if body.body.trim().is_empty() {
        return Err(invalid("Comment is empty"));
    }
    let id = identifier()?;
    let written = state
        .mysql
        .with_transaction(async |tx| {
            let Some(row) = locked(tx, issue_id).await? else {
                return Ok(false);
            };
            if !row.can_read(user.0.id) {
                return Ok(false);
            }
            let required = crate::loop_node_storage::required_columns(tx).await?;
            let sql = crate::loop_node_storage::insert_sql(
                &[
                    "id",
                    "resource_type",
                    "loop_item_id",
                    "user_id",
                    "created_by_user_id",
                    "updated_by_user_id",
                    "status",
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
                    "'comment'",
                    "?",
                    "?",
                    "?",
                    "?",
                    "'active'",
                    "?",
                    "'{}'",
                    "1",
                    "0",
                    "1",
                    "UTC_TIMESTAMP(6)",
                    "UTC_TIMESTAMP(6)",
                ],
                &required,
            );
            tx.execute(
                sql,
                (
                    id.as_str(),
                    issue_id,
                    user.0.id,
                    user.0.id,
                    user.0.id,
                    body.body.trim(),
                ),
            )
            .await?;
            tx.execute(
                "UPDATE loop_items SET updated_at=UTC_TIMESTAMP(6),version=version+1 WHERE id=?",
                (issue_id,),
            )
            .await?;
            Ok(true)
        })
        .await
        .map_err(internal)?;
    if !written {
        return Err(missing());
    }
    Ok(json!({"id":id}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectInput {
    project_id: String,
    version: i64,
    status: Option<String>,
}

#[derive(FromMysqlRow)]
struct TargetProject {
    next_item_number: Option<i32>,
    metadata: Json<Value>,
}

#[brz_http_server::post("/api/v1/personal-issues/:issue_id/project")]
async fn associate_project(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    body: ProjectInput,
) -> Result<Value, FastApiError> {
    let number = crate::cloud_projects::parse_project_id(&body.project_id)?;
    let collaborator_prefix =
        crate::wework_auth_tokens::uuid4_hex().map_err(|_| FastApiError::internal())?;
    let result = state.mysql.with_transaction(async |tx| {
        let Some(row) = locked(tx, issue_id).await? else { return Ok(Admission::Missing); };
        if row.creator_id != user.0.id { return Ok(Admission::Missing); }
        if row.version != body.version { return Ok(Admission::Conflict); }
        let project: Option<TargetProject> = tx.fetch_optional("SELECT next_item_number,COALESCE(metadata,JSON_OBJECT()) AS metadata FROM loop_items WHERE id=? AND resource_type='project' AND status='active' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE", (body.project_id.as_str(),)).await?;
        let Some(project) = project else { return Ok(Admission::Missing); };
        let permissions: Vec<brz_mysql::MysqlRow> = tx.fetch_all(crate::cloud_projects::project_access_statement(user.0.id,Some(number),None),()).await?;
        let can_edit = permissions.first().map(|row| row.get_required::<i64>("anon_1_priority")).transpose()?.is_some_and(|priority| priority<=2);
        if !can_edit { return Ok(Admission::Missing); }
        let provider = project.metadata.0.get("task_provider").and_then(Value::as_str).unwrap_or("backend");
        if !matches!(provider,"backend"|"local") { return Ok(Admission::InvalidTarget); }
        let requested_status = body.status.as_deref().unwrap_or(&row.status);
        let statuses = crate::cloud_projects::metadata_board_statuses(project.metadata.0.as_object().unwrap_or(&serde_json::Map::new()));
        if !statuses.is_empty() && !statuses.iter().any(|(id,_)| id == requested_status) { return Ok(Admission::InvalidTarget); }
        let target_status = if statuses.is_empty() { "" } else { requested_status };
        let sequence = project.next_item_number.unwrap_or(1);
        let assignee_team = row.metadata.0.assignee_resource.as_ref().filter(|r| r.kind == "agent").map(|r| r.id);
        let mut metadata = json!({"security_level":"related","archived_at":if row.metadata.0.archived {Some(chrono::Utc::now().to_rfc3339())} else {None},"independent_issue_origin":{"creator_id":row.creator_id,"participant_ids":row.metadata.0.participants},"due_at":row.metadata.0.due_at,"resource_participants":row.metadata.0.resource_participants,"assignee_resource":row.metadata.0.assignee_resource});
        if let Some(assigned) = row.metadata.0.assignee_resource.as_ref().filter(|r| r.kind == "group") {
            let grant: Option<UserId> = tx.fetch_optional("SELECT 1 AS id FROM resource_members g JOIN resource_members p ON p.entity_type='workspace' AND p.entity_id=g.entity_id AND p.status='approved' WHERE g.resource_type='CollaborationGroup' AND g.resource_id=? AND g.entity_type='workspace' AND g.status='approved' AND p.resource_type='CloudProject' AND p.resource_id=? LIMIT 1",(assigned.id,number)).await?;
            if grant.is_none() { return Ok(Admission::InvalidTarget); }
            metadata["collaboration_group"] = row.metadata.0.resource_participants.iter().find(|r| r.kind == "group" && r.id == assigned.id).and_then(|r| r.group_snapshot.clone()).unwrap_or(Value::Null);
        }
        tx.execute("UPDATE loop_items SET next_item_number=? WHERE id=?",(sequence+1,body.project_id.as_str())).await?;
        tx.execute("UPDATE loop_items SET cloud_project_id=?,sequence_number=?,status=?,due_at=?,metadata=?,assignee_team_id=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(body.project_id.as_str(),sequence,target_status,row.metadata.0.due_at.as_ref().map(|date|format!("{date} 00:00:00")),Json(metadata),assignee_team,issue_id)).await?;
        tx.execute("UPDATE loop_items SET cloud_project_id=? WHERE loop_item_id=? AND resource_type='comment'",(body.project_id.as_str(),issue_id)).await?;
        let required=crate::loop_node_storage::required_columns(tx).await?;
        for person in row.metadata.0.participants {
            let id=format!("ic-{collaborator_prefix}-{person}");
            let sql=crate::loop_node_storage::insert_sql(&["id","resource_type","cloud_project_id","loop_item_id","user_id","added_by_user_id","description","source","metadata","version","sort_order","next_item_number","created_at","updated_at"],&["?","'collaborator'","?","?","?","?","''","'manual'","'{}'","1","0","1","UTC_TIMESTAMP(6)","UTC_TIMESTAMP(6)"],&required);
            tx.execute(sql,(id,body.project_id.as_str(),issue_id,person,user.0.id)).await?;
        }
        Ok(Admission::Allowed)
    }).await.map_err(internal)?;
    admitted(result)?;
    Ok(json!({"project_id":body.project_id,"issue_id":issue_id}))
}

#[cfg(test)]
mod mysql_tests;
#[cfg(test)]
mod tests;

#[brz_http_server::get("/api/v1/personal-issues/:issue_id/resources/:kind/:resource_id")]
#[tracing::instrument(skip_all, name = "collaboration.processing_resource")]
async fn processing_resource(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    kind: &str,
    resource_id: &str,
) -> Result<Value, FastApiError> {
    let issue = read(&state.mysql, issue_id, user.0.id).await?;
    let id = resource_id.parse::<i64>().map_err(|_| missing())?;
    let invitation = ResourceInvitation {
        kind: kind.into(),
        id,
    };
    if !participants::references(&issue.metadata.0.resource_participants).contains(&invitation) {
        return Err(missing());
    }
    let resources = state
        .mysql
        .with_transaction(async |tx| participants::resolve(tx, user.0.id, &[invitation]).await)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    let resource = resources.first().ok_or_else(missing)?;
    Ok(
        json!({"name":resource.name,"team_id":resource.team_id,"instructions":resource.instructions}),
    )
}
