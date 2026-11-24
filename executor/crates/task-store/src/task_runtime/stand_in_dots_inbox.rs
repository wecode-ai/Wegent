//! Transactional outcomes and send claims for the primary DingTalk delegation.
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
        *result =
            json!({"action":"skip","status":"complete","reason":"The owner took over this work."});
    }
    result["takenOver"] = json!(true);
}

pub(super) fn project_delegation_result(work: &Value, messages: &[Value]) -> Value {
    let mut needs_user = None;
    let mut all_skipped = !messages.is_empty();
    for message in messages {
        match message["delegationResult"]["action"].as_str() {
            Some("reply") => return projected_message_result(work, Some(message)),
            Some("needs_user") => {
                needs_user.get_or_insert(message);
                all_skipped = false;
            }
            Some("skip") => {}
            _ => all_skipped = false,
        }
    }
    projected_message_result(
        work,
        needs_user.or_else(|| all_skipped.then(|| &messages[0])),
    )
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

enum SubmissionUpdate {
    Finish,
    Reconcile,
}

impl LocalTaskStore {
    /// Read an exact source event from an owned delegated work item.
    pub fn delegated_work_message(
        &self,
        user: i64,
        work_id: &str,
        record_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let work = delegated_work(&connection, user, work_id)?;
        read_record(&connection, record_id, "stand_in_message")?
            .filter(|row| {
                row["userId"] == user
                    && row["workId"] == work_id
                    && row["roleId"] == "@primary"
                    && same_delegated_scope(&work["source"], &row["source"])
            })
            .ok_or(TaskRuntimeError::TaskNotFound)
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
            active_delegated_source, permits_delegated_reply, read_personal, stand_in_identities,
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
            let replied = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM loop_items WHERE resource_type='stand_in_message'
                 AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.workId')=?2
                 AND json_extract(metadata,'$.delegationResult.action')='reply')",
                params![user, work_id],
                |row| row.get::<_, bool>(0),
            )?;
            if replied {
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
        if submit {
            result["submittedAt"] = result["decidedAt"].clone();
        }
        result["status"] = json!(if submit { "submitting" } else { "complete" });
        message["dispatchStatus"] = json!(if submit { "sending" } else { "sent" });
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
        work_id: &str,
        record_id: &str,
        outcome: &Value,
    ) -> Result<(), TaskRuntimeError> {
        self.record_delegated_outcome(
            user,
            work_id,
            record_id,
            outcome,
            SubmissionUpdate::Reconcile,
        )
    }

    fn record_delegated_outcome(
        &self,
        user: i64,
        work_id: &str,
        record_id: &str,
        outcome: &Value,
        update: SubmissionUpdate,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let reconcile = matches!(update, SubmissionUpdate::Reconcile);
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
        let result = &mut message["delegationResult"];
        result["status"] = json!(status);
        result["recordId"] = json!(record_id);
        result["receiptId"] = json!(receipt.filter(|_| status == "sent"));
        if let Some(task) = nonempty_id(&outcome["channelTaskId"]) {
            result["channelTaskId"] = json!(task);
        }
        result["deliveryReason"] = json!(outcome["reason"].as_str());
        result["deliveryReasonCode"] = json!(nonempty_id(&outcome["reasonCode"]));
        result["finishedAt"] = json!(now());
        message["dispatchStatus"] = json!("sent");
        write_record(&connection, record_id, "stand_in_message", &message)?;
        refresh_work(&connection, &mut work)?;
        connection.commit()?;
        Ok(())
    }

    /// The user's takeover is independent of any pending or recorded channel result.
    pub fn take_over_delegated_work(
        &self,
        user: i64,
        work_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut work = delegated_work(&connection, user, work_id)?;
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
