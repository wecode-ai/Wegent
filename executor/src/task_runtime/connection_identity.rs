//! Device-private account epochs make offline evidence unusable across account changes.
use super::*;

impl LocalTaskStore {
    pub fn connection_identity(
        &self,
        device: &str,
    ) -> Result<(i64, Option<String>), TaskRuntimeError> {
        let record = get_item_from(
            &*self.connection()?,
            &format!("connection-identity:{device}"),
            "connection_identity",
        )?
        .map(|row| row.metadata)
        .unwrap_or(Value::Null);
        Ok((
            record["generation"].as_i64().unwrap_or(0),
            record["fingerprint"].as_str().map(str::to_owned),
        ))
    }

    pub fn update_connection_identity(
        &self,
        device: &str,
        fingerprint: Option<&str>,
    ) -> Result<i64, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = format!("connection-identity:{device}");
        let previous = get_item_from(&connection, &id, "connection_identity")?
            .map(|row| row.metadata)
            .unwrap_or(Value::Null);
        let mut generation = previous["generation"].as_i64().unwrap_or(0);
        if previous["fingerprint"].as_str() != fingerprint {
            generation += 1;
            connection.execute(
                "DELETE FROM loop_items WHERE id=?1 AND resource_type='verified_connection_user'",
                params![format!("verified-connection-user:{device}")],
            )?;
        }
        super::stand_in_processing::write(
            &connection,
            "connection_identity",
            &json!({"id":id,"generation":generation,"fingerprint":fingerprint}),
        )?;
        connection.commit()?;
        Ok(generation)
    }

    pub fn remember_connection_user(
        &self,
        device: &str,
        fingerprint: &str,
        user: i64,
        generation: i64,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = get_item_from(
            &connection,
            &format!("connection-identity:{device}"),
            "connection_identity",
        )?
        .ok_or(TaskRuntimeError::VersionConflict)?
        .metadata;
        if current["generation"] != generation || current["fingerprint"] != fingerprint {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let record = json!({"id":format!("verified-connection-user:{device}"),"userId":user,"fingerprint":fingerprint,"generation":generation});
        super::stand_in_processing::write(&connection, "verified_connection_user", &record)?;
        connection.commit()?;
        Ok(())
    }

    pub fn verified_connection_user(
        &self,
        device: &str,
        fingerprint: &str,
    ) -> Result<Option<i64>, TaskRuntimeError> {
        let connection = self.connection()?;
        let identity = get_item_from(
            &connection,
            &format!("connection-identity:{device}"),
            "connection_identity",
        )?
        .map(|row| row.metadata)
        .unwrap_or(Value::Null);
        Ok(get_item_from(
            &connection,
            &format!("verified-connection-user:{device}"),
            "verified_connection_user",
        )?
        .filter(|row| {
            row.metadata["fingerprint"] == fingerprint
                && row.metadata["generation"] == identity["generation"]
                && identity["fingerprint"] == fingerprint
        })
        .and_then(|row| row.metadata["userId"].as_i64()))
    }

    pub fn forget_connection_user(&self, device: &str) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = format!("connection-identity:{device}");
        if let Some(current) = get_item_from(&connection, &id, "connection_identity")? {
            let mut identity = current.metadata;
            identity["generation"] = json!(identity["generation"].as_i64().unwrap_or(0) + 1);
            super::stand_in_processing::write(&connection, "connection_identity", &identity)?;
        }
        connection.execute(
            "DELETE FROM loop_items WHERE id=?1 AND resource_type='verified_connection_user'",
            params![format!("verified-connection-user:{device}")],
        )?;
        connection.commit()?;
        Ok(())
    }
}
