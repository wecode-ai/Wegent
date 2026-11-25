//! First-class Issues with no project or space. Authority is owner or explicit invitation.
use brz_http_server::{Query, StatusCode};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wegent_project_coordination::loop_tasks::issue_invitation::{
    collaborator_exists, collaborator_people,
};
use wegent_project_coordination::project_chat_message::{
    InsertMessage, MessageRow, database_timestamp, insert_message_on, message_view,
    shared_message_payload, utc_timestamp,
};
use wegent_project_coordination::{
    project_issues::issue_status_event,
    project_store::{DATABASE_NOW_SQL, default_status_name},
};

use crate::socketio::issue_discussion::publish_comment_on;
use crate::socketio::project_chat_messages::{HistoryPage, fetch_history};
use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

mod assignment_count;
mod assistant;
mod create;
mod invitations;
mod participants;
pub(crate) mod share;
use participants::{ResourceInvitation, ResourceParticipant};

fn select_issue(include_attachments: bool) -> String {
    let metadata = if include_attachments {
        share::METADATA_WITH_FILES
    } else {
        "JSON_REMOVE(loop_items.metadata,'$.share.files')"
    };
    let people = collaborator_people("loop_items.id", false);
    let direct_people = collaborator_people("loop_items.id", true);
    let invited_user = collaborator_exists("loop_items.id", "u.id");
    format!(
        "SELECT id,NULLIF(parent_id,'') AS parent_id,COALESCE(title,'') AS title,description,status,priority,created_by_user_id AS creator_id,NULLIF(assignee_user_id,0) AS assignee_id,version,
         CAST(JSON_SET({metadata},
           '$.due_at',COALESCE(DATE_FORMAT({STORED_DUE_AT},'%Y-%m-%d'),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata,'$.due_at')),'null')),
           '$.participants',COALESCE({people},JSON_ARRAY()),
           '$.direct_participants',COALESCE({direct_people},JSON_ARRAY())) AS JSON) AS metadata,
         CAST(DATE_SUB(created_at, INTERVAL 8 HOUR) AS CHAR) AS created_at,CAST(DATE_SUB(updated_at, INTERVAL 8 HOUR) AS CHAR) AS updated_at,(SELECT COALESCE(JSON_OBJECTAGG(CAST(u.id AS CHAR),u.user_name),JSON_OBJECT()) FROM users u WHERE u.id=loop_items.created_by_user_id OR {invited_user}) AS people FROM loop_items"
    )
}
const STORED_DUE_AT: &str = "CASE WHEN loop_items.due_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01') THEN NULL ELSE loop_items.due_at END";
const LIVE: &str = "resource_type='task' AND (cloud_project_id IS NULL OR cloud_project_id='') AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))";

