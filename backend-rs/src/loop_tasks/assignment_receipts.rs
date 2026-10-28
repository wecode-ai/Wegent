//! Assignment-scoped reception receipts, independent of notification read state.
use brz_http_server::StatusCode;
use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use super::assignment_index::{ensure_active_index, index_id};
use super::assignments::{internal, require_issue_read};
use super::auth::FlexibleUser;
use super::loop_repository::{AssignmentMetadata, LoopItemRepository};
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

// Only the current assignment IDs are indexed. Historical events remain audit data.
const RECEIPT_QUERY: &str = "SELECT event.metadata FROM loop_items active \
    JOIN loop_items event ON event.id = active.loop_item_id \
    WHERE active.parent_id = ? AND active.resource_type = 'assignment_index' AND event.resource_type = 'comment' \
    AND (event.deleted_at IS NULL OR event.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))";

#[derive(FromMysqlRow)]
struct ReceiptRow {
    metadata: Option<Json<JsonProjection<AssignmentMetadata>>>,
}

impl ReceiptRow {
    fn metadata(&self) -> Option<&AssignmentMetadata> {
        self.metadata
            .as_ref()
            .and_then(|value| value.0.value.as_ref())
    }
}

fn require_active_recipient(row: Option<&ReceiptRow>, user_id: i32) -> Result<(), FastApiError> {
    let metadata = row.and_then(ReceiptRow::metadata).ok_or_else(|| {
        FastApiError::detail(StatusCode::CONFLICT, "Assignment is no longer active")
    })?;
    require_recipient(
        metadata.target_type.as_deref().unwrap_or_default(),
        metadata.target_id.as_deref().unwrap_or_default(),
        user_id,
    )
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
    require_issue_read(state, item_id, &user).await?;
    ensure_active_index(state, item_id).await?;
    let assignment: Option<ReceiptRow> = state
        .mysql
        .fetch_optional(
            format!("{RECEIPT_QUERY} AND active.id = ? AND event.id = ?"),
            (
                item_id,
                index_id("active-assignment", assignment_id),
                assignment_id,
            ),
        )
        .await
        .map_err(internal)?;
    require_active_recipient(assignment.as_ref(), user.id)?;
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
            // Assignment changes take the same Issue lock; no activity range is read or locked.
            let locked: Vec<LockedRow> = tx
                .fetch_all(
                    "SELECT id FROM loop_items WHERE id = ? AND resource_type = 'task' FOR UPDATE",
                    (item_id,),
                )
                .await?;
            if !locked.iter().any(|row| row.id == item_id) {
                return Ok(false);
            }
            let assignment: Option<ReceiptRow> = tx
                .fetch_optional(
                    format!("{RECEIPT_QUERY} AND active.id = ? AND event.id = ? FOR UPDATE"),
                    (
                        item_id,
                        index_id("active-assignment", assignment_id),
                        assignment_id,
                    ),
                )
                .await?;
            if require_active_recipient(assignment.as_ref(), user.id).is_err() {
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
    if crate::device_identity::resolve_owned_device_alias(
        &state.mysql,
        i64::from(user.id),
        device_id,
    )
    .await
    .map_err(internal)?
    .is_none()
    {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "A recipient-owned task binding is required",
        ));
    }
    let identities = crate::device_identity::owned_device_identity_ids(
        &state.mysql,
        i64::from(user.id),
        device_id,
    )
    .await
    .map_err(internal)?;
    let bindings = LoopItemRepository::new(&state.mysql)
        .list_task_bindings(item_id, user.id)
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
