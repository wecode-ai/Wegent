//! Assignment-scoped reception receipts, independent of notification read state.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use super::assignments::{active_events, internal, list_assignments};
use super::auth::FlexibleUser;
use super::loop_repository::{CommentRow, LoopItemRepository, item_comments_query};
use crate::{http_compat::FastApiError, state::AppState};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReceiptKind {
    HumanRead,
    StandInReceived,
}

#[derive(Deserialize)]
struct ReceiptInput {
    kind: ReceiptKind,
    device_id: Option<String>,
    task_id: Option<String>,
}

#[brz_http_server::post("/api/v1/loop-items/:item_id/assignments/:assignment_id/receipt")]
async fn acknowledge_assignment(
    #[inject(state)] state: &AppState,
    item_id: &str,
    assignment_id: &str,
    #[auth] user: FlexibleUser,
    payload: ReceiptInput,
) -> Result<Value, FastApiError> {
    // The existing read policy includes project membership and Issue security.
    let assignments = list_assignments(state, item_id, &user).await?;
    let assignment = assignments
        .items
        .iter()
        .find(|row| row.id == assignment_id)
        .ok_or_else(|| {
            FastApiError::detail(StatusCode::CONFLICT, "Assignment is no longer active")
        })?;
    require_recipient(&assignment.target_type, &assignment.target_id, user.id)?;
    let field = match payload.kind {
        ReceiptKind::HumanRead => "human_read_at",
        ReceiptKind::StandInReceived => {
            require_personal_binding(state, item_id, assignment_id, &user, &payload).await?;
            "stand_in_received_at"
        }
    };
    // JSON_INSERT preserves the first receipt and never replaces unrelated metadata.
    // The assignment event remains immutable from the event reducer's perspective.
    let timestamp = chrono::Utc::now().to_rfc3339();
    #[derive(FromMysqlRow)]
    struct LockedRow {
        id: String,
    }
    let written = state
        .mysql
        .with_transaction(async |tx| {
            // Lock the Issue and its activity range before rechecking the current assignment.
            let locked: Vec<LockedRow> = tx
                .fetch_all(
                    "SELECT id FROM loop_items WHERE id = ? AND resource_type = 'task' FOR UPDATE",
                    (item_id,),
                )
                .await?;
            if !locked.iter().any(|row| row.id == item_id) {
                return Ok(false);
            }
            let comments: Vec<CommentRow> = tx
                .fetch_all(format!("{} FOR UPDATE", item_comments_query()), (item_id,))
                .await?;
            if !active_events(&comments)
                .iter()
                .any(|event| event.comment.id == assignment_id)
            {
                return Ok(false);
            }
            tx.execute(
            "UPDATE loop_items SET metadata = JSON_INSERT(COALESCE(metadata, JSON_OBJECT()), ?, ?) \
             WHERE id = ? AND loop_item_id = ? AND resource_type = 'comment'",
            (format!("$.{field}"), timestamp.as_str(), assignment_id, item_id),
        ).await?;
            Ok(true)
        })
        .await
        .map_err(internal)?;
    if !written {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Assignment is no longer active",
        ));
    }
    Ok(json!({"acknowledged": true}))
}

async fn require_personal_binding(
    state: &AppState,
    item_id: &str,
    assignment_id: &str,
    user: &FlexibleUser,
    payload: &ReceiptInput,
) -> Result<(), FastApiError> {
    let device_id = payload.device_id.as_deref().unwrap_or_default();
    let identities = crate::device_identity::owned_device_identity_ids(
        &state.mysql,
        i64::from(user.id),
        device_id,
    )
    .await
    .map_err(internal)?;
    let bindings = LoopItemRepository::new(&state.mysql)
        .list_task_bindings(item_id)
        .await
        .map_err(internal)?;
    if bindings.iter().any(|binding| {
        binding.task_user_id == user.id
            && identities.contains(&binding.device_id)
            && Some(binding.task_id.as_str()) == payload.task_id.as_deref()
            && binding
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.0.value.as_ref())
                .and_then(|metadata| metadata.assignment_id.as_deref())
                == Some(assignment_id)
    }) {
        Ok(())
    } else {
        Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "A recipient-owned task binding is required",
        ))
    }
}

fn require_recipient(target_type: &str, target_id: &str, user_id: i32) -> Result<(), FastApiError> {
    if target_type == "human" && target_id == user_id.to_string() {
        Ok(())
    } else {
        Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "Only the recipient can acknowledge an assignment",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipts_cannot_be_written_by_an_assigner_or_for_an_agent() {
        assert!(require_recipient("human", "7", 7).is_ok());
        assert!(require_recipient("human", "7", 8).is_err());
        assert!(require_recipient("agent", "7", 7).is_err());
        assert!(require_recipient("human", "", 7).is_err());
    }

    #[test]
    fn reception_is_not_an_execution_completion_status() {
        assert!(serde_json::from_value::<ReceiptInput>(json!({"kind":"human_read"})).is_ok());
        assert!(
            serde_json::from_value::<ReceiptInput>(
                json!({"kind":"stand_in_received","device_id":"mac","task_id":"task"})
            )
            .is_ok()
        );
        assert!(serde_json::from_value::<ReceiptInput>(json!({"kind":"completed"})).is_err());
    }
}
