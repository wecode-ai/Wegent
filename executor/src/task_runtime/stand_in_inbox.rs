//! Durable source cursors, message deduplication and role-owned work associations.
use super::*;
use sha2::{Digest, Sha256};

enum MessageGrouping<'a> {
    Known(Option<&'a str>),
    Uncertain(Option<&'a str>),
}

pub(crate) fn stand_in_record_key(prefix: &str, value: &Value) -> String {
    format!(
        "{prefix}:{:x}",
        Sha256::digest(value.to_string().as_bytes())
    )
}

fn read_record(
    connection: &Connection,
    id: &str,
    kind: &str,
) -> Result<Option<Value>, TaskRuntimeError> {
    Ok(get_item_from(connection, id, kind)?.map(|row| row.metadata))
}

fn write_record(
    connection: &Connection,
    id: &str,
    kind: &str,
    value: &Value,
) -> Result<(), TaskRuntimeError> {
    connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",params![id,kind,value.to_string(),now()])?;
    Ok(())
}

fn find_message(
    connection: &Connection,
    user: i64,
    role: &str,
    source: &Value,
    message: &str,
) -> Result<Option<Value>, TaskRuntimeError> {
    let raw: Option<String> = connection.query_row(
        "SELECT metadata FROM loop_items WHERE resource_type='stand_in_message'
         AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.roleId')=?2
         AND json_extract(metadata,'$.source.profile')=?3 AND json_extract(metadata,'$.source.kind')=?4
         AND json_extract(metadata,'$.source.id')=?5 AND json_extract(metadata,'$.id')=?6 LIMIT 1",
        params![user, role, source["profile"].as_str(), source["kind"].as_str(), source["id"].as_str(), message],
        |row| row.get(0),
    ).optional()?;
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
    })
    .transpose()
}

