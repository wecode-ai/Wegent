//! Minimal, owner-manageable negative memories; never retain source documents.
use super::*;

pub(super) fn suppress_memory(
    connection: &Connection,
    user: i64,
    row: &Value,
) -> Result<(), TaskRuntimeError> {
    let key = forgotten_key(
        user,
        &row["scope"],
        row["content"].as_str().unwrap_or_default(),
    );
    let id = key.replace("stand-in-forgotten:", "stand-in-forgetting-rule:");
    let timestamp = now();
    let mut keys = vec![key];
    keys.extend(forgotten_evidence_key(user, &row["evidence"]));
    let previous = get_item_from(connection, &id, "stand_in_memory_rule")?;
    if let Some(previous) = &previous {
        for key in previous.metadata["fingerprints"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(key) = key.as_str() {
                if !keys.iter().any(|value| value == key) {
                    keys.push(key.to_owned());
                }
            }
        }
    }
    for key in &keys {
        connection.execute(
            "INSERT OR IGNORE INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_memory_tombstone',?2,?3,?3)",
            params![key, json!({"userId":user,"forgottenAt":timestamp}).to_string(), timestamp],
        )?;
    }
    // The compact fact is the negative match target, not an active memory.
    // Do not copy sourceTaskId, evidence, excerpts, documents or raw messages.
    let rule = json!({"id":id,"userId":user,"kind":"forgetting_rule","scope":row["scope"],
        "content":row["content"],"fingerprints":keys,
        "version":previous.as_ref().and_then(|row| row.metadata["version"].as_i64()).unwrap_or(0)+1,
        "createdAt":previous.as_ref().map(|row| row.metadata["createdAt"].clone()).unwrap_or(json!(timestamp)),"updatedAt":timestamp});
    connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_memory_rule',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",params![id,rule.to_string(),timestamp])?;
    Ok(())
}

pub(super) fn remove_rule(
    connection: &Connection,
    user: i64,
    rule: &Value,
) -> Result<(), TaskRuntimeError> {
    connection.execute("DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_memory_rule' AND json_extract(metadata,'$.userId')=?2",params![rule["id"].as_str(),user])?;
    for key in rule["fingerprints"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        // Another retained rule may still need this shared evidence fingerprint.
        let referenced: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM loop_items, json_each(loop_items.metadata,'$.fingerprints') AS fingerprint WHERE resource_type='stand_in_memory_rule' AND json_extract(metadata,'$.userId')=?1 AND fingerprint.value=?2)",params![user,key],|row| row.get(0))?;
        if !referenced {
            connection.execute("DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_memory_tombstone' AND json_extract(metadata,'$.userId')=?2", params![key,user])?;
        }
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn stand_in_memory_rules(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory_rule' AND json_extract(metadata,'$.userId')=?1 ORDER BY updated_at DESC,id")?;
        let rows = statement.query_map(params![user], |row| row.get::<_, String>(0))?;
        rows.map(|raw| {
            let mut row: Value = serde_json::from_str(&raw?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            row.as_object_mut().unwrap().remove("fingerprints");
            Ok(row)
        })
        .collect()
    }

    /// Owner management includes unscoped legacy fingerprints, never model recall.
    pub fn stand_in_memory_rule_records(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let mut records = self.stand_in_memory_rules(user)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT id,metadata FROM loop_items AS tombstone WHERE resource_type='stand_in_memory_tombstone' AND json_extract(metadata,'$.userId')=?1 AND NOT EXISTS (SELECT 1 FROM loop_items AS rule,json_each(rule.metadata,'$.fingerprints') AS fingerprint WHERE rule.resource_type='stand_in_memory_rule' AND json_extract(rule.metadata,'$.userId')=?1 AND fingerprint.value=tombstone.id) ORDER BY updated_at DESC,id")?;
        let rows = statement.query_map(params![user], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, raw) = row?;
            let metadata: Value = serde_json::from_str(&raw)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            records.push(json!({"id":id,"kind":"legacy_fingerprint","version":1,
                "updatedAt":metadata["forgottenAt"]}));
        }
        Ok(records)
    }

    pub fn recall_stand_in_memory_rules(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        source: Option<&Value>,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        self.recall_stand_in_rows(
            user,
            device,
            role,
            source,
            self.stand_in_memory_rules(user)?,
        )
    }

    pub fn delete_stand_in_memory_rule(
        &self,
        user: i64,
        id: &str,
        version: i64,
        expected_updated_at: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if id.starts_with("stand-in-forgotten:") {
            let previous = get_item_from(&connection, id, "stand_in_memory_tombstone")?
                .filter(|row| {
                    row.metadata["userId"] == user
                        && version == 1
                        && expected_updated_at.is_some()
                        && row.metadata["forgottenAt"].as_str() == expected_updated_at
                })
                .ok_or(TaskRuntimeError::VersionConflict)?;
            let referenced: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM loop_items AS rule,json_each(rule.metadata,'$.fingerprints') AS fingerprint WHERE rule.resource_type='stand_in_memory_rule' AND json_extract(rule.metadata,'$.userId')=?1 AND fingerprint.value=?2)", params![user,id], |row| row.get(0))?;
            if referenced {
                return Err(TaskRuntimeError::VersionConflict);
            }
            connection.execute("DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_memory_tombstone' AND json_extract(metadata,'$.userId')=?2",params![previous.id,user])?;
            connection.commit()?;
            return Ok(());
        }
        let previous = get_item_from(&connection, id, "stand_in_memory_rule")?
            .filter(|row| row.metadata["userId"] == user && row.metadata["version"] == version)
            .ok_or(TaskRuntimeError::VersionConflict)?;
        remove_rule(&connection, user, &previous.metadata)?;
        connection.commit()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "stand_in_memory_rules_tests.rs"]
mod tests;
