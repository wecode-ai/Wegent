//! Assignment-scoped reception receipts, independent of notification read state.
use brz_http_server::StatusCode;
use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use super::assignment_index::{ensure_active_index, index_id};
use crate::ParticipationState;
use wegent_http_compat::FastApiError;
use wegent_identity::flexible_auth::FlexibleUser;
use wegent_project_coordination::loop_tasks::item_access::assignment_error as internal;
use wegent_project_coordination::loop_tasks::loop_repository::{
    AssignmentMetadata, BindingMetadata, LoopItemRepository,
};

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

#[brz_http_server::post("/api/v1/loop-items/:item_id/assignments/:assignment_id/receipt", group = project_participation)]
async fn acknowledge_assignment(
    #[inject(state)] state: &ParticipationState,
    item_id: &str,
    assignment_id: &str,
    #[auth] user: FlexibleUser,
    payload: ReceiptInput,
) -> Result<Value, FastApiError> {
    // The existing read policy includes project membership and Issue security.
    state.support.require_issue_read(item_id, user.id).await?;
    let mysql = &state.mysql;
    ensure_active_index(mysql, item_id).await?;
    let assignment: Option<ReceiptRow> = mysql
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
    let field = match payload.kind {
        ReceiptKind::HumanRead => "human_read_at",
        ReceiptKind::StandInReceived => {
            require_personal_binding(mysql, item_id, assignment_id, &user, &payload).await?;
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
                require_owned_device(mysql, &user, &payload).await?;
            } else {
                require_personal_binding(mysql, item_id, assignment_id, &user, &payload).await?;
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
    let written = mysql
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
                let public_result = if update.state == DispatchState::Completed {
                    let Some(result) = public_result_on(tx, item_id, assignment_id, user.id, &payload).await? else { return Ok(false) };
                    Some(result)
                } else { None };
                let confirmed = if let Some(result) = &public_result {
                    confirmed_result_on(&mut &mut *tx, item_id, &result.id, &result.binding_id).await?
                } else { None };
                let delivery_id = if let (Some(result), Some(_)) = (&public_result, &confirmed) {
                    delivered_result_on(&mut &mut *tx, item_id, &wegent_project_coordination::loop_tasks::human_task_binding::direct_human_assignment_id(item_id, assignment_id), user.id, payload.task_id.as_deref().unwrap_or_default(), &result.binding_id).await?
                } else { None };
                let waiting_reason = if public_result.is_some() && confirmed.is_none() {
                    Some("awaiting_publication")
                } else if public_result.is_some() && delivery_id.is_none() {
                    Some("awaiting_delivery")
                } else { None };
                let receipt = json!({
                    "projectId":locked[0].cloud_project_id,"issueId":item_id,
                    "humanAssignmentId":wegent_project_coordination::loop_tasks::human_task_binding::direct_human_assignment_id(item_id,assignment_id),
                    "ownerUserId":user.id,"state":if waiting_reason.is_some() { json!(DispatchState::WaitingUser) } else { json!(update.state) },"reasonCode":waiting_reason.map(|reason|json!(reason)).unwrap_or_else(||json!(update.reason_code)),
                    "runtimeTaskId":payload.task_id.as_ref().map(|task|json!(task)).unwrap_or_else(||previous.map(|row|row["runtimeTaskId"].clone()).unwrap_or(Value::Null)),
                    "deviceId":payload.device_id,"deliveryId":delivery_id,"publicMessageId":public_result.map(|result|result.id),"confirmedMessageId":confirmed,
                    "observedAt":update.observed_at,"updatedAt":timestamp,
                });
                persist_dispatch_receipt(tx, item_id, assignment_id, receipt).await?;
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
            "Assignment, observation or public result is no longer valid",
        ));
    }
    Ok(json!({"acknowledged": true}))
}