fn refresh_work(connection: &Connection, work: &mut Value) -> Result<(), TaskRuntimeError> {
    let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_message' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.workId')=?2 ORDER BY created_at DESC,id DESC")?;
    let rows = statement.query_map(
        params![work["userId"].as_i64(), work["id"].as_str()],
        |row| row.get::<_, String>(0),
    )?;
    let messages = rows
        .map(|raw| {
            serde_json::from_str::<Value>(&raw?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    work["messageCount"] = json!(messages.len());
    work["latestMessage"] = messages.first().cloned().unwrap_or(Value::Null);
    work["status"] = json!(["sending", "needs_grouping", "pending", "failed"]
        .into_iter()
        .find(|status| messages
            .iter()
            .any(|message| message["dispatchStatus"] == *status))
        .unwrap_or("sent"));
    work["updatedAt"] = json!(now());
    write_record(
        connection,
        work["id"].as_str().unwrap(),
        "stand_in_work",
        work,
    )
}

impl LocalTaskStore {
    pub fn stand_in_source_errors(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement=connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_source' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.error') IS NOT NULL ORDER BY updated_at DESC")?;
        let rows = statement.query_map(params![user], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }
    pub fn stand_in_source(&self, user: i64, source: &Value) -> Result<Value, TaskRuntimeError> {
        let key = stand_in_record_key(
            "stand-in-source",
            &json!([user, source["profile"], source["kind"], source["id"]]),
        );
        let connection = self.connection()?;
        Ok(read_record(&connection, &key, "stand_in_source")?.unwrap_or(Value::Null))
    }

    pub fn save_stand_in_source(
        &self,
        user: i64,
        source: &Value,
        state: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let key = stand_in_record_key(
            "stand-in-source",
            &json!([user, source["profile"], source["kind"], source["id"]]),
        );
        let mut state = state.clone();
        state["userId"] = json!(user);
        state["source"] = source.clone();
        let connection = self.connection()?;
        write_record(&connection, &key, "stand_in_source", &state)
    }

    pub fn stand_in_work(&self, user: i64, id: &str) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        read_record(&connection, id, "stand_in_work")?
            .filter(|work| work["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn list_stand_in_work(
        &self,
        user: i64,
        role: Option<&str>,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_work' AND json_extract(metadata,'$.userId')=?1 AND (?2 IS NULL OR json_extract(metadata,'$.roleId')=?2) ORDER BY updated_at DESC")?;
        let rows = statement.query_map(params![user, role], |row| row.get::<_, String>(0))?;
        rows.map(|raw| {
            serde_json::from_str(&raw?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }

    pub fn stand_in_messages(&self, user: i64, work: &str) -> Result<Vec<Value>, TaskRuntimeError> {
        self.stand_in_work(user, work)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_message' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.workId')=?2 ORDER BY created_at,id")?;
        let rows = statement.query_map(params![user, work], |row| row.get::<_, String>(0))?;
        rows.map(|raw| {
            serde_json::from_str(&raw?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }

    pub fn known_stand_in_message(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &str,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        find_message(&connection, user, role, source, message)
    }

    pub fn ingest_stand_in_message(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &Value,
        work_id: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        self.ingest_stand_in_message_record(
            user,
            role,
            source,
            message,
            MessageGrouping::Known(work_id),
        )
    }

    pub fn ingest_ungrouped_stand_in_message(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &Value,
        error: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        self.ingest_stand_in_message_record(
            user,
            role,
            source,
            message,
            MessageGrouping::Uncertain(error),
        )
    }

    fn ingest_stand_in_message_record(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &Value,
        grouping: MessageGrouping<'_>,
    ) -> Result<Value, TaskRuntimeError> {
        let (work_id, status, error) = match grouping {
            MessageGrouping::Known(id) => (id, "pending", None),
            MessageGrouping::Uncertain(error) => (None, "needs_grouping", error),
        };
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let key = stand_in_record_key(
            "stand-in-message",
            &json!([
                user,
                role,
                source["profile"],
                source["kind"],
                source["id"],
                message["id"]
            ]),
        );
        if let Some(existing) = find_message(
            &connection,
            user,
            role,
            source,
            message["id"].as_str().unwrap_or_default(),
        )? {
            let result = read_record(
                &connection,
                existing["workId"].as_str().unwrap_or_default(),
                "stand_in_work",
            )?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
            connection.commit()?;
            return Ok(result);
        }
        let mut work = if let Some(id) = work_id {
            read_record(&connection, id, "stand_in_work")?
                .filter(|work| work["userId"] == user && work["roleId"] == role)
                .ok_or(TaskRuntimeError::TaskNotFound)?
        } else {
            let id = format!("stand-in-work-{}", Uuid::new_v4());
            json!({"id":id,"userId":user,"roleId":role,"source":source,"title":message["text"].as_str().unwrap_or("DingTalk message").chars().take(80).collect::<String>(),"taskId":id,"messageCount":0,"status":"pending","createdAt":now()})
        };
        let mut record = message.clone();
        record["recordId"] = json!(key);
        record["userId"] = json!(user);
        record["roleId"] = json!(role);
        record["workId"] = work["id"].clone();
        record["source"] = source.clone();
        record["dispatchStatus"] = json!(status);
        if status == "needs_grouping" {
            work["error"] = json!(error);
        }
        write_record(&connection, &key, "stand_in_message", &record)?;
        refresh_work(&connection, &mut work)?;
        connection.commit()?;
        Ok(work)
    }

    pub fn update_stand_in_dispatch(
        &self,
        user: i64,
        work: &str,
        ids: &[String],
        status: &str,
        error: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut work = read_record(&connection, work, "stand_in_work")?
            .filter(|work| work["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        for id in ids {
            let mut message = read_record(&connection, id, "stand_in_message")?
                .filter(|message| message["userId"] == user && message["workId"] == work["id"])
                .ok_or(TaskRuntimeError::TaskNotFound)?;
            message["dispatchStatus"] = json!(status);
            write_record(&connection, id, "stand_in_message", &message)?;
        }
        work["error"] = json!(error);
        refresh_work(&connection, &mut work)?;
        connection.commit()?;
        Ok(())
    }

    pub fn adjust_stand_in_message(
        &self,
        user: i64,
        work: &str,
        message_id: &str,
        target: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        self.organize_stand_in_messages(user, work, &[message_id.to_owned()], target)
    }

    pub fn organize_stand_in_messages(
        &self,
        user: i64,
        work: &str,
        ids: &[String],
        target: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        if ids.is_empty()
            || ids.len() > 1000
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
        {
            return Err(TaskRuntimeError::Invalid(
                "Select unique messages to organize".into(),
            ));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut source = read_record(&connection, work, "stand_in_work")?
            .filter(|work| work["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let mut messages = ids
            .iter()
            .map(|id| {
                read_record(&connection, id, "stand_in_message")?
                    .filter(|row| row["userId"] == user && row["workId"] == work)
                    .ok_or(TaskRuntimeError::TaskNotFound)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut destination = if let Some(target) = target {
            read_record(&connection, target, "stand_in_work")?
                .filter(|row| {
                    row["userId"] == user
                        && row["roleId"] == source["roleId"]
                        && row["id"] != source["id"]
                })
                .ok_or(TaskRuntimeError::TaskNotFound)?
        } else {
            let id = format!("stand-in-work-{}", Uuid::new_v4());
            let message = &messages[0];
            json!({"id":id,"taskId":id,"userId":user,"roleId":source["roleId"],"source":message["source"],"title":message["text"].as_str().unwrap_or_default().chars().take(80).collect::<String>(),"messageCount":0,"status":"pending","createdAt":now()})
        };
        if source["status"] == "sending" || destination["status"] == "sending" {
            return Err(TaskRuntimeError::Invalid(
                "Wait for active work to finish before organizing messages".into(),
            ));
        }
        for (id, message) in ids.iter().zip(messages.iter_mut()) {
            if message.get("originalWorkId").is_none() {
                message["originalWorkId"] = source["id"].clone();
            }
            message["workId"] = destination["id"].clone();
            // Organization never authorizes replay of completed effects.
            if matches!(
                message["dispatchStatus"].as_str(),
                Some("pending" | "needs_grouping" | "failed")
            ) {
                message["dispatchStatus"] = json!("pending");
            }
            write_record(&connection, id, "stand_in_message", message)?;
        }
        refresh_work(&connection, &mut source)?;
        refresh_work(&connection, &mut destination)?;
        connection.commit()?;
        Ok(destination)
    }
}

#[cfg(test)]
mod organization_tests {
    use super::*;

    #[test]
    fn batch_merge_and_undo_are_atomic_preserve_effects_and_isolate_owners() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let source = json!({"id":"group","profile":"owner","kind":"group"});
        let work = store
            .ingest_stand_in_message(
                7,
                "review",
                &source,
                &json!({"id":"one","text":"First"}),
                None,
            )
            .unwrap();
        let id = work["id"].as_str().unwrap();
        store
            .ingest_stand_in_message(
                7,
                "review",
                &source,
                &json!({"id":"two","text":"Second"}),
                Some(id),
            )
            .unwrap();
        let target = store
            .ingest_stand_in_message(
                7,
                "review",
                &source,
                &json!({"id":"three","text":"Target"}),
                None,
            )
            .unwrap();
        let target_id = target["id"].as_str().unwrap();
        let ids: Vec<String> = store
            .stand_in_messages(7, id)
            .unwrap()
            .iter()
            .map(|message| message["recordId"].as_str().unwrap().to_owned())
            .collect();
        store
            .update_stand_in_dispatch(7, id, &ids, "sent", None)
            .unwrap();
        let mut invalid = ids.clone();
        invalid.push("missing".into());
        assert!(store
            .organize_stand_in_messages(7, id, &invalid, Some(target_id))
            .is_err());
        assert_eq!(store.stand_in_messages(7, id).unwrap().len(), 2);
        assert!(store
            .organize_stand_in_messages(8, id, &ids, Some(target_id))
            .is_err());
        let merged = store
            .organize_stand_in_messages(7, id, &ids, Some(target_id))
            .unwrap();
        assert_eq!(merged["messageCount"], 3);
        assert_eq!(store.stand_in_messages(7, id).unwrap().len(), 0);
        store
            .organize_stand_in_messages(7, target_id, &ids, Some(id))
            .unwrap();
        let restored = store.stand_in_messages(7, id).unwrap();
        assert_eq!(restored.len(), 2);
        assert!(restored
            .iter()
            .all(|message| message["dispatchStatus"] == "sent" && message["originalWorkId"] == id));
        assert_eq!(store.stand_in_messages(7, target_id).unwrap().len(), 1);
        assert_eq!(store.list_stand_in_work(7, None).unwrap().len(), 2);
    }
}
