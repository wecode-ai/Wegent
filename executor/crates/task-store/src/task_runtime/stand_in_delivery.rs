//! Serialize channel-attempt claims with the settings and work that authorize them.
use super::personal_stand_in::read_personal;
use super::stand_in_inbox::stand_in_reply_target;
use super::*;

const RESOURCE_TYPE: &str = "stand_in_delivery";

/// A read-only view of the authorization records in the delivery claim transaction.
pub struct StandInDeliveryTransaction<'a>(&'a Connection);

impl StandInDeliveryTransaction<'_> {
    pub fn personal_stand_in(&self, user: i64, device: &str) -> Result<Value, TaskRuntimeError> {
        read_personal(self.0, user, device)
    }

    pub fn reply_target(
        &self,
        user: i64,
        work_id: &str,
        record_id: &str,
    ) -> Result<(Value, Value), TaskRuntimeError> {
        stand_in_reply_target(self.0, user, work_id, record_id)
    }
}

impl LocalTaskStore {
    pub fn stand_in_reply_target(
        &self,
        user: i64,
        work_id: &str,
        record_id: &str,
    ) -> Result<(Value, Value), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let result = stand_in_reply_target(&transaction, user, work_id, record_id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn reserve_stand_in_delivery<E>(
        &self,
        id: &str,
        record: &mut Value,
        final_gate: impl FnOnce(&StandInDeliveryTransaction<'_>) -> Result<(), E>,
    ) -> Result<Result<Option<Value>, E>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(record) = read_delivery(&transaction, id)? {
            return Ok(Ok(Some(record)));
        }
        if let Err(error) = final_gate(&StandInDeliveryTransaction(&transaction)) {
            return Ok(Err(error));
        }
        let submitted_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        record["submittedAt"] = json!(submitted_at);
        record["updatedAt"] = json!(submitted_at);
        transaction.execute(
            "INSERT INTO loop_items (id, resource_type, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![
                storage_key(id),
                RESOURCE_TYPE,
                record.to_string(),
                submitted_at
            ],
        )?;
        transaction.commit()?;
        Ok(Ok(None))
    }

    pub fn read_stand_in_delivery(&self, id: &str) -> Result<Option<Value>, TaskRuntimeError> {
        read_delivery(&*self.connection()?, id)
    }

    pub fn write_stand_in_delivery_result(
        &self,
        id: &str,
        record: &Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = transaction.execute(
            "UPDATE loop_items SET metadata = ?2, updated_at = ?3
             WHERE id = ?1 AND resource_type = ?4
             AND json_extract(metadata, '$.status') = 'unknown'",
            params![
                storage_key(id),
                record.to_string(),
                record["updatedAt"].as_str(),
                RESOURCE_TYPE
            ],
        )?;
        let result = if updated == 0 {
            read_delivery(&transaction, id)?.ok_or(TaskRuntimeError::TaskNotFound)?
        } else {
            record.clone()
        };
        transaction.commit()?;
        Ok(result)
    }
}

fn read_delivery(connection: &Connection, id: &str) -> Result<Option<Value>, TaskRuntimeError> {
    Ok(get_item_from(connection, &storage_key(id), RESOURCE_TYPE)?.map(|row| row.metadata))
}

fn storage_key(id: &str) -> String {
    format!("stand-in-delivery:{id}")
}
