//! Durable intake and coordinator commands. Intake never creates Runtime work.
use super::stand_in_inbox::stand_in_record_key;
use super::*;

const EVENT: &str = "stand_in_event";
const STATE: &str = "stand_in_processing";
const ACTION: &str = "stand_in_action";

fn write(connection: &Connection, kind: &str, value: &Value) -> Result<(), TaskRuntimeError> {
    connection.execute(
        "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
        params![value["id"].as_str(), kind, value.to_string(), now()],
    )?;
    Ok(())
}

fn rows(connection: &Connection, kind: &str, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
    let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type=?1 AND json_extract(metadata,'$.userId')=?2 ORDER BY created_at,id")?;
    let values = statement.query_map(params![kind, user], |row| row.get::<_, String>(0))?;
    values
        .map(|row| {
            serde_json::from_str(&row?).map_err(|e| TaskRuntimeError::Invalid(e.to_string()))
        })
        .collect()
}

pub(super) fn update_processing_configuration(
    connection: &Connection,
    user: i64,
    before: &Value,
    after: &Value,
) -> Result<(), TaskRuntimeError> {
    if before["primary"] == after["primary"] && before["roles"] == after["roles"] {
        return Ok(());
    }
    let id = format!("stand-in-processing:{user}");
    let mut state = get_item_from(connection, &id, STATE)?
        .map(|row| row.metadata)
        .unwrap_or_else(|| json!({"id":id,"userId":user}));
    state["batchId"] = Value::Null;
    state["snapshot"] = Value::Null;
    state["error"] = Value::Null;
    state["nextCheckAt"] = json!((Utc::now() + chrono::Duration::minutes(5)).to_rfc3339());
    write(connection, STATE, &state)?;
    for mut action in rows(connection, ACTION, user)?
        .into_iter()
        .filter(|action| matches!(action["status"].as_str(), Some("pending" | "sending")))
    {
        action["status"] = json!("cancelled");
        write(connection, ACTION, &action)?;
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn enqueue_stand_in_event(
        &self,
        user: i64,
        identity: Value,
        mut event: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = stand_in_record_key("stand-in-event", &json!([user, identity]));
        if let Some(existing) = get_item_from(&connection, &id, EVENT)? {
            return Ok(existing.metadata);
        }
        event["id"] = json!(id);
        event["userId"] = json!(user);
        event["status"] = json!("pending");
        event["createdAt"] = json!(now());
        write(&connection, EVENT, &event)?;
        connection.commit()?;
        Ok(event)
    }

    pub fn stand_in_events(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        rows(&*self.connection()?, EVENT, user)
    }

    pub fn save_stand_in_event(&self, user: i64, event: &Value) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let existing = get_item_from(&connection, event["id"].as_str().unwrap_or_default(), EVENT)?;
        if event["userId"] != user || !existing.is_some_and(|row| row.metadata["userId"] == user) {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        write(&connection, EVENT, event)
    }

    pub fn stand_in_processing_state(&self, user: i64) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        Ok(get_item_from(&connection, &format!("stand-in-processing:{user}"), STATE)?.map(|row| row.metadata).unwrap_or_else(|| json!({"id":format!("stand-in-processing:{user}"),"userId":user,"history":[]})))
    }

    pub fn save_stand_in_processing_state(
        &self,
        user: i64,
        state: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut state = state.clone();
        state["id"] = json!(format!("stand-in-processing:{user}"));
        state["userId"] = json!(user);
        write(&*self.connection()?, STATE, &state)
    }

    pub fn stand_in_actions(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        rows(&*self.connection()?, ACTION, user)
    }

    pub fn save_stand_in_action(&self, user: i64, action: &Value) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        if action["userId"] != user
            || !get_item_from(
                &connection,
                action["id"].as_str().unwrap_or_default(),
                ACTION,
            )?
            .is_some_and(|row| row.metadata["userId"] == user)
        {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        write(&connection, ACTION, action)
    }

    pub fn queue_stand_in_action(
        &self,
        user: i64,
        device: &str,
        batch: &str,
        kind: &str,
        arguments: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let settings = self.personal_stand_in(user, device)?;
        if settings["primary"]["enabled"] == false {
            return Err(TaskRuntimeError::Invalid(
                "The primary stand-in is paused".into(),
            ));
        }
        let state = self.stand_in_processing_state(user)?;
        if state["batchId"] != batch {
            return Err(TaskRuntimeError::Invalid(
                "Coordinator batch is no longer current".into(),
            ));
        }
        if !matches!(
            kind,
            "create_work"
                | "continue_work"
                | "ignore_events"
                | "defer_events"
                | "schedule_followup"
        ) {
            return Err(TaskRuntimeError::Invalid(
                "Unknown coordinator action".into(),
            ));
        }
        if arguments.to_string().len() > 100_000 {
            return Err(TaskRuntimeError::Invalid(
                "Coordinator action is too large".into(),
            ));
        }
        let id = stand_in_record_key("stand-in-action", &json!([user, batch, kind, arguments]));
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if super::personal_stand_in::read_personal(&connection, user, device)?["primary"]["enabled"]
            == false
            || get_item_from(&connection, &format!("stand-in-processing:{user}"), STATE)?
                .map_or(true, |row| row.metadata["batchId"] != batch)
        {
            return Err(TaskRuntimeError::Invalid(
                "Coordinator configuration changed".into(),
            ));
        }
        if let Some(existing) = get_item_from(&connection, &id, ACTION)? {
            return Ok(existing.metadata);
        }
        if kind == "continue_work"
            && rows(&connection, ACTION, user)?.iter().any(|action| {
                matches!(action["status"].as_str(), Some("pending" | "sending"))
                    && action["kind"] == kind
                    && action["arguments"]["taskId"] == arguments["taskId"]
            })
        {
            return Err(TaskRuntimeError::Invalid(
                "A follow-up for this work is already waiting".into(),
            ));
        }
        let action = json!({"id":id,"userId":user,"batchId":batch,"kind":kind,"arguments":arguments,"status":"pending","createdAt":now()});
        write(&connection, ACTION, &action)?;
        connection.commit()?;
        Ok(action)
    }

    pub fn ensure_coordinated_work(
        &self,
        user: i64,
        role: &str,
        id: &str,
        source: &Value,
        title: &str,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = get_item_from(&connection, id, "stand_in_work")? {
            if existing.metadata["userId"] != user || existing.metadata["roleId"] != role {
                return Err(TaskRuntimeError::TaskNotFound);
            }
        } else {
            write(
                &connection,
                "stand_in_work",
                &json!({"id":id,"taskId":id,"userId":user,"roleId":role,"source":source,"title":title,"messageCount":0,"status":"pending","createdAt":now()}),
            )?;
        }
        connection.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_timing_changes_cancel_old_commands_and_revoke_old_batch_tools() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["processing"] = json!({"mode":"silent","intervalMinutes":5});
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        store
            .save_stand_in_processing_state(7, &json!({"batchId":"old"}))
            .unwrap();
        store
            .queue_stand_in_action(
                7,
                "mac",
                "old",
                "ignore_events",
                json!({"eventIds":["event"]}),
            )
            .unwrap();
        settings["roles"][0]["collaboration"]["policy"]["immediate"] = json!(false);
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert!(store.stand_in_processing_state(7).unwrap()["batchId"].is_null());
        assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "cancelled");
        assert!(store
            .queue_stand_in_action(
                7,
                "mac",
                "old",
                "ignore_events",
                json!({"eventIds":["event"]})
            )
            .is_err());
        settings["roles"][0]["collaboration"]["policy"]["immediate"] = json!(0);
        assert!(store.save_personal_stand_in(7, "mac", settings).is_err());
    }

    #[test]
    fn intake_is_durable_deduplicated_and_does_not_create_work() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let identity = json!(["provider", "account", "group", "event"]);
        let event = store
            .enqueue_stand_in_event(7, identity.clone(), json!({"text":"hello"}))
            .unwrap();
        assert_eq!(
            event,
            store
                .enqueue_stand_in_event(7, identity.clone(), json!({"text":"duplicate"}))
                .unwrap()
        );
        assert!(store.list_stand_in_work(7, None).unwrap().is_empty());
        assert!(store.stand_in_events(8).unwrap().is_empty());
        assert!(store.save_stand_in_event(8, &event).is_err());
        drop(store);
        let store = LocalTaskStore::open(path).unwrap();
        assert_eq!(store.stand_in_events(7).unwrap(), vec![event]);
        store
            .enqueue_stand_in_event(8, identity, json!({}))
            .unwrap();
        assert_eq!(store.stand_in_events(7).unwrap().len(), 1);
    }

    #[test]
    fn commands_are_batch_bound_idempotent_and_require_silent_mode() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        assert!(store
            .queue_stand_in_action(7, "mac", "batch", "ignore_events", json!({}))
            .is_err());
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["processing"] = json!({"mode":"silent","intervalMinutes":5});
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        store
            .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
            .unwrap();
        let action = store
            .queue_stand_in_action(
                7,
                "mac",
                "batch",
                "ignore_events",
                json!({"eventIds":["one"]}),
            )
            .unwrap();
        assert_eq!(
            action,
            store
                .queue_stand_in_action(
                    7,
                    "mac",
                    "batch",
                    "ignore_events",
                    json!({"eventIds":["one"]})
                )
                .unwrap()
        );
        assert!(store
            .queue_stand_in_action(7, "mac", "stale", "ignore_events", json!({}))
            .is_err());
        assert!(store.save_stand_in_action(8, &action).is_err());
    }
}
