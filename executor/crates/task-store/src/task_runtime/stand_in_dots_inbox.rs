//! Transactional outcomes and send claims for the primary DingTalk delegation.
use super::super::personal_stand_in::{matches_delegation_account, read_personal};
use super::*;

fn delegated_work(
    connection: &Connection,
    user: i64,
    work_id: &str,
) -> Result<Value, TaskRuntimeError> {
    read_record(connection, work_id, "stand_in_work")?
        .filter(|row| {
            row["userId"] == user
                && row["roleId"] == "@primary"
                && row["source"]["delegated"] == true
        })
        .ok_or(TaskRuntimeError::TaskNotFound)
}

fn nonempty_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| !id.trim().is_empty() && id.len() <= 512)
}

pub(super) fn mark_delegation_taken_over(result: &mut Value) {
    if result.is_null() {
        *result = json!({
            "action":"skip",
            "status":"complete",
            "reason":"The owner took over this work.",
            "reasonCode":"owner_intervened"
        });
    }
    result["takenOver"] = json!(true);
}

/// Summarize delegation using the visible messages in oldest-first order.
pub fn project_delegation_result(work: &Value, messages: &[Value]) -> Value {
    let mut owner_intervention = None;
    let mut all_skipped = !messages.is_empty();
    for message in messages.iter().rev() {
        let result = &message["delegationResult"];
        match result["action"].as_str() {
            Some("reply" | "needs_user") => return projected_message_result(work, Some(message)),
            Some("skip") => {
                if result["reasonCode"] == "owner_intervened"
                    || (result["reasonCode"].is_null()
                        && result["reason"] == "The account owner already responded.")
                {
                    owner_intervention.get_or_insert(message);
                }
            }
            _ => all_skipped = false,
        }
    }
    let fallback = all_skipped
        .then(|| owner_intervention.or_else(|| messages.last()))
        .flatten();
    projected_message_result(work, fallback)
}

fn expired_boundary_reason(identity: &Value, source: &Value) -> (&'static str, &'static str) {
    let policy = &identity["delegation"];
    if policy["authorized"] != true {
        return (
            "delegation_inactive",
            "The message arrived outside an active DingTalk delegation and was not answered automatically.",
        );
    }
    if policy["paused"] == true {
        return (
            "delegation_paused",
            "Delegation was paused when this message was waiting. It was not answered automatically.",
        );
    }
    match super::personal_stand_in::stand_in_connection(identity, source) {
        None => (
            "source_scope_removed",
            "This DingTalk source is outside the current delegation scope and was not answered automatically.",
        ),
        Some(current) if current["paused"] == true => (
            "source_paused",
            "This DingTalk source was paused while the message was waiting. It was not answered automatically.",
        ),
        Some(_) => (
            "delegation_boundary_exceeded",
            "The message arrived before the current delegation boundary and was not answered automatically.",
        ),
    }
}

