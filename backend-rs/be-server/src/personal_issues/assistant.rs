//! An automatic stand-in reservation follows the current human assignment.
use sha2::{Digest, Sha256};

use super::*;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Binding {
    device_record_id: i64,
    task_id: String,
    role_id: String,
    role_name: String,
}

#[derive(FromMysqlRow)]
struct Reservation {
    binding: Json<Binding>,
    active: bool,
}

fn reservation_id(issue_id: &str, assignment_id: &str) -> String {
    crate::hex_sha256(format!("issue-stand-in:{issue_id}:{assignment_id}").as_bytes())
}

async fn reservation_on(
    tx: &mut impl MysqlTransaction,
    id: &str,
) -> brz_mysql::MysqlResult<Option<Reservation>> {
    tx.fetch_optional(
        "SELECT JSON_EXTRACT(metadata,'$.stand_in_reservation') AS binding,
                ((deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))
                  AND (unlinked_at IS NULL OR unlinked_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))) AS active
         FROM loop_items WHERE id=? AND resource_type='execution'",
        (id,),
    )
    .await
}

async fn store_reservation(
    tx: &mut impl MysqlTransaction,
    id: &str,
    issue: &Issue,
    user: i32,
    assignment: &Assignment,
    binding: &Binding,
) -> brz_mysql::MysqlResult<()> {
    wegent_project_coordination::project_store::insert(tx, "execution", json!({
        "id": id, "cloud_project_id": "", "loop_item_id": issue.id,
        "task_user_id": user, "linked_by_user_id": user, "device_id": assignment.device_id,
        "task_id": binding.task_id, "task_title": issue.title,
        "linked_at": database_timestamp(chrono::Utc::now().naive_utc()).format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        "metadata": {
            "assignment_id": assignment.assignment_id,
            "stand_in_conversation_id": binding.task_id,
            "stand_in_reservation": binding,
        }
    })).await?;
    Ok(())
}

pub(super) async fn retire_reservation(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
    assignment: Option<&str>,
) -> brz_mysql::MysqlResult<()> {
    if let Some(assignment) = assignment {
        let id = reservation_id(issue_id, assignment);
        if reservation_on(tx, &id)
            .await?
            .is_none_or(|record| !record.active)
        {
            return Ok(());
        }
        tx.execute(
            "UPDATE loop_items SET unlinked_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='execution'
             AND (unlinked_at IS NULL OR unlinked_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",
            (id,),
        ).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assignment {
    assignment_id: String,
    device_id: String,
    task_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Claim {
    assignment: Assignment,
    role_id: String,
    role_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Reply {
    assignment: Assignment,
    message_id: String,
    body: String,
}

fn valid_id(id: &str, max: usize) -> bool {
    !id.trim().is_empty() && id.len() <= max && !id.chars().any(char::is_control)
}

impl Assignment {
    async fn owned_device(&self, state: &AppState, user: i32) -> Result<i64, FastApiError> {
        if !valid_id(&self.assignment_id, 64)
            || !valid_id(&self.device_id, 256)
            || !valid_id(&self.task_id, 128)
        {
            return Err(invalid("Invalid assignment identity"));
        }
        crate::device_identity::resolve_owned_device_alias(
            &state.mysql,
            user.into(),
            &self.device_id,
        )
        .await
        .map_err(internal)?
        .map(|device| device.id)
        .ok_or_else(|| FastApiError::forbidden("A recipient-owned device is required"))
    }

    fn is_current(&self, row: &Issue, user: i32) -> bool {
        row.can_read(user)
            && row.assignee_id == Some(user)
            && !row.metadata.0.archived
            && row.status != "completed"
            && row.metadata.0.assignment_id.as_deref() == Some(&self.assignment_id)
    }
}

#[brz_http_server::post("/api/v1/personal-issues/:issue_id/assistant-binding")]
#[tracing::instrument(skip_all, name = "collaboration.claim_personal_issue_assignment")]
pub(super) async fn claim(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    body: Claim,
) -> Result<Value, FastApiError> {
    if !valid_id(&body.role_id, 64) || !valid_id(&body.role_name, 255) {
        return Err(invalid("Invalid assistant role"));
    }
    let user = user.0.id;
    let device_record_id = body.assignment.owned_device(state, user).await?;
    let id = reservation_id(issue_id, &body.assignment.assignment_id);
    let result = state
        .mysql
        .with_transaction(async |tx| {
            let Some(row) = locked(tx, issue_id).await? else {
                return Ok(None);
            };
            if !body.assignment.is_current(&row, user) {
                return Ok(None);
            }
            let binding = Binding {
                device_record_id,
                task_id: body.assignment.task_id.clone(),
                role_id: body.role_id,
                role_name: body.role_name,
            };
            if let Some(existing) = reservation_on(tx, &id).await? {
                return Ok(Some(
                    existing.active && same_reservation(&existing.binding.0, &binding),
                ));
            }
            store_reservation(tx, &id, &row, user, &body.assignment, &binding).await?;
            Ok(Some(true))
        })
        .await
        .map_err(internal)?;
    result
        .map(|claimed| json!({"claimed":claimed}))
        .ok_or_else(missing)
}

fn same_reservation(existing: &Binding, requested: &Binding) -> bool {
    // A role can be renamed without replacing its existing conversation.
    existing.device_record_id == requested.device_record_id
        && existing.task_id == requested.task_id
        && existing.role_id == requested.role_id
}

#[brz_http_server::post("/api/v1/personal-issues/:issue_id/assistant-replies")]
#[tracing::instrument(skip_all, name = "collaboration.publish_personal_issue_reply")]
pub(super) async fn reply(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    issue_id: &str,
    body: Reply,
) -> Result<Value, FastApiError> {
    if !valid_id(&body.message_id, 512) || body.body.trim().is_empty() {
        return Err(invalid("Invalid assistant reply"));
    }
    let user = user.0.id;
    let device = body.assignment.owned_device(state, user).await?;
    let reservation = reservation_id(issue_id, &body.assignment.assignment_id);
    let id = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&[
                "personal-issue-reply",
                issue_id,
                &body.assignment.assignment_id,
                &body.message_id,
            ])
            .expect("serializing string identifiers")
        )
    );
    let written = state
        .mysql
        .with_transaction(async |tx| {
            let Some(row) = locked(tx, issue_id).await? else {
                return Ok(false);
            };
            if !body.assignment.is_current(&row, user) {
                return Ok(false);
            }
            let Some(record) = reservation_on(tx, &reservation).await?.filter(|record| {
                record.active
                    && record.binding.0.device_record_id == device
                    && record.binding.0.task_id == body.assignment.task_id
            }) else {
                return Ok(false);
            };
            let (existing,): (i64,) = tx
                .fetch_one(
                    "SELECT EXISTS(SELECT 1 FROM project_chat_messages WHERE project_id='' AND task_id=? AND message_id=?)",
                    (issue_id, id.as_str()),
                )
                .await?;
            if existing == 0 {
                write_comment(
                    tx,
                    &id,
                    &row,
                    user,
                    body.body.trim(),
                    Some(record.binding.0.role_name.as_str()),
                )
                .await?;
            }
            Ok(true)
        })
        .await
        .map_err(internal)?;
    if written {
        Ok(json!({"id":id}))
    } else {
        Err(missing())
    }
}