pub async fn persist_dispatch_receipt<T: MysqlTransaction>(
    tx: &mut T,
    item_id: &str,
    assignment_id: &str,
    receipt: Value,
) -> brz_mysql::MysqlResult<()> {
    tx.execute(
        "UPDATE loop_items SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()), \
         '$.dispatch_receipt',CAST(? AS JSON)) \
         WHERE id=? AND loop_item_id=? AND resource_type='comment'",
        (Json(receipt), assignment_id, item_id),
    )
    .await?;
    Ok(())
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
    if previous["runtimeTaskId"]
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
    mysql: &MysqlService,
    user: &FlexibleUser,
    payload: &ReceiptInput,
) -> Result<(), FastApiError> {
    if wegent_device_identity::resolve_owned_device_alias(
        mysql,
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

#[derive(FromMysqlRow)]
struct PublicResult {
    id: String,
    binding_id: String,
}

async fn public_result_on(
    tx: &mut impl MysqlTransaction,
    item_id: &str,
    assignment_id: &str,
    user_id: i32,
    payload: &ReceiptInput,
) -> brz_mysql::MysqlResult<Option<PublicResult>> {
    let id = payload
        .dispatch
        .as_ref()
        .and_then(|update| update.public_message_id.as_deref())
        .unwrap_or_default();
    tx.fetch_optional(
        // Public stand-in replies intentionally have no runtime address. Their
        // server-generated idempotency key binds the validated device and task.
        "SELECT message_id AS id,CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.stand_in.binding_id')) AS CHAR CHARACTER SET utf8mb4) AS binding_id FROM project_chat_messages WHERE task_id=? AND client_message_id=SHA2(CONCAT(project_id,CHAR(0),task_id,CHAR(0),?,CHAR(0),?,CHAR(0),?),256) AND JSON_EXTRACT(metadata,'$.stand_in.user_id')=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.stand_in.human_assignment_id'))=? AND status='completed' AND JSON_TYPE(JSON_EXTRACT(metadata,'$.stand_in.binding_id'))='STRING' AND (deleted_at IS NULL OR deleted_at<='1970-01-02') FOR UPDATE",
        (item_id,payload.device_id.as_deref().unwrap_or_default(),payload.task_id.as_deref().unwrap_or_default(),id,user_id,wegent_project_coordination::loop_tasks::human_task_binding::direct_human_assignment_id(item_id,assignment_id)),
    ).await
}

async fn confirmed_result_on(
    query: &mut impl wegent_backend_persistence::mysql_query::MysqlQuery,
    item_id: &str,
    message_id: &str,
    binding_id: &str,
) -> brz_mysql::MysqlResult<Option<String>> {
    let row: Option<(String,)> = query.fetch_optional(
        "SELECT publication.message_id FROM project_chat_messages source JOIN project_chat_messages publication \
         ON publication.project_id=source.project_id AND publication.task_id=source.task_id \
         WHERE source.message_id=? AND source.task_id=? AND source.status='completed' \
         AND (source.deleted_at IS NULL OR source.deleted_at<='1970-01-02') \
         AND publication.status='completed' AND JSON_EXTRACT(publication.metadata,'$.assistant_publication.verified')=true \
         AND (publication.message_id=source.message_id OR \
           (publication.sender_type='user' AND publication.id>source.id \
            AND JSON_UNQUOTE(JSON_EXTRACT(publication.metadata,'$.assistant_publication.binding_id'))=?)) \
         AND (publication.deleted_at IS NULL OR publication.deleted_at<='1970-01-02') \
         ORDER BY publication.id LIMIT 1",
        (message_id, item_id, binding_id),
    ).await?;
    Ok(row.map(|row| row.0))
}

async fn delivered_result_on(
    query: &mut impl wegent_backend_persistence::mysql_query::MysqlQuery,
    item_id: &str,
    assignment_id: &str,
    owner: i32,
    task_id: &str,
    binding_id: &str,
) -> brz_mysql::MysqlResult<Option<String>> {
    let row: Option<(String,)> = query.fetch_optional(
        "SELECT delivery.id FROM loop_items delivery JOIN loop_items binding ON binding.id=delivery.source_task_binding_id \
         WHERE delivery.resource_type='delivery' AND delivery.status='delivered' AND delivery.loop_item_id=? \
         AND binding.resource_type='execution' AND binding.loop_item_id=delivery.loop_item_id \
         AND binding.task_user_id=? AND binding.task_id=? AND binding.id=? \
         AND JSON_UNQUOTE(JSON_EXTRACT(binding.metadata,'$.human_assignment_id'))=? \
         AND (binding.unlinked_at IS NULL OR binding.unlinked_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
         AND (binding.deleted_at IS NULL OR binding.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
         AND (delivery.deleted_at IS NULL OR delivery.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
         ORDER BY delivery.delivered_at DESC,delivery.created_at DESC,delivery.id DESC LIMIT 1",
        (item_id, owner, task_id, binding_id, assignment_id),
    ).await?;
    Ok(row.map(|row| row.0))
}

pub async fn project_delivery(
    mut mysql: &MysqlService,
    receipt: &mut Value,
) -> Result<(), FastApiError> {
    if receipt["state"] == "completed" && receipt["deliveryId"].as_str().is_none_or(str::is_empty) {
        receipt["state"] = json!("waiting_user");
        receipt["reasonCode"] = json!("awaiting_delivery");
    }
    if !matches!(
        receipt["reasonCode"].as_str(),
        Some("awaiting_delivery" | "awaiting_publication")
    ) {
        return Ok(());
    }
    let (Some(issue), Some(assignment), Some(owner), Some(task)) = (
        receipt["issueId"].as_str(),
        receipt["humanAssignmentId"].as_str(),
        receipt["ownerUserId"]
            .as_i64()
            .and_then(|id| i32::try_from(id).ok()),
        receipt["runtimeTaskId"].as_str(),
    ) else {
        return Ok(());
    };
    let Some(message_id) = receipt["publicMessageId"].as_str() else {
        return Ok(());
    };
    let source: Option<PublicResult> = mysql.fetch_optional(
        "SELECT message_id AS id,CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.stand_in.binding_id')) AS CHAR CHARACTER SET utf8mb4) AS binding_id FROM project_chat_messages WHERE task_id=? AND message_id=? AND JSON_TYPE(JSON_EXTRACT(metadata,'$.stand_in.binding_id'))='STRING' AND (deleted_at IS NULL OR deleted_at<='1970-01-02')",
        (issue,message_id),
    ).await.map_err(internal)?;
    let Some(source) = source else { return Ok(()) };
    let confirmed = confirmed_result_on(&mut mysql, issue, message_id, &source.binding_id)
        .await
        .map_err(internal)?;
    let Some(confirmed) = confirmed else {
        return Ok(());
    };
    let delivery = delivered_result_on(
        &mut mysql,
        issue,
        assignment,
        owner,
        task,
        &source.binding_id,
    )
    .await
    .map_err(internal)?;
    receipt["confirmedMessageId"] = json!(confirmed);
    receipt["reasonCode"] = json!("awaiting_delivery");
    if let Some(id) = delivery {
        receipt["state"] = json!("completed");
        receipt["deliveryId"] = json!(id);
        receipt["reasonCode"] = json!("delivery_published");
    }
    Ok(())
}

async fn require_personal_binding(
    mysql: &MysqlService,
    item_id: &str,
    assignment_id: &str,
    user: &FlexibleUser,
    payload: &ReceiptInput,
) -> Result<(), FastApiError> {
    let device_id = payload.device_id.as_deref().unwrap_or_default();
    if wegent_device_identity::resolve_owned_device_alias(mysql, i64::from(user.id), device_id)
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
    let identities =
        wegent_device_identity::owned_device_identity_ids(mysql, i64::from(user.id), device_id)
            .await
            .map_err(internal)?;
    let bindings = LoopItemRepository::new(mysql)
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

    #[test]
    fn unbound_start_failure_cannot_replace_an_executing_task() {
        let payload: ReceiptInput = serde_json::from_value(json!({
            "kind":"stand_in_state","device_id":"mac",
            "dispatch":{"state":"failed","reasonCode":"execution_rejected","observedAt":"2026-11-17T03:00:00Z"}
        })).unwrap();
        assert!(accept_update(None, &payload));
        assert!(!accept_update(
            Some(&json!({
                "runtimeTaskId":"task","deviceId":"mac","observedAt":"2026-11-17T02:00:00Z"
            })),
            &payload
        ));
    }
}

#[cfg(feature = "test-support")]
pub mod test_support {
    use super::*;
    pub async fn public_results_require_confirmation_and_exact_assignment_source(
        mysql: &MysqlService,
    ) -> anyhow::Result<()> {
        let assignment =
            wegent_project_coordination::loop_tasks::human_task_binding::direct_human_assignment_id(
                "root", "event",
            );
        let identity = json!({"stand_in":{"user_id":7,"human_assignment_id":assignment,"binding_id":"binding"}});
        mysql.execute("INSERT INTO project_chat_messages(message_id,client_message_id,project_id,task_id,sender_type,content,metadata) VALUES ('public',SHA2(CONCAT('1001',CHAR(0),'root',CHAR(0),'device',CHAR(0),'runtime',CHAR(0),'local-result'),256),'1001','root','agent','result',?)",(Json(identity),)).await?;
        let mut payload: ReceiptInput = serde_json::from_value(json!({
            "kind":"stand_in_state","device_id":"device","task_id":"runtime",
            "dispatch":{"state":"completed","observedAt":"2026-11-18T02:00:00Z","publicMessageId":"local-result"}
        }))?;
        mysql.with_transaction(async |tx| {
            let source = public_result_on(tx,"root","event",7,&payload).await?.expect("validated source");
            assert_eq!(source.id,"public");
            assert_eq!(source.binding_id,"binding");
            assert!(confirmed_result_on(&mut &mut *tx,"root",&source.id,&source.binding_id).await?.is_none());
            assert!(public_result_on(tx,"root","another-event",7,&payload).await?.is_none());
            assert!(public_result_on(tx,"root","event",8,&payload).await?.is_none());
            payload.device_id = Some("other-device".into());
            assert!(public_result_on(tx,"root","event",7,&payload).await?.is_none());
            tx.execute("INSERT INTO project_chat_messages(message_id,runtime_activity_key,project_id,task_id,sender_type,content,metadata) VALUES ('confirmed','confirmed','1001','root','user','confirmed result',JSON_OBJECT('assistant_publication',JSON_OBJECT('verified',true,'binding_id','another-binding')))",()).await?;
            assert!(confirmed_result_on(&mut &mut *tx,"root",&source.id,&source.binding_id).await?.is_none());
            tx.execute("UPDATE project_chat_messages SET metadata=JSON_SET(metadata,'$.assistant_publication.binding_id','binding') WHERE message_id='confirmed'",()).await?;
            assert_eq!(confirmed_result_on(&mut &mut *tx,"root",&source.id,&source.binding_id).await?.as_deref(),Some("confirmed"));
            tx.execute("UPDATE project_chat_messages SET deleted_at=UTC_TIMESTAMP(6) WHERE message_id='confirmed'",()).await?;
            assert!(confirmed_result_on(&mut &mut *tx,"root",&source.id,&source.binding_id).await?.is_none());
            tx.execute("UPDATE project_chat_messages SET metadata=JSON_SET(metadata,'$.assistant_publication',JSON_OBJECT('verified',true,'published_by','ai')) WHERE message_id='public'",()).await?;
            assert_eq!(confirmed_result_on(&mut &mut *tx,"root",&source.id,&source.binding_id).await?.as_deref(),Some("public"));
            Ok(())
        }).await?;
        Ok(())
    }

    pub async fn only_delivered_results_of_the_current_assignment_settle_receipts(
        mysql: &MysqlService,
    ) -> anyhow::Result<()> {
        mysql.with_transaction(async |tx| {
            for (id, assignment) in [("current-binding", "current"), ("old-binding", "old")] {
                wegent_project_coordination::project_store::insert(tx, "execution", json!({
                    "id":id,"cloud_project_id":"1001","loop_item_id":"root", "task_user_id":7,
                    "device_id":"device", "task_id":"runtime", "metadata":{"human_assignment_id":assignment}
                })).await?;
            }
            for (id, binding, status) in [("draft","current-binding","draft"), ("previous","old-binding","delivered")] {
                wegent_project_coordination::project_store::insert(tx, "delivery", json!({
                    "id":id,"loop_item_id":"root","source_task_binding_id":binding,"status":status
                })).await?;
            }
            assert!(delivered_result_on(&mut &mut *tx,"root","current",7,"runtime","current-binding").await?.is_none());
            tx.execute("UPDATE loop_items SET status='delivered' WHERE id='draft'",()).await?;
            assert_eq!(delivered_result_on(&mut &mut *tx,"root","current",7,"runtime","current-binding").await?.as_deref(),Some("draft"));
            assert!(delivered_result_on(&mut &mut *tx,"root","current",8,"runtime","current-binding").await?.is_none());
            assert!(delivered_result_on(&mut &mut *tx,"root","current",7,"another-runtime","current-binding").await?.is_none());
            assert!(delivered_result_on(&mut &mut *tx,"root","current",7,"runtime","old-binding").await?.is_none());
            tx.execute("UPDATE loop_items SET unlinked_at=UTC_TIMESTAMP(6) WHERE id='current-binding'",()).await?;
            assert!(delivered_result_on(&mut &mut *tx,"root","current",7,"runtime","current-binding").await?.is_none());
            Ok(())
        }).await?;
        Ok(())
    }
}
