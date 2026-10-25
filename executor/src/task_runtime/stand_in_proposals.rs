//! Conversation-generated settings remain drafts until an explicit host confirmation.
use super::personal_stand_in::read_personal;
use super::*;

fn proposal_key(user: i64, role: Option<&str>) -> String {
    format!(
        "stand-in-proposal:{user}:{}",
        role.map(|id| format!("role:{id}"))
            .unwrap_or_else(|| "primary".into())
    )
}

impl LocalTaskStore {
    pub fn stand_in_proposal(
        &self,
        user: i64,
        role: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut proposal =
            get_item_from(&connection, &proposal_key(user, role), "stand_in_proposal")?
                .map(|row| row.metadata)
                .filter(|value| value["status"] == "pending")
                .unwrap_or(Value::Null);
        if proposal.is_object() {
            super::personal_stand_in::migrate_connections(&mut proposal["settings"])?;
        }
        Ok(proposal)
    }

    pub fn propose_stand_in_settings(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        summary: &str,
        mut settings: Value,
    ) -> Result<Value, TaskRuntimeError> {
        super::personal_stand_in::migrate_connections(&mut settings)?;
        if summary.trim().is_empty() || summary.len() > 4000 {
            return Err(TaskRuntimeError::Invalid(
                "proposal summary is required".into(),
            ));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_personal(&connection, user, device)?;
        if let Some(role) = role {
            let other_roles = |settings: &Value| {
                settings["roles"].as_array().map(|rows| {
                    rows.iter()
                        .filter(|row| row["id"] != role)
                        .cloned()
                        .collect::<Vec<_>>()
                })
            };
            if previous["primary"] != settings["primary"]
                || previous["autoSelect"] != settings["autoSelect"]
                || other_roles(&previous) != other_roles(&settings)
            {
                return Err(TaskRuntimeError::Invalid(
                    "A role can only propose changes to itself".into(),
                ));
            }
        }
        // Validate with the same writer, then roll back its savepoint. Nothing is enabled.
        connection.execute_batch("SAVEPOINT validate_stand_in_proposal")?;
        self.save_personal_stand_in_on(&connection, user, device, settings.clone())?;
        connection.execute_batch(
            "ROLLBACK TO validate_stand_in_proposal; RELEASE validate_stand_in_proposal",
        )?;
        let proposal = json!({"id":Uuid::new_v4().to_string(),"userId":user,"roleId":role,"summary":summary,"settings":settings,"status":"pending"});
        connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_proposal',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at", params![proposal_key(user,role),proposal.to_string(),now()])?;
        connection.commit()?;
        Ok(proposal)
    }

    pub fn resolve_stand_in_proposal(
        &self,
        user: i64,
        device: &str,
        id: &str,
        accept: bool,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = connection.prepare("SELECT id,metadata FROM loop_items WHERE resource_type='stand_in_proposal' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.id')=?2")?;
        let (key, raw): (String, String) =
            statement.query_row(params![user, id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        drop(statement);
        let mut proposal: Value = serde_json::from_str(&raw)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        if proposal["status"] != "pending" {
            return Err(TaskRuntimeError::Invalid(
                "Proposal is no longer pending".into(),
            ));
        }
        let saved = if accept {
            self.save_personal_stand_in_on(&connection, user, device, proposal["settings"].clone())?
        } else {
            read_personal(&connection, user, device)?
        };
        proposal["status"] = json!(if accept { "accepted" } else { "rejected" });
        connection.execute(
            "UPDATE loop_items SET metadata=?1,updated_at=?2 WHERE id=?3",
            params![proposal.to_string(), now(), key],
        )?;
        connection.commit()?;
        Ok(saved)
    }
}