/// Close only unsent messages that the current pause or scope boundary no longer permits.
/// A submission already marked sending has an unknown external outcome and must remain intact.
pub(crate) fn expire_unsent_delegated_messages(
    connection: &Connection,
    user: i64,
    settings: &Value,
) -> Result<(), TaskRuntimeError> {
    let identities = super::personal_stand_in::stand_in_identities(settings);
    let Some(identity) = identities
        .iter()
        .find(|identity| identity["id"] == "@primary")
    else {
        return Ok(());
    };
    let rows = {
        let mut statement = connection.prepare(
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_message'
             AND json_extract(metadata,'$.userId')=?1
             AND json_extract(metadata,'$.roleId')='@primary'
             AND json_extract(metadata,'$.source.delegated')=1
             AND json_extract(metadata,'$.dispatchStatus')='pending'
             AND json_extract(metadata,'$.delegationResult') IS NULL",
        )?;
        let queued = statement
            .query_map(params![user], |row| row.get::<_, String>(0))?
            .map(|row| {
                serde_json::from_str::<Value>(&row?)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        queued
    };
    for mut message in rows {
        if super::personal_stand_in::permits_delegated_message(
            identity,
            &message["source"],
            &message["at"],
        ) {
            continue;
        }
        let (reason_code, reason) = expired_boundary_reason(identity, &message["source"]);
        let record_id = message["recordId"].as_str().unwrap_or_default().to_owned();
        message["delegationResult"] = json!({
            "action":"skip",
            "status":"complete",
            "reason":reason,
            "reasonCode":reason_code,
            "recordId":record_id,
            "policyVersion":identity["delegation"]["version"],
            "decidedAt":now(),
        });
        message["dispatchStatus"] = json!("sent");
        write_record(connection, &record_id, "stand_in_message", &message)?;
        if let Some(mut work) = read_record(
            connection,
            message["workId"].as_str().unwrap_or_default(),
            "stand_in_work",
        )?
        .filter(|work| work["userId"] == user)
        {
            refresh_work(connection, &mut work)?;
        }
    }
    Ok(())
}

fn projected_message_result(work: &Value, message: Option<&Value>) -> Value {
    let mut result = message.map_or(Value::Null, |row| row["delegationResult"].clone());
    if !work["takenOverAt"].is_null() || message.is_some_and(|row| !row["takenOverAt"].is_null()) {
        mark_delegation_taken_over(&mut result);
    }
    if result.is_object() {
        if let Some(row) = message {
            result["recordId"] = row["recordId"].clone();
        }
    }
    result
}

enum SubmissionUpdate<'a> {
    Finish,
    Reconcile { device: &'a str },
}

const REPLY_CLAIM_KIND: &str = "stand_in_delegation_reply_claim";

fn reply_claim_key(user: i64, chain: &Value) -> String {
    stand_in_record_key("stand-in-delegation-reply-claim", &json!([user, chain]))
}

pub(super) fn delegated_reply_chain(message: &Value) -> &Value {
    // Older messages retain their initial grouping when they are moved.
    message
        .get("delegationChainId")
        .or_else(|| message.get("originalWorkId"))
        .unwrap_or(&message["workId"])
}

impl LocalTaskStore {
    /// Read an exact source event from an owned delegated work item.
    pub fn delegated_work_message(
        &self,
        user: i64,
        device: &str,
        work_id: &str,
        record_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let snapshot = guard.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let work = delegated_work(&snapshot, user, work_id)?;
        let settings = read_personal(&snapshot, user, device)?;
        let message = read_record(&snapshot, record_id, "stand_in_message")?
            .filter(|row| {
                row["userId"] == user
                    && row["workId"] == work_id
                    && row["roleId"] == "@primary"
                    && same_delegated_scope(&work["source"], &row["source"])
                    && matches_delegation_account(&settings, &row["roleId"], &row["source"])
            })
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        snapshot.commit()?;
        Ok(message)
    }

    /// Claim one scoped channel send or record a terminal local decision.
    pub fn record_delegation_decision(
        &self,
        user: i64,
        device: &str,
        work_id: &str,
        record_id: &str,
        mut result: Value,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        use super::super::personal_stand_in::{
            active_delegated_source, permits_delegated_reply, stand_in_identities,
        };

        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(mut message) =
            read_record(&connection, record_id, "stand_in_message")?.filter(|row| {
                row["userId"] == user
                    && row["workId"] == work_id
                    && row["roleId"] == "@primary"
                    && row["dispatchStatus"] == "pending"
                    && row["delegationResult"].is_null()
            })
        else {
            return Ok(None);
        };
        let mut work = delegated_work(&connection, user, work_id)?;
        if !same_delegated_scope(&work["source"], &message["source"]) {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        if !work["takenOverAt"].is_null() || !message["takenOverAt"].is_null() {
            return Ok(None);
        }
        let settings = read_personal(&connection, user, device)?;
        if settings["executionDeviceId"] != device
            || !matches_delegation_account(&settings, &message["roleId"], &message["source"])
            || matches!(
                settings["lifecycle"]["status"].as_str(),
                Some("stopping" | "stopped")
            )
        {
            return Ok(None);
        }
        let identities = stand_in_identities(&settings);
        let Some(identity) = identities
            .iter()
            .find(|identity| identity["id"] == "@primary")
        else {
            return Ok(None);
        };
        match result["action"].as_str() {
            Some("reply" | "needs_user" | "skip") => {}
            _ => {
                return Err(TaskRuntimeError::Invalid(
                    "Invalid delegation decision".into(),
                ))
            }
        }
        // A declined action can explain a revoked grant without ever claiming a send.
        let claim = if result["action"] == "reply" {
            let Some(source) = active_delegated_source(identity, &message["source"]) else {
                return Ok(None);
            };
            if nonempty_id(&result["attemptId"]).is_none() {
                return Err(TaskRuntimeError::Invalid(
                    "Missing delegation attempt ID".into(),
                ));
            }
            if result["policyVersion"] != identity["delegation"]["version"] {
                return Ok(None);
            }
            let template = result["template"].as_str().unwrap_or_default();
            if !permits_delegated_reply(identity, &message["source"], template, &message["at"]) {
                return Ok(None);
            }
            let chain = delegated_reply_chain(&message);
            let claim_id = reply_claim_key(user, chain);
            let claimed_at = now();
            let inserted = connection.execute(
                "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?4) ON CONFLICT(id) DO NOTHING",
                params![
                    claim_id,
                    REPLY_CLAIM_KIND,
                    json!({
                        "userId":user,
                        "chainId":chain,
                        "messageId":record_id,
                        "workId":work_id,
                        "template":template,
                        "policyVersion":identity["delegation"]["version"],
                        "status":"submitting",
                        "createdAt":claimed_at.clone(),
                    })
                    .to_string(),
                    claimed_at,
                ],
            )?;
            if inserted == 0 {
                result = json!({"action":"skip","status":"complete","reason":"This reply chain already has a reply attempt."});
                None
            } else {
                Some(source.clone())
            }
        } else {
            None
        };
        result["policyVersion"] = identity["delegation"]["version"].clone();
        result["recordId"] = json!(record_id);
        result["decidedAt"] = json!(now());
        let submit = claim.is_some();
        let terminal_failure = !submit && result["status"] == "failed";
        if submit {
            result["submittedAt"] = result["decidedAt"].clone();
        }
        result["status"] = json!(if submit {
            "submitting"
        } else if terminal_failure {
            "failed"
        } else {
            "complete"
        });
        message["dispatchStatus"] = json!(if submit {
            "sending"
        } else if terminal_failure {
            "failed"
        } else {
            "sent"
        });
        message["delegationResult"] = result;
        write_record(&connection, record_id, "stand_in_message", &message)?;
        refresh_work(&connection, &mut work)?;
        connection.commit()?;
        Ok(claim)
    }

    /// Record channel evidence without replaying an uncertain send.
    pub fn finish_delegated_submission(
        &self,
        user: i64,
        work_id: &str,
        record_id: &str,
        outcome: &Value,
    ) -> Result<(), TaskRuntimeError> {
        self.record_delegated_outcome(user, work_id, record_id, outcome, SubmissionUpdate::Finish)
    }

    /// Apply a read-only status check only to the same uncertain channel attempt.
    pub fn reconcile_delegated_receipt(
        &self,
        user: i64,
        device: &str,
        work_id: &str,
        record_id: &str,
        outcome: &Value,
    ) -> Result<(), TaskRuntimeError> {
        self.record_delegated_outcome(
            user,
            work_id,
            record_id,
            outcome,
            SubmissionUpdate::Reconcile { device },
        )
    }

    fn record_delegated_outcome(
        &self,
        user: i64,
        work_id: &str,
        record_id: &str,
        outcome: &Value,
        update: SubmissionUpdate<'_>,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let reconcile = matches!(update, SubmissionUpdate::Reconcile { .. });
        let previous_status = if reconcile { "unknown" } else { "submitting" };
        let Some(mut message) =
            read_record(&connection, record_id, "stand_in_message")?.filter(|row| {
                row["userId"] == user
                    && row["workId"] == work_id
                    && row["roleId"] == "@primary"
                    && row["delegationResult"]["status"] == previous_status
                    && row["delegationResult"]["attemptId"] == outcome["attemptId"]
            })
        else {
            return Ok(());
        };
        let mut work = delegated_work(&connection, user, work_id)?;
        if !same_delegated_scope(&work["source"], &message["source"]) {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        if let SubmissionUpdate::Reconcile { device } = update {
            let settings = read_personal(&connection, user, device)?;
            if !matches_delegation_account(&settings, &message["roleId"], &message["source"]) {
                return Err(TaskRuntimeError::TaskNotFound);
            }
        }
        if reconcile
            && (nonempty_id(&outcome["channelTaskId"]).is_none()
                || message["delegationResult"]["channelTaskId"] != outcome["channelTaskId"])
        {
            return Ok(());
        }
        let receipt = nonempty_id(&outcome["receiptId"]);
        let status = match outcome["status"].as_str() {
            Some("sent") if receipt.is_some_and(|id| message["id"] != id) => "sent",
            Some("failed") => "failed",
            Some("unknown") if reconcile => return Ok(()),
            Some("unknown") => "unknown",
            _ => {
                return Err(TaskRuntimeError::Invalid(
                    "Invalid delegation delivery outcome".into(),
                ))
            }
        };
        let claim_id = reply_claim_key(user, delegated_reply_chain(&message));
        let finished_at = now();
        let result = &mut message["delegationResult"];
        result["status"] = json!(status);
        result["recordId"] = json!(record_id);
        result["receiptId"] = json!(receipt.filter(|_| status == "sent"));
        if let Some(task) = nonempty_id(&outcome["channelTaskId"]) {
            result["channelTaskId"] = json!(task);
        }
        result["deliveryReason"] = json!(outcome["reason"].as_str());
        result["deliveryReasonCode"] = json!(nonempty_id(&outcome["reasonCode"]));
        result["finishedAt"] = json!(finished_at.clone());
        message["dispatchStatus"] = json!("sent");
        write_record(&connection, record_id, "stand_in_message", &message)?;
        if let Some(mut claim) = read_record(&connection, &claim_id, REPLY_CLAIM_KIND)? {
            claim["status"] = json!(status);
            claim["receiptId"] = json!(receipt);
            claim["finishedAt"] = json!(finished_at);
            write_record(&connection, &claim_id, REPLY_CLAIM_KIND, &claim)?;
        }
        refresh_work(&connection, &mut work)?;
        connection.commit()?;
        Ok(())
    }

    /// The user's takeover is independent of any pending or recorded channel result.
    pub fn take_over_delegated_work(
        &self,
        user: i64,
        device: &str,
        work_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut work = delegated_work(&connection, user, work_id)?;
        let settings = read_personal(&connection, user, device)?;
        let messages = read_stand_in_messages(&connection, user, work_id)?;
        if !matches_delegation_account(&settings, &work["roleId"], &work["source"])
            || messages.is_empty()
            || messages.iter().any(|message| {
                message["roleId"] != "@primary"
                    || !same_delegated_scope(&work["source"], &message["source"])
            })
        {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        if work["takenOverAt"].is_null() {
            work["takenOverAt"] = json!(now());
            mark_delegation_taken_over(&mut work["delegationResult"]);
            if work["status"] != "sending" {
                work["status"] = json!("sent");
            }
            work["updatedAt"] = work["takenOverAt"].clone();
            write_record(&connection, work_id, "stand_in_work", &work)?;
        }
        connection.commit()?;
        Ok(work)
    }
}