fn unset_due_at_sql(required_columns: &std::collections::HashSet<String>) -> &'static str {
    if required_columns.contains("due_at") {
        crate::loop_node_storage::MYSQL_UNSET_DATETIME_SQL
    } else {
        "NULL"
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Metadata {
    #[serde(skip_serializing)]
    participants: Vec<i32>,
    #[serde(skip_serializing)]
    direct_participants: Option<Vec<i32>>,
    assignee_resource: Option<ResourceInvitation>,
    resource_participants: Vec<ResourceParticipant>,
    archived: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    status_history: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    due_at: Option<String>,
    assigned_at: Option<String>,
    assignment_id: Option<String>,
    share: Option<share::Share>,
}

impl Metadata {
    fn direct_people(&self) -> &[i32] {
        self.direct_participants
            .as_deref()
            .unwrap_or(&self.participants)
    }

    fn set_resource_participants(&mut self, resources: Vec<ResourceParticipant>) {
        self.participants.extend(
            resources
                .iter()
                .flat_map(|resource| resource.human_ids.iter())
                .copied(),
        );
        self.participants.sort_unstable();
        self.participants.dedup();
        self.resource_participants = resources;
    }
}

#[derive(Debug, Serialize, FromMysqlRow)]
pub(crate) struct Issue {
    id: String,
    parent_id: Option<String>,
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
    if let Some(metadata) = public.as_object_mut() {
        metadata.entry("due_at").or_insert(Value::Null);
        metadata.insert("participants".into(), json!(&value.0.participants));
        metadata.insert("direct_participants".into(), json!(value.0.direct_people()));
    }
    if let Some(resources) = public["resource_participants"].as_array_mut() {
        for resource in resources {
            if let Some(resource) = resource.as_object_mut() {
                resource.remove("instructions");
                resource.remove("group_snapshot");
            }
        }
    }
    if let Some(files) = public
        .pointer_mut("/share/files")
        .and_then(Value::as_array_mut)
    {
        for file in files.iter_mut().filter_map(Value::as_object_mut) {
            file.remove("object_key");
            file.remove("sha256");
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
        crate::loop_tasks::item_access::can_read_issue_without_project(
            Some(self.creator_id),
            &self.metadata.0.participants,
            user,
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    title: String,
    parent_id: Option<String>,
    request_id: Option<String>,
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
    fn stored_due_at(&self) -> Option<String> {
        use chrono::Datelike;
        let date = chrono::NaiveDate::parse_from_str(self.due_at.as_deref()?, "%Y-%m-%d").ok()?;
        // Older clients can store dates outside the MySQL range or on the unset sentinel day.
        if !(1000..=9999).contains(&date.year()) || (date.year() == 1970 && date.ordinal() == 1) {
            return None;
        }
        Some(date.format("%Y-%m-%d 00:00:00").to_string())
    }

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
                .parent_id
                .as_ref()
                .is_some_and(|id| id.trim().is_empty() || id.len() > 64)
            || (self.request_id.is_some() && self.parent_id.is_none())
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
            direct_participants: Some(participants.clone()),
            resource_participants: Vec::new(),
            assignee_resource: self.assignee_resource.clone(),
            participants,
            archived: self.archived,
            status_history: Vec::new(),
            due_at: self
                .due_at
                .clone()
                .filter(|_| self.stored_due_at().is_none()),
            assigned_at: None,
            assignment_id: None,
            share: None,
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

async fn locked<T: MysqlTransaction>(
    tx: &mut T,
    id: &str,
) -> brz_mysql::MysqlResult<Option<Issue>> {
    tx.fetch_optional(
        format!("{} WHERE id=? AND {LIVE} FOR UPDATE", select_issue(false)),
        (id,),
    )
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
    read_issue(&state.mysql, issue_id, user.0.id, true).await
}

async fn read_issue(
    mysql: &impl Mysql,
    issue_id: &str,
    user_id: i32,
    include_attachments: bool,
) -> Result<Issue, FastApiError> {
    let row: Option<Issue> = mysql
        .fetch_optional(
            format!(
                "{} WHERE id=? AND {LIVE}",
                select_issue(include_attachments)
            ),
            (issue_id,),
        )
        .await
        .map_err(internal)?;
    row.filter(|row| row.can_read(user_id)).ok_or_else(missing)
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

#[brz_http_server::post("/api/v1/personal-issues")]
async fn create_issue(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: Input,
) -> Result<Issue, FastApiError> {
    let id = creation_id(user.0.id, &body)?;
    create_issue_record(state, user.0.id, body, &id, None, None).await?;
    get_issue(state, user, &id).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateLoopIssue<T = Input> {
    issue: T,
    project_id: Option<String>,
    project_status: Option<String>,
    request_id: Option<String>,
}

async fn create_loop_issue(
    state: &AppState,
    user: SessionUser,
    body: CreateLoopIssue,
) -> Result<Value, FastApiError> {
    let Some(project_id) = body.project_id else {
        if body.project_status.is_some() || body.request_id.is_some() {
            return Err(invalid("Project creation fields require a project"));
        }
        let issue = create_issue(state, user, body.issue).await?;
        return serde_json::to_value(issue).map_err(|_| FastApiError::internal());
    };
    crate::cloud_projects::parse_project_id(&project_id)?;
    if body.issue.parent_id.is_some() {
        return Err(invalid("Create a child from its parent Issue"));
    }
    let target = ProjectInput {
        project_id,
        version: 1,
        status: body.project_status,
    };
    let request_id = body
        .request_id
        .ok_or_else(|| invalid("Missing Issue request ID"))?;
    let request_id = normalize_creation_request_id(&request_id)
        .ok_or_else(|| invalid("Invalid Issue request ID"))?;
    let id = format!("issue-{}-{request_id}", user.0.id);
    create_issue_record(state, user.0.id, body.issue, &id, Some(&target), None).await?;
    Ok(json!({"project_id": target.project_id, "issue_id": id}))
}

fn creation_id(user_id: i32, body: &Input) -> Result<String, FastApiError> {
    match body.request_id.as_deref() {
        Some(request) => {
            let request_id = normalize_creation_request_id(request)
                .ok_or_else(|| invalid("Invalid child Issue request ID"))?;
            Ok(format!("child-{user_id}-{request_id}"))
        }
        None => identifier(),
    }
}

fn normalize_creation_request_id(request_id: &str) -> Option<String> {
    let hex = request_id.replace('-', "");
    (hex.len() == 32 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

async fn participation_notice(
    tx: &mut impl MysqlTransaction,
    recipient: i32,
    actor: i32,
    created: bool,
    payload: Value,
) -> brz_mysql::MysqlResult<crate::background_jobs::project::notifications::Pending> {
    crate::background_jobs::project::notifications::create_on(
        tx,
        i64::from(recipient),
        i64::from(actor),
        "issue_participation",
        if created {
            "事项已创建"
        } else {
            "你已加入事项"
        },
        "打开 Wework 查看事项。",
        payload,
    )
    .await
}

async fn create_issue_record(
    state: &AppState,
    user_id: i32,
    body: Input,
    id: &str,
    project: Option<&ProjectInput>,
    upload: Option<&share::IssueUpload>,
) -> Result<(), FastApiError> {
    use crate::background_jobs::project::notifications;
    body.validate()?;
    let source = upload.and_then(|upload| upload.source.as_ref());
    if source.is_some() && body.parent_id.is_some() {
        return Err(invalid("Use the parent Issue to create a child"));
    }
    if !assignee_is_invited(&body, user_id) {
        return Err(invalid("Invite the assignee before assigning"));
    }
    let mut metadata = body.metadata();
    metadata.status_history.push(issue_status_event(
        ("", ""),
        (&body.status, default_status_name(&body.status)),
        "create",
        i64::from(user_id),
        &chrono::Utc::now().to_rfc3339(),
    ));
    metadata.share = source.map(|_| share::Share { files: Vec::new() });
    let created = state
        .mysql
        .with_transaction(async |tx| {
            if let Some(parent_id) = &body.parent_id {
                if parent_id == id
                    || !locked(tx, parent_id).await?.is_some_and(|parent| parent.can_read(user_id))
                {
                    return Ok(Err(Admission::Missing));
                }
                if let Some(previous) = locked(tx, id).await? {
                    return Ok(if previous.creator_id == user_id && previous.parent_id.as_ref() == Some(parent_id) {
                        Ok(Vec::new())
                    } else {
                        Err(Admission::Conflict)
                    });
                }
            }
            if !valid_people(tx, &body.participants).await? {
                return Ok(Err(Admission::InvalidPeople));
            }
            let Some(resources) =
                participants::resolve(tx, user_id, &body.resource_participants).await?
            else {
                return Ok(Err(Admission::InvalidPeople));
            };
            metadata.set_resource_participants(resources);
            if !valid_people(tx, &metadata.participants).await? {
                return Ok(Err(Admission::InvalidPeople));
            }
            let inserted = wegent_project_coordination::project_store::insert(
                tx,
                "task",
                json!({
                    "id": id,
                    "parent_id": body.parent_id,
                    "title": body.title.trim(),
                    "description": body.description,
                    "status": body.status,
                    "priority": body.priority,
                    "due_at": body.stored_due_at(),
                    "created_by_user_id": user_id,
                    "assignee_user_id": body.assignee_id,
                    "metadata": metadata,
                }),
            )
            .await;
            if let Err(error) = inserted {
                if let Some(target) = project.filter(|_| upload.is_none() && error.database_code() == Some(1062)) {
                    let previous: Option<(String, i32)> = tx.fetch_optional(
                        "SELECT cloud_project_id,created_by_user_id FROM loop_items WHERE id=? AND resource_type='task' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE",
                        (id,),
                    ).await?;
                    if let Some((previous_project, previous_creator)) = previous
                        && previous_project == target.project_id
                        && previous_creator == user_id
                    {
                        let project_id = target.project_id.parse::<i64>().expect("validated project ID");
                        let access: Option<brz_mysql::MysqlRow> = tx.fetch_optional(
                            crate::cloud_projects::project_access_statement(user_id, Some(project_id), None),
                            (),
                        ).await?;
                        return Ok(match access {
                            Some(role) if role.get_required::<i64>("anon_1_priority")? <= 2 => Ok(Vec::new()),
                            _ => Err(Admission::Missing),
                        });
                    }
                    return Ok(Err(Admission::Conflict));
                }
                return Err(error);
            }
            invitations::sync(tx, id, user_id, None, &metadata).await?;
            if body.assignee_id.is_some() && (project.is_none() || source.is_none()) {
                update_human_assignment(tx, id, user_id, &body, &mut metadata, true).await?;
                tx.execute("UPDATE loop_items SET metadata=? WHERE id=?", (Json(&metadata), id))
                    .await?;
            }
            if let Some(upload) = upload {
                let required = crate::loop_node_storage::required_columns(tx).await?;
                if let Some(source) = source {
                    share::insert_source(tx, &required, id, user_id, source).await?;
                }
                share::insert_attachment_records(tx, &required, id, user_id, &upload.files).await?;
            }
            if let Some(target) = project {
                let mode = if source.is_some() { AssociationMode::Share } else { AssociationMode::Create };
                let outcome = move_to_project(tx, user_id, id, target, mode).await?;
                if outcome != Admission::Allowed {
                    return Err(share::association_error(outcome));
                }
                if let Some(assignee) = body.assignee_id.filter(|id| source.is_some() && *id != user_id) {
                    let issue = locked_issue_node(tx, id).await?;
                    crate::background_jobs::project::assignments::record_manual_human(
                        tx, &issue, user_id, assignee, true, true,
                    ).await?;
                }
            }
            let payload = if let Some(target) = project {
                json!({"projectId": target.project_id, "itemId": id})
            } else {
                json!({"personalIssueId": id})
            };
            let recipients = std::iter::once(user_id)
                .chain(metadata.participants.iter().copied().filter(|id| *id != user_id));
            let mut notices = Vec::new();
            for recipient in recipients {
                let mut recipient_payload = payload.clone();
                if recipient_payload["personalIssueId"].is_string() {
                    recipient_payload["assigned"] = json!(body.assignee_id == Some(recipient));
                }
                if source.is_some() && recipient != user_id {
                    notices.push(
                        notifications::create_on(
                            tx,
                            i64::from(recipient),
                            i64::from(user_id),
                            "issue_shared",
                            body.title.trim(),
                            "有同事与你分享了一个协作事项。你也可以在 Wework 的「协作」中查看和处理。",
                            recipient_payload,
                        )
                        .await?,
                    );
                } else {
                    recipient_payload["itemTitle"] = json!(body.title.trim());
                    notices.push(
                        participation_notice(tx, recipient, user_id, recipient == user_id, recipient_payload).await?,
                    );
                }
            }
            Ok(Ok(notices))
        })
        .await
        .map_err(share::creation_error)?;
    let notices = match created {
        Ok(notices) => notices,
        Err(Admission::Missing) => return Err(missing()),
        Err(Admission::Conflict) => {
            return Err(FastApiError::detail(
                StatusCode::CONFLICT,
                "Issue request already exists",
            ));
        }
        Err(_) => return Err(invalid("Invalid participant")),
    };
    for notice in notices {
        notifications::deliver(state, notice).await;
    }
    if let Some(assignee) = body.assignee_id {
        assignment_count::invalidate(state, assignee).await;
    }
    Ok(())
}

async fn update_human_assignment(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
    actor: i32,
    issue: &Input,
    metadata: &mut Metadata,
    fresh_issue: bool,
) -> brz_mysql::MysqlResult<()> {
    use crate::background_jobs::project::assignments;

    let row = locked_issue_node(tx, issue_id).await?;
    if let Some(assignee) = issue.assignee_id {
        let notify = assignee != actor && !issue.archived && issue.status != "completed";
        let identity =
            assignments::record_manual_human(tx, &row, actor, assignee, notify, fresh_issue)
                .await?;
        metadata.assigned_at =
            Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true));
        metadata.assignment_id = Some(identity);
    } else {
        assignments::clear_human_assignment(tx, &row, i64::from(actor)).await?;
    }
    Ok(())
}

async fn locked_issue_node(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
) -> brz_mysql::MysqlResult<wegent_project_coordination::project_store::Node> {
    wegent_project_coordination::project_store::locked(tx, "task", issue_id)
        .await?
        .ok_or(brz_mysql::MysqlError::RowNotFound)
}

#[derive(Debug, PartialEq)]
enum Admission {
    Allowed,
    Missing,
    Conflict,
    OwnerRequired,
    InvalidPeople,
    InvalidTarget,
    InvalidRecipients,
}

fn admission(row: &Issue, user: i32, body: &Input) -> Admission {
    if !row.can_read(user) {
        return Admission::Missing;
    }
    if body.version != Some(row.version) {
        return Admission::Conflict;
    }
    let mut previous = row.metadata.0.direct_people().to_vec();
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
        Admission::InvalidRecipients => Err(invalid(
            "Some colleagues cannot access issues in this project",
        )),
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
    if body.parent_id.is_some() || body.request_id.is_some() {
        return Err(invalid("Child Issue fields are accepted on creation"));
    }
    let mut affected = [None, None];
    let mut notices = Vec::new();
    let result = state.mysql.with_transaction(async |tx| {
        let Some(row) = locked(tx, issue_id).await?.filter(|row| row.can_read(user.0.id)) else {
            return Ok(Admission::Missing);
        };
        let result = admission(&row, user.0.id, &body);
        if result != Admission::Allowed { return Ok(result); }
        if body.assignee_id != row.assignee_id && !valid_people(tx, body.assignee_id.as_slice()).await? { return Ok(Admission::InvalidPeople); }
        let mut metadata = body.metadata();
        let resources = if participants::references(&row.metadata.0.resource_participants) == body.resource_participants { row.metadata.0.resource_participants.clone() } else { let Some(resources) = participants::resolve(tx, user.0.id, &body.resource_participants).await? else { return Ok(Admission::InvalidPeople) }; resources };
        metadata.set_resource_participants(resources);
        if !valid_people(tx, &metadata.participants).await? { return Ok(Admission::InvalidPeople); }
        invitations::sync(tx, issue_id, user.0.id, Some(&row.metadata.0), &metadata).await?;
        metadata.status_history = row.metadata.0.status_history;
        if row.status != body.status {
            metadata.status_history.push(issue_status_event(
                (&row.status, default_status_name(&row.status)),
                (&body.status, default_status_name(&body.status)),
                "user_update",
                i64::from(user.0.id),
                &chrono::Utc::now().to_rfc3339(),
            ));
        }
        metadata.share = row.metadata.0.share.clone();
        let previous: std::collections::HashSet<_> = row.metadata.0.participants.iter().copied().collect();
        for &recipient in &metadata.participants {
            if recipient != row.creator_id && !previous.contains(&recipient) {
                notices.push(participation_notice(tx, recipient, user.0.id, false, json!({
                    "personalIssueId": issue_id,
                    "itemTitle": body.title.trim(),
                    "assigned": body.assignee_id == Some(recipient),
                })).await?);
            }
        }
        if body.assignee_id == row.assignee_id {
            metadata.assigned_at = row.metadata.0.assigned_at;
            metadata.assignment_id = row.metadata.0.assignment_id;
        } else {
            assistant::retire_reservation(tx, issue_id, row.metadata.0.assignment_id.as_deref()).await?;
            update_human_assignment(tx, issue_id, user.0.id, &body, &mut metadata, false).await?;
        }
        let due_at = body.stored_due_at();
        let unset_due_at = if due_at.is_none() {
            unset_due_at_sql(&crate::loop_node_storage::required_columns(tx).await?)
        } else {
            "NULL"
        };
        let (Json(raw),): (Json<Value>,) = tx.fetch_one(
            "SELECT COALESCE(metadata,JSON_OBJECT()) FROM loop_items WHERE id=? FOR UPDATE",
            (issue_id,),
        ).await?;
        let mut merged = raw.as_object().cloned().unwrap_or_default();
        for key in ["participants", "direct_participants", "due_at", "status_history"] {
            merged.remove(key);
        }
        let Value::Object(fields) = serde_json::to_value(&metadata).expect("Issue metadata serializes") else {
            unreachable!("Issue metadata serializes as an object")
        };
        merged.extend(fields);
        tx.execute(
            format!("UPDATE loop_items SET title=?,description=?,status=?,priority=?,assignee_user_id=?,due_at=COALESCE(?,{unset_due_at}),metadata=?,version=version+1,updated_at={DATABASE_NOW_SQL} WHERE id=?"),
            (body.title.trim(),body.description.as_str(),body.status.as_str(),body.priority.as_str(),body.assignee_id,due_at,Json(merged),issue_id)
        ).await?;
        if row.assignee_id != body.assignee_id || row.status != body.status || row.metadata.0.archived != body.archived {
            affected = [row.assignee_id, body.assignee_id.filter(|id| Some(*id) != row.assignee_id)];
        }
        Ok(Admission::Allowed)
    }).await.map_err(internal)?;
    admitted(result)?;
    for notice in notices {
        crate::background_jobs::project::notifications::deliver(state, notice).await;
    }
    for assignee in affected.into_iter().flatten() {
        assignment_count::invalidate(state, assignee).await;
    }
    get_issue(state, user, issue_id).await
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
    let mut assignee = None;
    let result = state.mysql.with_transaction(async |tx| {
        let Some(row) = locked(tx, issue_id).await? else { return Ok(Err(Admission::Missing)); };
        if row.creator_id != user.0.id { return Ok(Err(Admission::Missing)); }
        if row.version != body.version { return Ok(Err(Admission::Conflict)); }
        assistant::retire_reservation(tx, issue_id, row.metadata.0.assignment_id.as_deref()).await?;
        tx.execute(format!("UPDATE loop_items SET deleted_at={DATABASE_NOW_SQL},updated_at={DATABASE_NOW_SQL},version=version+1 WHERE id=?"), (issue_id,)).await?;
        tx.execute("UPDATE project_chat_messages SET deleted_at=NOW(6) WHERE project_id='' AND task_id=? AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))", (issue_id,)).await?;
        assignee = row.assignee_id;
        Ok(Ok(()))
    }).await.map_err(internal)?;
    match result {
        Ok(()) => {
            if let Err(error) = share::clean_deleted_share(state, issue_id).await {
                tracing::warn!(issue_id, %error, "Deleted issue attachment cleanup will be retried");
            }
        }
        Err(reason) => admitted(reason)?,
    }
    if let Some(assignee) = assignee {
        assignment_count::invalidate(state, assignee).await;
    }
    Ok(json!({"deleted":true}))
}

#[derive(Debug, Serialize)]
struct Comment {
    id: String,
    author_id: i32,
    body: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    assistant_name: Option<String>,
}

impl From<&MessageRow> for Comment {
    fn from(row: &MessageRow) -> Self {
        let assistant_name = row
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.0["assistant_name"].as_str())
            .map(str::to_owned);
        Self {
            id: row.message_id.clone(),
            author_id: row.sender_id.parse().unwrap_or_default(),
            body: row.content.clone(),
            created_at: utc_timestamp(row.created_at)
                .format("%Y-%m-%d %H:%M:%S%.6f")
                .to_string(),
            assistant_name,
        }
    }
}
#[derive(Default, Deserialize)]
struct DiscussionQuery {
    #[serde(default)]
    view: DiscussionView,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DiscussionView {
    #[default]
    Comment,
    Message,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommentInput {
    body: String,
    #[serde(default)]
    mentioned_user_ids: Vec<i32>,
}

#[brz_http_server::get("/api/v1/personal-issues/:issue_id/comments")]
async fn list_comments(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    query: Query<DiscussionQuery>,
) -> Result<Value, FastApiError> {
    let messages: Option<Vec<MessageRow>> = state
        .mysql
        .with_transaction(async |tx| {
            let Some(row) = locked(tx, issue_id).await? else {
                return Ok(None);
            };
            if !row.can_read(user.0.id) {
                return Ok(None);
            }
            fetch_history(&mut &mut *tx, "", Some(issue_id), None, HistoryPage::All)
                .await
                .map(Some)
        })
        .await
        .map_err(internal)?;
    let messages = messages.ok_or_else(missing)?;
    Ok(match query.0.view {
        DiscussionView::Comment => json!(messages.iter().map(Comment::from).collect::<Vec<_>>()),
        DiscussionView::Message => Value::Array(
            messages
                .iter()
                .map(|row| shared_message_payload(&message_view(row)))
                .collect(),
        ),
    })
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
    let actor = user.0.id;
    let mut recipients = body.mentioned_user_ids;
    recipients.retain(|id| *id != actor);
    recipients.sort_unstable();
    recipients.dedup();
    let outcome =
        crate::transaction_outcome::run_mysql_with_deadlock_retry(&state.mysql, async |tx| {
            let Some(row) = locked(tx, issue_id).await? else {
                return Ok(Err(Admission::Missing));
            };
            if !row.can_read(actor) {
                return Ok(Err(Admission::Missing));
            }
            if recipients.iter().any(|id| !row.can_read(*id))
                || !valid_people(tx, &recipients).await?
            {
                return Ok(Err(Admission::InvalidPeople));
            }
            let issue = locked_issue_node(tx, issue_id).await?;
            let actor_id = actor.to_string();
            let (sender_type, sender_name) = issue_message_sender(&row, &actor_id, None);
            let message = issue_message(
                &row,
                &id,
                (&actor_id, sender_type, &sender_name),
                body.body.trim(),
                None,
            );
            let recipients: Vec<i64> = recipients.iter().copied().map(i64::from).collect();
            let (_, notices) = publish_comment_on(
                tx,
                &message,
                i64::from(actor),
                Some(&issue),
                &recipients,
                json!({"personalIssueId": issue_id, "itemTitle": row.title}),
            )
            .await?;
            Ok(Ok(notices))
        })
        .await
        .map_err(internal)?;
    match outcome {
        Ok(notices) => {
            for notice in notices {
                crate::background_jobs::project::notifications::deliver(state, notice).await;
            }
        }
        Err(reason) => admitted(reason)?,
    }
    Ok(json!({"id":id}))
}

async fn write_comment(
    tx: &mut impl MysqlTransaction,
    id: &str,
    issue: &Issue,
    author_id: i32,
    body: &str,
    assistant_name: Option<&str>,
) -> brz_mysql::MysqlResult<()> {
    insert_issue_message(tx, issue, id, author_id, body, assistant_name).await?;
    tx.execute(
        format!("UPDATE loop_items SET updated_at={DATABASE_NOW_SQL},version=version+1 WHERE id=?"),
        (issue.id.as_str(),),
    )
    .await?;
    Ok(())
}

async fn insert_issue_message(
    tx: &mut impl MysqlTransaction,
    issue: &Issue,
    message_id: &str,
    author_id: i32,
    content: &str,
    assistant_name: Option<&str>,
) -> brz_mysql::MysqlResult<()> {
    let sender_id = author_id.to_string();
    let (sender_type, sender_name) = issue_message_sender(issue, &sender_id, assistant_name);
    insert_message_on(
        tx,
        &issue_message(
            issue,
            message_id,
            (&sender_id, sender_type, &sender_name),
            content,
            assistant_name,
        ),
    )
    .await?;
    Ok(())
}

fn issue_message<'a>(
    issue: &'a Issue,
    message_id: &'a str,
    (sender_id, sender_type, sender_name): (&'a str, &'a str, &'a str),
    content: &'a str,
    assistant_name: Option<&str>,
) -> InsertMessage<'a> {
    InsertMessage {
        message_id,
        client_message_id: "",
        project_id: "",
        task_id: &issue.id,
        sender_type,
        sender_id,
        sender_name,
        message_type: "text",
        content,
        metadata: issue_message_metadata(assistant_name),
        trigger_message_id: "",
        reply_to_message_id: "",
        thread_root_message_id: "",
        agent_id: "",
        runtime_device_id: "",
        runtime_task_id: "",
        runtime_activity_key: "",
        status: "completed",
    }
}

fn issue_message_sender(
    issue: &Issue,
    sender_id: &str,
    assistant_name: Option<&str>,
) -> (&'static str, String) {
    if let Some(name) = assistant_name {
        return ("agent", name.into());
    }
    let name = issue
        .people
        .0
        .get(sender_id)
        .cloned()
        .unwrap_or_else(|| format!("#{sender_id}"));
    ("user", name)
}

fn issue_message_metadata(assistant_name: Option<&str>) -> Value {
    assistant_name.map_or_else(
        || json!({}),
        |name| json!({ "assistant_name": name, "execution_dispatch": "comment_only" }),
    )
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum AssociationMode {
    Existing,
    Create,
    Share,
}

#[brz_http_server::post("/api/v1/personal-issues/:issue_id/project")]
async fn associate_project(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    body: ProjectInput,
) -> Result<Value, FastApiError> {
    crate::cloud_projects::parse_project_id(&body.project_id)?;
    let result = state
        .mysql
        .with_transaction(async |tx| {
            move_to_project(tx, user.0.id, issue_id, &body, AssociationMode::Existing).await
        })
        .await
        .map_err(internal)?;
    admitted(result)?;
    Ok(json!({"project_id":body.project_id,"issue_id":issue_id}))
}

async fn move_to_project(
    tx: &mut impl MysqlTransaction,
    user_id: i32,
    issue_id: &str,
    body: &ProjectInput,
    mode: AssociationMode,
) -> brz_mysql::MysqlResult<Admission> {
    let number = body
        .project_id
        .parse::<i64>()
        .expect("validated project ID");
    let Some(row) = locked(tx, issue_id).await? else {
        return Ok(Admission::Missing);
    };
    if row.creator_id != user_id {
        return Ok(Admission::Missing);
    }
    if mode == AssociationMode::Existing && row.version != body.version {
        return Ok(Admission::Conflict);
    }
    let project: Option<TargetProject> = tx.fetch_optional("SELECT next_item_number,COALESCE(metadata,JSON_OBJECT()) AS metadata FROM loop_items WHERE id=? AND resource_type='project' AND status='active' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE", (body.project_id.as_str(),)).await?;
    let Some(project) = project else {
        return Ok(Admission::Missing);
    };
    let permissions: Vec<brz_mysql::MysqlRow> = tx
        .fetch_all(
            crate::cloud_projects::project_access_statement(user_id, Some(number), None),
            (),
        )
        .await?;
    let can_edit = permissions
        .first()
        .map(|row| row.get_required::<i64>("anon_1_priority"))
        .transpose()?
        .is_some_and(|priority| priority <= 2);
    if !can_edit {
        return Ok(Admission::Missing);
    }
    let provider = project
        .metadata
        .0
        .get("task_provider")
        .and_then(Value::as_str)
        .unwrap_or("local");
    if !matches!(provider, "backend" | "local") {
        return Ok(Admission::InvalidTarget);
    }
    if mode == AssociationMode::Share && !row.metadata.0.participants.is_empty() {
        let permits_issue_guests = if provider == "local" {
            let parent: Option<UserId> = tx.fetch_optional(
                "SELECT 1 AS id FROM resource_members relation JOIN kinds space ON space.id=relation.entity_id AND space.kind='CollaborationWorkspace' AND space.is_active=true WHERE relation.resource_type='CloudProject' AND relation.resource_id=? AND relation.entity_type='workspace' AND relation.status='approved' GROUP BY relation.resource_id HAVING COUNT(DISTINCT relation.entity_id)=1",
                (number,),
            ).await?;
            parent.is_some()
        } else {
            false
        };
        if !permits_issue_guests {
            for person in row
                .metadata
                .0
                .participants
                .iter()
                .copied()
                .filter(|person| *person != user_id)
            {
                let access: Option<brz_mysql::MysqlRow> = tx
                    .fetch_optional(
                        crate::cloud_projects::project_access_statement(person, Some(number), None),
                        (),
                    )
                    .await?;
                if access
                    .map(|role| role.get_required::<i64>("anon_1_priority"))
                    .transpose()?
                    .is_none_or(|priority| priority > 4)
                {
                    return Ok(Admission::InvalidRecipients);
                }
            }
        }
    }
    let statuses = crate::cloud_projects::metadata_board_statuses(
        project
            .metadata
            .0
            .as_object()
            .unwrap_or(&serde_json::Map::new()),
    );
    let requested_status = body.status.as_deref().unwrap_or_else(|| {
        if mode == AssociationMode::Create {
            statuses.first().map_or("", |(id, _)| id.as_str())
        } else {
            &row.status
        }
    });
    if !statuses.is_empty() && !statuses.iter().any(|(id, _)| id == requested_status) {
        return Ok(Admission::InvalidTarget);
    }
    let target_status = if statuses.is_empty() {
        ""
    } else {
        requested_status
    };
    let sequence = project.next_item_number.unwrap_or(1);
    let assignee_team = row
        .metadata
        .0
        .assignee_resource
        .as_ref()
        .filter(|r| r.kind == "agent")
        .map(|r| r.id);
    let security = if mode == AssociationMode::Share
        && project.metadata.0["default_issue_security"] != "related"
    {
        "open"
    } else {
        "related"
    };
    let mut metadata = json!({"security_level":security,"archived_at":if row.metadata.0.archived {Some(chrono::Utc::now().to_rfc3339())} else {None},"independent_issue_origin":{"creator_id":row.creator_id,"participant_ids":row.metadata.0.participants},"resource_participants":row.metadata.0.resource_participants,"assignee_resource":row.metadata.0.assignee_resource});
    if let Some(assigned) = row
        .metadata
        .0
        .assignee_resource
        .as_ref()
        .filter(|r| r.kind == "group")
    {
        let grant: Option<UserId> = tx.fetch_optional("SELECT 1 AS id FROM resource_members g JOIN resource_members p ON p.entity_type='workspace' AND p.entity_id=g.entity_id AND p.status='approved' WHERE g.resource_type='CollaborationGroup' AND g.resource_id=? AND g.entity_type='workspace' AND g.status='approved' AND p.resource_type='CloudProject' AND p.resource_id=? LIMIT 1",(assigned.id,number)).await?;
        if grant.is_none() {
            return Ok(Admission::InvalidTarget);
        }
        metadata["collaboration_group"] = row
            .metadata
            .0
            .resource_participants
            .iter()
            .find(|r| r.kind == "group" && r.id == assigned.id)
            .and_then(|r| r.group_snapshot.clone())
            .unwrap_or(Value::Null);
    }
    assistant::retire_reservation(tx, issue_id, row.metadata.0.assignment_id.as_deref()).await?;
    invitations::move_to_project(tx, issue_id, &body.project_id, user_id).await?;
    tx.execute(
        "UPDATE project_chat_messages SET project_id=? WHERE project_id='' AND task_id=?",
        (body.project_id.as_str(), issue_id),
    )
    .await?;
    let mut status_history = row.metadata.0.status_history;
    if row.status != target_status {
        let target_name = statuses
            .iter()
            .find(|(id, _)| id == target_status)
            .map(|(_, name)| name.as_str())
            .unwrap_or_default();
        status_history.push(issue_status_event(
            (&row.status, default_status_name(&row.status)),
            (target_status, target_name),
            "user_update",
            i64::from(user_id),
            &chrono::Utc::now().to_rfc3339(),
        ));
    }
    metadata["status_history"] = json!(status_history);
    tx.execute(
        "UPDATE loop_items SET next_item_number=? WHERE id=?",
        (sequence + 1, body.project_id.as_str()),
    )
    .await?;
    let required = crate::loop_node_storage::required_columns(tx).await?;
    let unset_due_at = unset_due_at_sql(&required);
    let due_at = row
        .metadata
        .0
        .due_at
        .as_ref()
        .map(|date| format!("{date} 00:00:00"));
    tx.execute(
        format!(
            "UPDATE loop_items SET cloud_project_id=?,sequence_number=?,status=?,\
             due_at=COALESCE({STORED_DUE_AT},?,{unset_due_at}),metadata=?,assignee_team_id=?,\
             version=version+1,updated_at={DATABASE_NOW_SQL} WHERE id=?"
        ),
        (
            body.project_id.as_str(),
            sequence,
            target_status,
            due_at,
            Json(metadata),
            assignee_team,
            issue_id,
        ),
    )
    .await?;
    tx.execute(
        "UPDATE loop_items SET cloud_project_id=? WHERE loop_item_id=? AND resource_type IN ('comment','execution')",
        (body.project_id.as_str(), issue_id),
    )
    .await?;
    Ok(Admission::Allowed)
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
    let issue = read_issue(&state.mysql, issue_id, user.0.id, false).await?;
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
