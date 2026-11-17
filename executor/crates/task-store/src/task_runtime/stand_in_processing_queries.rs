//! Scheduler reads select live records before materializing JSON history.
use super::stand_in_processing::{ACTION, EVENT};
use super::*;

pub(super) fn query_values(
    connection: &Connection,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> Result<Vec<Value>, TaskRuntimeError> {
    let mut statement = connection.prepare(sql)?;
    let values = statement.query_map(parameters, |row| row.get::<_, String>(0))?;
    values
        .map(|row| {
            serde_json::from_str(&row?).map_err(|e| TaskRuntimeError::Invalid(e.to_string()))
        })
        .collect()
}

pub(super) fn pending_actions(
    connection: &Connection,
    user: i64,
) -> Result<Vec<Value>, TaskRuntimeError> {
    query_values(
        connection,
        "SELECT metadata FROM loop_items WHERE resource_type=?1
         AND json_extract(metadata,'$.userId')=?2
         AND json_extract(metadata,'$.status') IN ('pending','sending')
         ORDER BY created_at,id",
        params![ACTION, user],
    )
}

pub(super) fn claimed_event_ids(
    connection: &Connection,
    user: i64,
) -> Result<HashSet<String>, TaskRuntimeError> {
    // A failed intent retains its evidence. Replanning it on every poll would
    // bypass the work's manual recovery gate and grow an unbounded retry history.
    let mut statement = connection.prepare(
        "SELECT DISTINCT event.value FROM loop_items AS action,
         json_each(action.metadata,'$.arguments.eventIds') AS event
         WHERE action.resource_type=?1 AND json_extract(action.metadata,'$.userId')=?2
         AND json_extract(action.metadata,'$.status') IN ('pending','sending','failed')
         AND json_extract(action.metadata,'$.kind') != 'run_arrangement'
         AND event.type='text'",
    )?;
    let ids = statement
        .query_map(params![ACTION, user], |row| row.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;
    Ok(ids)
}

impl LocalTaskStore {
    pub fn stand_in_assessment_recovery_actions(
        &self,
        user: i64,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        query_values(
            &*self.connection()?,
            "SELECT metadata FROM loop_items WHERE resource_type=?1
             AND json_extract(metadata,'$.userId')=?2 AND json_extract(metadata,'$.kind')='assess'
             AND json_extract(metadata,'$.status') IN ('sending','failed') ORDER BY created_at,id",
            params![ACTION, user],
        )
    }

    pub fn pending_stand_in_actions(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        pending_actions(&*self.connection()?, user)
    }

    pub fn claimed_stand_in_event_ids(
        &self,
        user: i64,
    ) -> Result<HashSet<String>, TaskRuntimeError> {
        claimed_event_ids(&*self.connection()?, user)
    }

    pub fn pending_stand_in_events(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        query_values(
            &*self.connection()?,
            "SELECT metadata FROM loop_items WHERE resource_type=?1
             AND json_extract(metadata,'$.userId')=?2
             AND json_extract(metadata,'$.status')='pending' ORDER BY created_at,id",
            params![EVENT, user],
        )
    }

    pub fn stand_in_event(&self, user: i64, id: &str) -> Result<Value, TaskRuntimeError> {
        query_values(
            &*self.connection()?,
            "SELECT metadata FROM loop_items WHERE id=?1 AND resource_type=?2
             AND json_extract(metadata,'$.userId')=?3",
            params![id, EVENT, user],
        )?
        .pop()
        .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn recent_stand_in_actions(
        &self,
        user: i64,
        limit: usize,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        query_values(
            &*self.connection()?,
            "SELECT metadata FROM loop_items WHERE resource_type=?1
             AND json_extract(metadata,'$.userId')=?2 ORDER BY created_at DESC,id DESC LIMIT ?3",
            params![ACTION, user, limit as i64],
        )
    }

    pub fn pending_stand_in_event_count(&self, user: i64) -> Result<usize, TaskRuntimeError> {
        Ok(self.connection()?.query_row(
            "SELECT count(*) FROM loop_items WHERE resource_type=?1
             AND json_extract(metadata,'$.userId')=?2 AND json_extract(metadata,'$.status')='pending'",
            params![EVENT, user], |row| row.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::super::stand_in_processing::write;
    use super::*;

    #[test]
    fn scheduler_reads_skip_unselected_history_and_enforce_owner_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let connection = store.connection().unwrap();
        for (kind, status, id) in [
            (EVENT, "pending", "selected"),
            (EVENT, "handled", "history"),
            (ACTION, "sending", "active"),
            (ACTION, "succeeded", "old-action"),
        ] {
            write(&connection, kind, &json!({"id":id,"userId":7,"status":status,"kind":"continue_work","arguments":{"eventIds":["selected"]}})).unwrap();
        }
        // Valid JSON beyond serde's default recursion limit makes accidental
        // materialization of unrelated historical payloads fail deterministically.
        let deep = format!("{}0{}", "[".repeat(140), "]".repeat(140));
        connection.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.payload',json(?1)) WHERE id IN ('history','old-action')",
            [deep],
        ).unwrap();
        drop(connection);
        assert_eq!(
            store.pending_stand_in_events(7).unwrap()[0]["id"],
            "selected"
        );
        assert_eq!(store.pending_stand_in_event_count(7).unwrap(), 1);
        assert_eq!(
            store.pending_stand_in_actions(7).unwrap()[0]["id"],
            "active"
        );
        assert_eq!(
            store.stand_in_event(7, "selected").unwrap()["id"],
            "selected"
        );
        assert!(store.stand_in_event(8, "selected").is_err());
        assert!(store.pending_stand_in_actions(8).unwrap().is_empty());
        assert!(store.pending_stand_in_events(8).unwrap().is_empty());
    }

    #[test]
    fn failed_intents_keep_their_claim_until_explicit_recovery_retires_them() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        for (id, status, user, kind) in [
            ("pending", "pending", 7, "continue_work"),
            ("sending", "sending", 7, "continue_work"),
            ("failure", "failed", 7, "continue_work"),
            ("success", "succeeded", 7, "ignore_events"),
            ("cancelled", "cancelled", 7, "assess"),
            ("arrangement", "sending", 7, "run_arrangement"),
            ("foreign", "failed", 8, "continue_work"),
        ] {
            write(&*store.connection().unwrap(), ACTION,
                &json!({"id":id,"userId":user,"kind":kind,"status":status,"arguments":{"eventIds":[id]}})).unwrap();
        }
        assert_eq!(
            store.claimed_stand_in_event_ids(7).unwrap(),
            ["pending", "sending", "failure"]
                .map(str::to_owned)
                .into_iter()
                .collect()
        );
        store.connection().unwrap().execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.status','cancelled') WHERE id='failure'", []
        ).unwrap();
        assert!(!store
            .claimed_stand_in_event_ids(7)
            .unwrap()
            .contains("failure"));
    }
}
