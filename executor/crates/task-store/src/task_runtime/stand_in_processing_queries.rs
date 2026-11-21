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
    pub fn stand_in_has_due_work(&self, user: i64) -> Result<bool, TaskRuntimeError> {
        // Collect claims once per poll. A correlated lookup revisits failed
        // action history for every pending intake item.
        Ok(self.connection()?.query_row(
            "SELECT EXISTS (
                SELECT 1 FROM loop_items INDEXED BY ix_stand_in_live_work
                 WHERE resource_type IN ('stand_in_action','stand_in_event')
                   AND CASE WHEN json_valid(metadata)
                            THEN json_extract(metadata,'$.status') IN ('pending','sending','failed')
                            ELSE 0 END
                   AND resource_type='stand_in_action'
                   AND json_extract(metadata,'$.status') IN ('pending','sending')
                   AND json_extract(metadata,'$.userId')=?1
                   AND json_extract(metadata,'$.kind') IS NOT 'run_arrangement'
             ) OR EXISTS (
                SELECT 1 FROM loop_items AS intake INDEXED BY ix_stand_in_live_work
                 WHERE intake.resource_type IN ('stand_in_action','stand_in_event')
                   AND CASE WHEN json_valid(intake.metadata)
                            THEN json_extract(intake.metadata,'$.status') IN ('pending','sending','failed')
                            ELSE 0 END
                   AND intake.resource_type='stand_in_event'
                   AND json_extract(intake.metadata,'$.status')='pending'
                   AND json_extract(intake.metadata,'$.userId')=?1
                   AND (json_extract(intake.metadata,'$.notBefore') IS NULL
                        OR julianday(json_extract(intake.metadata,'$.notBefore')) <= julianday('now'))
                   AND (intake.id IS NULL OR intake.id NOT IN (
                       SELECT event.value FROM loop_items AS action INDEXED BY ix_stand_in_live_work,
                            json_each(action.metadata,'$.arguments.eventIds') AS event
                        WHERE action.resource_type IN ('stand_in_action','stand_in_event')
                          AND CASE WHEN json_valid(action.metadata)
                                   THEN json_extract(action.metadata,'$.status') IN ('pending','sending','failed')
                                   ELSE 0 END
                          AND action.resource_type='stand_in_action'
                          AND json_extract(action.metadata,'$.status') IN ('pending','sending','failed')
                          AND json_extract(action.metadata,'$.userId')=?1
                          AND json_extract(action.metadata,'$.kind') != 'run_arrangement'
                          AND event.type='text'
                   ))
             )",
            [user],
            |row| row.get(0),
        )?)
    }

    /// Drain one batch of an explicit retry request, preserving original intent IDs.
    pub fn retry_failed_stand_in_routing(&self, user: i64) -> Result<usize, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state_id = format!("stand-in-processing:{user}");
        let Some(mut state) =
            get_item_from(&connection, &state_id, super::stand_in_processing::STATE)?
                .map(|row| row.metadata)
        else {
            return Ok(0);
        };
        let request = state["routingRetry"].clone();
        let (Some(request_id), Some(before)) = (request["id"].as_str(), request["before"].as_str())
        else {
            return Ok(0);
        };
        let actions = query_values(
            &connection,
            "WITH held AS MATERIALIZED (
               SELECT DISTINCT event.value FROM loop_items AS action,
                 json_each(action.metadata,'$.arguments.eventIds') AS event
               WHERE action.resource_type='stand_in_action'
                 AND json_extract(action.metadata,'$.userId')=?1
                 AND json_extract(action.metadata,'$.status') IN ('pending','sending')
                 AND json_extract(action.metadata,'$.kind') != 'run_arrangement'
                 AND event.type='text'
             ), latest AS (
               SELECT action.id,action.updated_at,json_extract(action.metadata,'$.retryRequestId') AS retried_request,
                 coalesce(json_extract(action.metadata,'$.dispatchFailureCount'),1) AS failure_count,
                 row_number() OVER (
                 PARTITION BY event.value ORDER BY action.created_at DESC,action.id DESC
               ) AS position
               FROM loop_items AS action, json_each(action.metadata,'$.arguments.eventIds') AS event
               JOIN loop_items AS intake ON intake.id=event.value AND intake.resource_type='stand_in_event'
               WHERE action.resource_type='stand_in_action'
                 AND json_extract(action.metadata,'$.userId')=?1
                 AND json_extract(action.metadata,'$.status')='failed'
                 AND json_extract(action.metadata,'$.kind')='create_work'
                 AND json_extract(intake.metadata,'$.userId')=?1
                 AND json_extract(intake.metadata,'$.status')='pending'
                 AND NOT EXISTS (
                   SELECT 1 FROM json_each(action.metadata,'$.arguments.eventIds') AS member
                   LEFT JOIN loop_items AS owned ON owned.id=member.value AND owned.resource_type='stand_in_event'
                   WHERE member.type != 'text' OR owned.id IS NULL
                     OR json_extract(owned.metadata,'$.userId') IS NOT ?1
                     OR json_extract(owned.metadata,'$.status') IS NOT 'pending'
                     OR member.value IN (SELECT value FROM held)
                 )
             )
             UPDATE loop_items SET metadata=json_set(metadata,'$.status','pending','$.resolution','explicit_retry','$.retryRequestId',?3,
               '$.dispatchFailureCount',coalesce(json_extract(metadata,'$.dispatchFailureCount'),1)),updated_at=?2
             WHERE id IN (SELECT DISTINCT id FROM latest WHERE position=1
               AND failure_count<?5 AND retried_request IS NOT ?3 AND julianday(updated_at)<=julianday(?4)
               ORDER BY id LIMIT 100) RETURNING metadata",
            params![user, now(), request_id, before, Self::STAND_IN_DISPATCH_FAILURE_LIMIT],
        )?;
        for action in &actions {
            super::stand_in_history_index::record(&connection, ACTION, action)?;
        }
        let retried = actions.len();
        if retried < 100 {
            state["routingRetry"] = Value::Null;
            super::stand_in_processing::write(
                &connection,
                super::stand_in_processing::STATE,
                &state,
            )?;
        }
        connection.commit()?;
        Ok(retried)
    }

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
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_action'
             AND json_valid(metadata) AND json_extract(metadata,'$.userId')=?1
             ORDER BY created_at DESC,id DESC LIMIT ?2",
            params![user, limit as i64],
        )
    }

    pub fn recent_stand_in_suggestions(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        query_values(
            &*self.connection()?,
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_action'
             AND CASE WHEN json_valid(metadata)
                      THEN json_extract(metadata,'$.kind')='suggest_action'
                       AND json_extract(metadata,'$.status') IS NOT 'cancelled'
                      ELSE 0 END
             AND json_extract(metadata,'$.userId')=?1
             ORDER BY created_at DESC,id DESC LIMIT 20",
            [user],
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
    fn creation_retry_never_overlaps_live_consumed_or_foreign_input() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        for (id, user, status) in [
            ("free", 7, "pending"),
            ("busy", 7, "pending"),
            ("done", 7, "handled"),
            ("foreign", 8, "pending"),
        ] {
            write(
                &store.connection().unwrap(),
                EVENT,
                &json!({"id":id,"userId":user,"status":status}),
            )
            .unwrap();
        }
        write(&store.connection().unwrap(), ACTION, &json!({"id":"live","userId":7,"status":"sending","kind":"continue_work","arguments":{"eventIds":["busy"]}})).unwrap();
        for blocked in ["busy", "done", "foreign"] {
            write(&store.connection().unwrap(), ACTION, &json!({"id":format!("blocked-{blocked}"),"userId":7,"status":"failed","kind":"create_work","arguments":{"eventIds":["free",blocked]}})).unwrap();
        }
        store.save_stand_in_processing_state(7, &json!({"routingRetry":{"id":"request","before":(Utc::now()+chrono::Duration::seconds(1)).to_rfc3339()}})).unwrap();
        assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 0);
        let active = store.pending_stand_in_actions(7).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["id"], "live");
    }

    #[test]
    fn explicit_retry_batches_use_latest_intents_once_and_preserve_owner_and_kind() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        {
            let mut guard = store.connection().unwrap();
            let tx = guard.transaction().unwrap();
            for index in 0..101 {
                write(
                    &tx,
                    EVENT,
                    &json!({"id":format!("event-{index}"),"userId":7,"status":"pending"}),
                )
                .unwrap();
                write(&tx, ACTION, &json!({"id":format!("failure-{index}"),"userId":7,"status":"failed","kind":"create_work","arguments":{"eventIds":[format!("event-{index}")]}})).unwrap();
            }
            for (id, user, kind) in [
                ("duplicate", 7, "create_work"),
                ("foreign", 8, "create_work"),
                ("assessment", 7, "assess"),
                ("arrangement", 7, "run_arrangement"),
                ("followup", 7, "continue_work"),
            ] {
                write(&tx, ACTION, &json!({"id":id,"userId":user,"status":"failed","kind":kind,"arguments":{"eventIds":["event-0"]}})).unwrap();
            }
            tx.execute(
                "UPDATE loop_items SET created_at=?1 WHERE id='duplicate'",
                [(Utc::now() - chrono::Duration::days(1)).to_rfc3339()],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 0);
        let request =
            json!({"id":"retry-1","before":(Utc::now()+chrono::Duration::seconds(1)).to_rfc3339()});
        store
            .save_stand_in_processing_state(7, &json!({"routingRetry":request}))
            .unwrap();
        assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 100);
        assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 1);
        assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 0);
        let pending = store.pending_stand_in_actions(7).unwrap();
        assert_eq!(pending.len(), 101);
        assert!(pending
            .iter()
            .all(|action| action["id"].as_str().unwrap().starts_with("failure-")));
        assert!(store.pending_stand_in_actions(8).unwrap().is_empty());
        let mut failed = pending
            .iter()
            .find(|action| action["id"] == "failure-0")
            .unwrap()
            .clone();
        failed["status"] = json!("failed");
        store.save_stand_in_action(7, &failed).unwrap();
        store
            .save_stand_in_processing_state(7, &json!({"routingRetry":request}))
            .unwrap();
        assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 0, "The same owner request must not repeat a failure or fall through to an older duplicate");
        store.save_stand_in_processing_state(7, &json!({"routingRetry":{"id":"retry-2","before":(Utc::now()+chrono::Duration::seconds(1)).to_rfc3339()}})).unwrap();
        assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 1);
        let mut exhausted = store
            .pending_stand_in_actions(7)
            .unwrap()
            .into_iter()
            .find(|action| action["id"] == "failure-0")
            .unwrap();
        assert_eq!(exhausted["dispatchFailureCount"], 1);
        exhausted["status"] = json!("failed");
        exhausted["dispatchFailureCount"] = json!(LocalTaskStore::STAND_IN_DISPATCH_FAILURE_LIMIT);
        store.save_stand_in_action(7, &exhausted).unwrap();
        store.save_stand_in_processing_state(7, &json!({"routingRetry":{"id":"retry-3","before":(Utc::now()+chrono::Duration::seconds(1)).to_rfc3339()}})).unwrap();
        assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 0);
    }

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
        connection
            .execute(
                "UPDATE loop_items SET created_at=?1 WHERE id IN ('history','old-action')",
                [(Utc::now() - chrono::Duration::days(1)).to_rfc3339()],
            )
            .unwrap();
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
        assert_eq!(
            store.recent_stand_in_actions(7, 1).unwrap()[0]["id"],
            "active"
        );
        assert!(store.recent_stand_in_suggestions(7).unwrap().is_empty());
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
            write(&store.connection().unwrap(), ACTION,
                &json!({"id":format!("action-{id}"),"userId":user,"kind":kind,"status":status,"arguments":{"eventIds":[id]}})).unwrap();
        }
        assert_eq!(
            store.claimed_stand_in_event_ids(7).unwrap(),
            ["pending", "sending", "failure"]
                .map(str::to_owned)
                .into_iter()
                .collect()
        );
        {
            let connection = store.connection().unwrap();
            for id in ["failure", "foreign"] {
                write(
                    &connection,
                    EVENT,
                    &json!({"id":id,"userId":7,"status":"pending"}),
                )
                .unwrap();
            }
            connection
                .execute(
                    "UPDATE loop_items SET metadata=json_set(metadata,'$.status','cancelled')
                 WHERE id IN ('action-pending','action-sending')",
                    [],
                )
                .unwrap();
        }
        assert!(store.stand_in_has_due_work(7).unwrap());
        store.connection().unwrap().execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.status','handled') WHERE id='foreign'",
            [],
        ).unwrap();
        assert!(!store.stand_in_has_due_work(7).unwrap());
        store.connection().unwrap().execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.status','cancelled') WHERE id='action-failure'", []
        ).unwrap();
        assert!(store.stand_in_has_due_work(7).unwrap());
        assert!(!store
            .claimed_stand_in_event_ids(7)
            .unwrap()
            .contains("failure"));
    }
}
