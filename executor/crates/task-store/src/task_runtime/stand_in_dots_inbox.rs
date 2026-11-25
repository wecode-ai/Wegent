//! Transactional outcomes and send claims for the primary DingTalk delegation.
use super::*;

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
            active_delegated_source, permits_delegated_message, permits_delegated_reply,
            read_personal, stand_in_identities,
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
        let mut work = read_record(&connection, work_id, "stand_in_work")?
            .filter(|row| {
                row["userId"] == user
                    && row["roleId"] == "@primary"
                    && same_delegated_scope(&row["source"], &message["source"])
            })
            .ok_or(TaskRuntimeError::TaskNotFound)?;
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
        let Some(source) = active_delegated_source(identity, &message["source"]) else {
            return Ok(None);
        };
        if !permits_delegated_message(identity, &message["source"], &message["at"]) {
            return Ok(None);
        }
        match result["action"].as_str() {
            Some("reply" | "needs_user" | "skip") => {}
            _ => {
                return Err(TaskRuntimeError::Invalid(
                    "Invalid delegation decision".into(),
                ))
            }
        }
        if result["action"] == "reply" {
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
            }
        }
        result["policyVersion"] = identity["delegation"]["version"].clone();
        result["decidedAt"] = json!(now());
        let submit = result["action"] == "reply";
        result["status"] = json!(if submit { "submitting" } else { "complete" });
        message["dispatchStatus"] = json!(if submit { "sending" } else { "sent" });
        message["delegationResult"] = result;
        write_record(&connection, record_id, "stand_in_message", &message)?;
        refresh_work(&connection, &mut work)?;
        connection.commit()?;
        Ok(submit.then(|| source.clone()))
    }

    /// Record channel evidence without replaying an uncertain send.
    pub fn finish_delegated_submission(
        &self,
        user: i64,
        work_id: &str,
        record_id: &str,
        receipt: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(mut message) =
            read_record(&connection, record_id, "stand_in_message")?.filter(|row| {
                row["userId"] == user
                    && row["workId"] == work_id
                    && row["delegationResult"]["status"] == "submitting"
            })
        else {
            return Ok(());
        };
        let mut work = read_record(&connection, work_id, "stand_in_work")?
            .filter(|row| row["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let claim_id = reply_claim_key(user, delegated_reply_chain(&message));
        let receipt = receipt.filter(|id| !id.trim().is_empty());
        let status = if receipt.is_some() { "sent" } else { "unknown" };
        let finished_at = now();
        {
            let result = &mut message["delegationResult"];
            result["status"] = json!(status);
            result["receiptId"] = json!(receipt);
            result["finishedAt"] = json!(finished_at.clone());
        }
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
}
