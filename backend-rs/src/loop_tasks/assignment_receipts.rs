//! Assignment-scoped reception receipts, independent of notification read state.
use brz_http_server::StatusCode;
use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use super::assignment_index::{ensure_active_index, index_id};
use super::assignments::{internal, require_issue_read};
use super::auth::FlexibleUser;
use super::loop_repository::{AssignmentMetadata, BindingMetadata, LoopItemRepository};
use crate::{http_compat::FastApiError, state::AppState};

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ReceiptKind {
    HumanRead,
    StandInReceived,
    StandInState,
}

#[derive(Clone, Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum DispatchState {
    Queued,
    Running,
    WaitingUser,
    Completed,
    Failed,
    Cancelled,
    BlockedPolicy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchUpdate {
    state: DispatchState,
    reason_code: Option<String>,
    observed_at: chrono::DateTime<chrono::Utc>,
    public_message_id: Option<String>,
}

#[derive(Deserialize)]
struct ReceiptInput {
    kind: ReceiptKind,
    device_id: Option<String>,
    task_id: Option<String>,
    dispatch: Option<DispatchUpdate>,
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
    ensure_active_index(&state.mysql, item_id).await?;
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
    if payload.dispatch.is_some() && payload.kind != ReceiptKind::StandInState {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Dispatch updates require a stand-in receipt",
        ));
    }
    let mut public_result = None;
    let field = match payload.kind {
        ReceiptKind::HumanRead => "human_read_at",
        ReceiptKind::StandInReceived => {
            require_personal_binding(state, item_id, assignment_id, &user, &payload).await?;
            "stand_in_received_at"
        }
        ReceiptKind::StandInState => {
            let update = payload.dispatch.as_ref().ok_or_else(|| {
                FastApiError::detail(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Dispatch state is required",
                )
            })?;
            if update.observed_at > chrono::Utc::now() + chrono::Duration::minutes(5) {
                return Err(FastApiError::detail(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Invalid observation time",
                ));
            }
            if update.state == DispatchState::BlockedPolicy || unbound_failure(&payload) {
                if update.state == DispatchState::BlockedPolicy
                    && (payload.task_id.is_some()
                        || !matches!(
                            update.reason_code.as_deref(),
                            Some("no_authorized_assistant" | "tag_mismatch")
                        ))
                {
                    return Err(FastApiError::detail(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "Invalid policy reason",
                    ));
                }
                require_owned_device(state, &user, &payload).await?;
            } else {
                require_personal_binding(state, item_id, assignment_id, &user, &payload).await?;
            }
            if update.state == DispatchState::Completed {
                public_result = Some(
                    require_public_result(state, item_id, assignment_id, &user, &payload).await?,
                );
            }
            "stand_in_received_at"
        }
    };
    // JSON_INSERT preserves the first receipt and never replaces unrelated metadata.
    // The assignment event remains immutable from the event reducer's perspective.
    let timestamp = chrono::Utc::now().to_rfc3339();
    #[derive(FromMysqlRow)]
    struct LockedRow {
        id: String,
        cloud_project_id: String,
    }
    let written = state
        .mysql
        .with_transaction(async |tx| {
            // Assignment changes take the same Issue lock; no activity range is read or locked.
            let locked: Vec<LockedRow> = tx
                .fetch_all(
                    "SELECT id,cloud_project_id FROM loop_items WHERE id = ? AND resource_type = 'task' FOR UPDATE",
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
            if let Some(update) = payload.dispatch.as_ref() {
                let previous = assignment.as_ref().and_then(ReceiptRow::metadata).and_then(|row| row.dispatch_receipt.as_ref());
                if !accept_update(previous, &payload) { return Ok(false); }
                let receipt = json!({
                    "projectId":locked[0].cloud_project_id,"issueId":item_id,
                    "humanAssignmentId":super::human_task_binding::direct_human_assignment_id(item_id,assignment_id),
                    "ownerUserId":user.id,"state":update.state,"reasonCode":update.reason_code,
                    "runtimeTaskId":payload.task_id.as_ref().map(|task|json!(task)).unwrap_or_else(||previous.map(|row|row["runtimeTaskId"].clone()).unwrap_or(Value::Null)),
                    "deviceId":payload.device_id,"deliveryId":null,"publicMessageId":public_result,
                    "observedAt":update.observed_at,"updatedAt":timestamp,
                });
                tx.execute("UPDATE loop_items SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),'$.dispatch_receipt',?) WHERE id=? AND loop_item_id=? AND resource_type='comment'",(Json(receipt),assignment_id,item_id)).await?;
            }
            if payload.dispatch.as_ref().is_some_and(|update| update.state == DispatchState::BlockedPolicy) || unbound_failure(&payload) {
                return Ok(true);
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

fn accept_update(previous: Option<&Value>, payload: &ReceiptInput) -> bool {
    let Some(update) = &payload.dispatch else {
        return true;
    };
    let Some(previous) = previous else {
        return true;
    };
    if previous["runtimeTaskId"].is_string()
        && previous["deviceId"]
            .as_str()
            .is_some_and(|device| Some(device) != payload.device_id.as_deref())
    {
        return false;
    }
    if !unbound_failure(payload)
        && previous["runtimeTaskId"]
            .as_str()
            .is_some_and(|task| Some(task) != payload.task_id.as_deref())
    {
        return false;
    }
    // A verified binding supersedes observations from devices that did not
    // accept the assignment. Their clocks cannot veto the executing device.
    if previous["runtimeTaskId"].is_null() && payload.task_id.is_some() {
        return true;
    }
    previous["observedAt"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_none_or(|at| update.observed_at >= at)
}

fn unbound_failure(payload: &ReceiptInput) -> bool {
    payload.task_id.is_none()
        && payload.dispatch.as_ref().is_some_and(|update| {
            update.state == DispatchState::Failed
                && update.reason_code.as_deref() == Some("execution_rejected")
        })
}

async fn require_owned_device(
    state: &AppState,
    user: &FlexibleUser,
    payload: &ReceiptInput,
) -> Result<(), FastApiError> {
    if crate::device_identity::resolve_owned_device_alias(
        &state.mysql,
        i64::from(user.id),
        payload.device_id.as_deref().unwrap_or_default(),
    )
    .await
    .map_err(internal)?
    .is_some()
    {
        return Ok(());
    }
    Err(FastApiError::forbidden(
        "A recipient-owned device is required",
    ))
}

async fn require_public_result(
    state: &AppState,
    item_id: &str,
    assignment_id: &str,
    user: &FlexibleUser,
    payload: &ReceiptInput,
) -> Result<String, FastApiError> {
    let id = payload
        .dispatch
        .as_ref()
        .and_then(|update| update.public_message_id.as_deref())
        .unwrap_or_default();
    #[derive(FromMysqlRow)]
    struct ResultRow {
        id: String,
    }
    let row:Option<ResultRow> = state.mysql.fetch_optional(
        // Public stand-in replies intentionally have no runtime address. Their
        // server-generated idempotency key binds the validated device and task.
        "SELECT message_id AS id FROM project_chat_messages WHERE task_id=? AND client_message_id=SHA2(CONCAT(project_id,CHAR(0),task_id,CHAR(0),?,CHAR(0),?,CHAR(0),?),256) AND JSON_EXTRACT(metadata,'$.stand_in.user_id')=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.stand_in.human_assignment_id'))=? AND status='completed'",
        (item_id,payload.device_id.as_deref().unwrap_or_default(),payload.task_id.as_deref().unwrap_or_default(),id,user.id,super::human_task_binding::direct_human_assignment_id(item_id,assignment_id)),
    ).await.map_err(internal)?;
    if let Some(row) = row {
        return Ok(row.id);
    }
    Err(FastApiError::detail(
        StatusCode::CONFLICT,
        "A published assignment result is required",
    ))
}

pub(super) async fn project_device_wait(state: &AppState, receipt: &mut Value) {
    if receipt["state"] != "queued" || !receipt["runtimeTaskId"].is_null() {
        return;
    }
    let Some(owner) = receipt["ownerUserId"].as_i64() else {
        return;
    };
    let devices:Result<Vec<crate::device_identity::DeviceKindRow>,_> = state.mysql.fetch_all(
        "SELECT id AS kinds_id,name AS kinds_name,json AS kinds_json FROM kinds WHERE kind='Device' AND namespace='default' AND user_id=? AND is_active=1",(owner,),
    ).await;
    let Ok(devices) = devices else {
        receipt["reasonCode"] = json!("presence_unavailable");
        return;
    };
    for device in devices {
        let route = crate::device_identity::device_connection_route_id(&device);
        match crate::device_online_state::read_online_state::<Value>(state, owner, &route).await {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(_) => {
                receipt["reasonCode"] = json!("presence_unavailable");
                return;
            }
        }
    }
    receipt["state"] = json!("waiting_device");
    receipt["reasonCode"] = json!("device_offline");
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
        tracing::warn!(
            user_id = user.id,
            issue_id = item_id,
            assignment_id,
            device_id,
            reason = "owned_device_not_found",
            "Stand-in assignment receipt rejected"
        );
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
                .and_then(binding_assignment_event_id)
                == Some(assignment_id)
    }) {
        Ok(())
    } else {
        tracing::warn!(
            user_id = user.id,
            issue_id = item_id,
            assignment_id,
            device_id,
            task_id = payload.task_id.as_deref().unwrap_or_default(),
            binding_count = bindings.len(),
            reason = "matching_assignment_binding_not_found",
            "Stand-in assignment receipt rejected"
        );
        Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "A recipient-owned task binding is required",
        ))
    }
}

fn binding_assignment_event_id(metadata: &BindingMetadata) -> Option<&str> {
    let id = if metadata
        .dispatch_round_id
        .as_deref()
        .is_some_and(|round| round != "direct")
    {
        metadata.issue_assignment_id.as_deref()
    } else {
        metadata.assignment_id.as_deref()
    };
    id.filter(|id| !id.is_empty())
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
    fn round_binding_receipts_require_the_issue_event_and_preserve_member_identity() {
        let mut metadata = BindingMetadata {
            dispatch_round_id: Some("round-1".into()),
            assignment_id: Some("member-work".into()),
            issue_assignment_id: Some("issue-event".into()),
            ..Default::default()
        };
        assert_eq!(binding_assignment_event_id(&metadata), Some("issue-event"));
        assert_eq!(metadata.assignment_id.as_deref(), Some("member-work"));
        metadata.issue_assignment_id = None;
        assert_eq!(binding_assignment_event_id(&metadata), None);
        metadata.dispatch_round_id = Some("direct".into());
        assert_eq!(binding_assignment_event_id(&metadata), Some("member-work"));
    }

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

    #[test]
    fn updates_cannot_replace_another_task_or_a_newer_observation() {
        let payload: ReceiptInput = serde_json::from_value(json!({
            "kind":"stand_in_state","task_id":"task", "device_id":"mac",
            "dispatch":{"state":"running","observedAt":"2026-11-17T02:00:00Z"}
        }))
        .unwrap();
        assert!(accept_update(None, &payload));
        assert!(!accept_update(
            Some(&json!({"runtimeTaskId":"other"})),
            &payload
        ));
        assert!(!accept_update(
            Some(&json!({"runtimeTaskId":"task","observedAt":"2026-11-17T03:00:00Z"})),
            &payload
        ));
        assert!(accept_update(
            Some(&json!({"runtimeTaskId":"task","observedAt":"2026-11-17T01:00:00Z"})),
            &payload
        ));
        assert!(accept_update(
            Some(
                &json!({"runtimeTaskId":null,"deviceId":"other-device","state":"blocked_policy","observedAt":"2026-11-17T02:04:00Z"})
            ),
            &payload
        ));
    }
}
