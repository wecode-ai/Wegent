//! A standalone Issue carries one assistant reservation per active assignment.
use sha2::{Digest, Sha256};

use super::*;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct Binding {
    device_record_id: i64,
    task_id: String,
    role_id: String,
    role_name: String,
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
    let result = state
        .mysql
        .with_transaction(async |tx| {
            let Some(mut row) = locked(tx, issue_id).await? else {
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
            if let Some(existing) = &row.metadata.0.assistant_binding {
                // A role can be renamed without replacing its existing conversation.
                return Ok(Some(
                    existing.device_record_id == binding.device_record_id
                        && existing.task_id == binding.task_id
                        && existing.role_id == binding.role_id,
                ));
            }
            row.metadata.0.assistant_binding = Some(binding);
            tx.execute(
                "UPDATE loop_items SET metadata=? WHERE id=?",
                (row.metadata, issue_id),
            )
            .await?;
            Ok(Some(true))
        })
        .await
        .map_err(internal)?;
    result
        .map(|claimed| json!({"claimed":claimed}))
        .ok_or_else(missing)
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
            let Some(binding) = row.metadata.0.assistant_binding.filter(|binding| {
                binding.device_record_id == device && binding.task_id == body.assignment.task_id
            }) else {
                return Ok(false);
            };
            let existing: Option<String> = tx
                .fetch_optional("SELECT id FROM loop_items WHERE id=?", (id.as_str(),))
                .await?;
            if existing.is_none() {
                write_comment(
                    tx,
                    &id,
                    issue_id,
                    user,
                    body.body.trim(),
                    json!({"assistant_name":binding.role_name}),
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
