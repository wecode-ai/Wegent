//! Reserve the task address before either executor can start the work.
use super::*;

mod admission;
mod ledger;
mod replica;

impl LocalTaskStore {
    pub fn matching_stand_in_role_request(
        &self,
        id: &str,
        user: i64,
        intent: &Value,
        cancelling: Option<bool>,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        Ok(self.stand_in_role_request(id, user)?.filter(|row| {
            row["intent"] == *intent
                && row["terminalError"].is_null()
                && cancelling.map_or(true, |expected| {
                    (row["cancelRequested"] == true) == expected
                })
        }))
    }

    pub fn record_stand_in_role_task_address(
        &self,
        id: &str,
        user: i64,
        attempt: u64,
        device: &str,
    ) -> Result<(), TaskRuntimeError> {
        let changed = self.connection()?.execute(
            "UPDATE loop_items SET metadata=json_remove(json_set(metadata,'$.taskAddress',json_object('deviceId',?3,'taskId',?1)),'$.lastError','$.retryAt'),updated_at=?4
             WHERE id=?1 AND resource_type='stand_in_role_request' AND json_extract(metadata,'$.userId')=?2
               AND coalesce(json_extract(metadata,'$.attempt'),0)=?5
               AND json_extract(metadata,'$.intent.targetDevice')=?3 AND json_extract(metadata,'$.terminalError') IS NULL",
            params![id, user, device, now(), attempt],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        Ok(())
    }

    pub fn pending_remote_stand_in_role_requests(
        &self,
        user: i64,
        device: &str,
        backend: &str,
    ) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,metadata FROM loop_items
             WHERE resource_type='stand_in_role_request'
               AND json_extract(metadata,'$.userId')=?1
               AND json_extract(metadata,'$.intent.sourceDevice')=?2
               AND json_extract(metadata,'$.intent.backendUrl')=?3
               AND json_extract(metadata,'$.intent.sourceRoute') IS NOT NULL
               AND json_extract(metadata,'$.taskAddress') IS NULL
               AND json_extract(metadata,'$.terminalError') IS NULL
               AND coalesce(json_extract(metadata,'$.cancelRequested'),0)=0
               AND (coalesce(json_array_length(metadata,'$.intent.dependsOn'),0)=0
                    OR json_type(metadata,'$.dependencyEvidence')='array')
               AND coalesce(json_extract(metadata,'$.retryAt'),0)<=?4
             ORDER BY coalesce(json_extract(metadata,'$.retryAt'),0),created_at,id LIMIT 4",
        )?;
        let rows = statement.query_map(
            params![user, device, backend, Utc::now().timestamp()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| {
            let (id, raw) = row?;
            let metadata = serde_json::from_str(&raw)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            Ok((id, metadata))
        })
        .collect()
    }

    pub fn stand_in_role_request(
        &self,
        id: &str,
        user: i64,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let raw: Option<String> = self.connection()?.query_row(
            "SELECT metadata FROM loop_items WHERE id=?1 AND resource_type='stand_in_role_request'
               AND json_extract(metadata,'$.userId')=?2",
            params![id,user], |row| row.get(0),
        ).optional()?;
        raw.map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
    }

    pub fn pending_stand_in_role_dependencies(
        &self,
        device: &str,
    ) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,metadata FROM loop_items WHERE resource_type='stand_in_role_request'
               AND json_extract(metadata,'$.intent.sourceDevice')=?1
               AND (json_array_length(metadata,'$.intent.dependsOn')>0
                    OR (json_extract(metadata,'$.intent.sourceRoute') IS NULL
                        AND (json_extract(metadata,'$.attempt')>0 OR json_extract(metadata,'$.terminalError') IS NOT NULL)))
               AND (json_extract(metadata,'$.intent.sourceRoute') IS NULL
                    OR json_type(metadata,'$.dependencyEvidence') IS NULL)
               AND json_extract(metadata,'$.taskAddress') IS NULL
               AND (json_extract(metadata,'$.terminalError') IS NULL
                    OR (json_extract(metadata,'$.intent.sourceRoute') IS NULL
                        AND json_extract(metadata,'$.resultReceipt') IS NULL))
               AND coalesce(json_extract(metadata,'$.cancelRequested'),0)=0
               AND coalesce(json_extract(metadata,'$.dependencyCheckAt'),0)<=?2
               AND coalesce(json_extract(metadata,'$.retryAt'),0)<=?2
             ORDER BY coalesce(json_extract(metadata,'$.dependencyCheckAt'),0),created_at,id LIMIT 8",
        )?;
        let rows = statement.query_map(params![device, Utc::now().timestamp()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (id, raw) = row?;
            let metadata = serde_json::from_str(&raw)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            Ok((id, metadata))
        })
        .collect()
    }

    pub fn record_stand_in_role_dependency_state(
        &self,
        id: &str,
        user: i64,
        attempt: u64,
        status: &str,
        evidence: Option<&Value>,
    ) -> Result<bool, TaskRuntimeError> {
        Ok(self.connection()?.execute(
            "UPDATE loop_items SET metadata=CASE WHEN ?4 IS NULL
                  THEN json_set(metadata,'$.dependencyStatus',?3,'$.dependencyCheckAt',?5)
                  ELSE json_set(metadata,'$.dependencyStatus',?3,'$.dependencyEvidence',json(?4))
                  END,updated_at=?6
              WHERE id=?1 AND resource_type='stand_in_role_request'
                AND json_extract(metadata,'$.userId')=?2
                AND coalesce(json_extract(metadata,'$.attempt'),0)=?7
                AND json_type(metadata,'$.dependencyEvidence') IS NULL
                AND coalesce(json_extract(metadata,'$.cancelRequested'),0)=0",
            params![
                id,
                user,
                status,
                evidence.map(Value::to_string),
                Utc::now().timestamp() + 5,
                now(),
                attempt
            ],
        )? == 1)
    }

    /// Latch cancellation before a queued dispatch can be reconciled again.
    /// Keep accepted addresses and immutable intents for delivery of the stop.
    pub fn request_stand_in_role_cancellation(
        &self,
        user: i64,
        device: &str,
        conversation: &str,
        root: &str,
        branch: Option<&str>,
    ) -> Result<Vec<String>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "UPDATE loop_items SET metadata=json_remove(CASE WHEN ?5 IS NULL
                    THEN json_set(metadata,'$.cancelRequested',json('true'),'$.cancelGroup',json('true'))
                    ELSE json_set(metadata,'$.cancelRequested',json('true')) END,'$.retryAt'),
                                     updated_at=?6
             WHERE resource_type='stand_in_role_request'
               AND json_extract(metadata,'$.userId')=?1
               AND json_extract(metadata,'$.intent.sourceDevice')=?2
               AND json_extract(metadata,'$.intent.roleDelegation.ancestors[0]')=?3
               AND json_extract(metadata,'$.root')=?4
               AND json_extract(metadata,'$.terminalError') IS NULL
               AND json_extract(metadata,'$.resultReceipt') IS NULL
               AND (coalesce(json_extract(metadata,'$.cancelRequested'),0)=0
                    OR (?5 IS NULL AND coalesce(json_extract(metadata,'$.cancelGroup'),0)=0))
               AND (?5 IS NULL OR id=?5 OR EXISTS (
                   SELECT 1 FROM json_each(metadata,'$.intent.roleDelegation.ancestors')
                    WHERE value=?5 AND type='text'))
             RETURNING id",
        )?;
        let rows = statement.query_map(
            params![user, device, conversation, root, branch, now()],
            |row| row.get::<_, String>(0),
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn owns_stand_in_role_branch(
        &self,
        user: i64,
        device: &str,
        conversation: &str,
        root: &str,
        branch: &str,
    ) -> Result<bool, TaskRuntimeError> {
        Ok(self.connection()?.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM loop_items
                 WHERE id=?5 AND resource_type='stand_in_role_request'
                   AND json_extract(metadata,'$.userId')=?1
                   AND json_extract(metadata,'$.intent.sourceDevice')=?2
                   AND json_extract(metadata,'$.intent.roleDelegation.ancestors[0]')=?3
                   AND json_extract(metadata,'$.root')=?4
             )",
            params![user, device, conversation, root, branch],
            |row| row.get(0),
        )?)
    }

    pub fn remote_stand_in_role_requests(
        &self,
        user: i64,
        device: &str,
        root: &str,
    ) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        self.remote_stand_in_role_requests_for_roots(user, device, &[root])
    }

    pub fn remote_stand_in_role_requests_for_roots(
        &self,
        user: i64,
        device: &str,
        roots: &[&str],
    ) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        self.stand_in_role_result_requests(user, device, roots, false)
    }

    pub fn role_completion_requests_for_roots(
        &self,
        user: i64,
        device: &str,
        roots: &[&str],
    ) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        self.stand_in_role_result_requests(user, device, roots, true)
    }

    fn stand_in_role_result_requests(
        &self,
        user: i64,
        device: &str,
        roots: &[&str],
        include_local_retries: bool,
    ) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,metadata FROM loop_items WHERE resource_type='stand_in_role_request'
             AND json_extract(metadata,'$.userId')=?1
             AND json_extract(metadata,'$.intent.sourceDevice')=?2
             AND json_extract(metadata,'$.root') IN (SELECT value FROM json_each(?3) WHERE type='text')
             AND (json_extract(metadata,'$.intent.sourceRoute') IS NOT NULL
                  OR (json_array_length(metadata,'$.intent.dependsOn')>0
                      AND json_extract(metadata,'$.taskAddress') IS NULL
                      AND coalesce(json_extract(metadata,'$.cancelRequested'),0)=0)
                  OR (?4 AND json_extract(metadata,'$.attempt')>0
                      AND (coalesce(json_extract(metadata,'$.cancelRequested'),0)=0
                           OR json_extract(metadata,'$.resultReceipt') IS NULL)))
             ORDER BY created_at,id",
        )?;
        let rows = statement.query_map(
            params![
                user,
                device,
                json!(roots).to_string(),
                include_local_retries
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| {
            let (id, raw) = row?;
            let metadata = serde_json::from_str(&raw)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            Ok((id, metadata))
        })
        .collect()
    }

    pub fn mark_inbound_stand_in_role_cancellation(
        &self,
        id: &str,
        user: i64,
        attempt: u64,
    ) -> Result<(), TaskRuntimeError> {
        let changed = self.connection()?.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.cancelRequested',json('true')),updated_at=?3
             WHERE id=?1 AND resource_type='stand_in_role_request' AND json_extract(metadata,'$.userId')=?2
               AND coalesce(json_extract(metadata,'$.attempt'),0)=?4",
            params![id, user, now(), attempt],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        Ok(())
    }

    /// Returns whether the cancellation applies to the entire original request.
    pub fn stand_in_role_cancellation(
        &self,
        id: &str,
        user: i64,
    ) -> Result<Option<bool>, TaskRuntimeError> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT coalesce(json_extract(metadata,'$.cancelGroup'),0) FROM loop_items
             WHERE id=?1 AND resource_type='stand_in_role_request'
               AND json_extract(metadata,'$.userId')=?2
               AND json_extract(metadata,'$.cancelRequested')=1",
                params![id, user],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn pending_local_stand_in_role_cancellations(
        &self,
        device: &str,
    ) -> Result<Vec<(String, i64, u64)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,json_extract(metadata,'$.userId'),coalesce(json_extract(metadata,'$.attempt'),0) FROM loop_items
             WHERE resource_type='stand_in_role_request'
               AND json_extract(metadata,'$.intent.sourceDevice')=?1
               AND json_extract(metadata,'$.intent.targetDevice')=?1
               AND json_extract(metadata,'$.cancelRequested')=1
               AND json_extract(metadata,'$.resultReceipt') IS NULL
               AND coalesce(json_extract(metadata,'$.retryAt'),0)<=?2
             ORDER BY updated_at,id LIMIT 8",
        )?;
        let rows = statement.query_map(params![device, Utc::now().timestamp()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn has_pending_stand_in_role_descendant_cancellations(
        &self,
        user: i64,
        device: &str,
        root: &str,
        branch: &str,
    ) -> Result<bool, TaskRuntimeError> {
        Ok(self.connection()?.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM loop_items
                 WHERE resource_type='stand_in_role_request'
                   AND json_extract(metadata,'$.userId')=?1
                   AND json_extract(metadata,'$.intent.sourceDevice')=?2
                   AND json_extract(metadata,'$.root')=?3
                   AND json_extract(metadata,'$.cancelRequested')=1
                   AND json_extract(metadata,'$.resultReceipt') IS NULL
                   AND EXISTS (SELECT 1 FROM json_each(metadata,'$.intent.roleDelegation.ancestors')
                               WHERE type='text' AND value=?4)
             )",
            params![user, device, root, branch],
            |row| row.get(0),
        )?)
    }

    pub fn record_stand_in_role_route_failure(
        &self,
        id: &str,
        user: i64,
        attempt: u64,
        code: &str,
        retryable: bool,
    ) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.lastError',?3,'$.retryAt',?4,'$.terminalError',?5),updated_at=?6
             WHERE id=?1 AND resource_type='stand_in_role_request' AND json_extract(metadata,'$.userId')=?2
               AND coalesce(json_extract(metadata,'$.attempt'),0)=?7
               AND json_extract(metadata,'$.taskAddress') IS NULL
               AND coalesce(json_extract(metadata,'$.cancelRequested'),0)=0",
            params![id, user, code, Utc::now().timestamp() + 15, (!retryable).then_some(code), now(), attempt],
        )?;
        Ok(())
    }

    pub fn role_requests_for_conversation(
        &self,
        user: i64,
        device: &str,
        conversation: &str,
    ) -> Result<Vec<(String, String, Value)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,created_at,metadata FROM loop_items WHERE resource_type='stand_in_role_request'
             AND json_extract(metadata,'$.userId')=?1
             AND json_extract(metadata,'$.intent.sourceDevice')=?2
             AND json_extract(metadata,'$.intent.roleDelegation.ancestors[0]')=?3
             ORDER BY json_extract(metadata,'$.resultReceipt') IS NULL DESC,created_at DESC,id DESC LIMIT 64",
        )?;
        let rows = statement.query_map(params![user, device, conversation], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (id, created_at, raw) = row?;
            let metadata = serde_json::from_str(&raw)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            Ok((id, created_at, metadata))
        })
        .collect()
    }

    pub fn due_remote_stand_in_role_results(
        &self,
        user: i64,
        device: &str,
        backend: &str,
    ) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,metadata FROM loop_items WHERE resource_type='stand_in_role_request'
             AND json_extract(metadata,'$.userId')=?1
             AND json_extract(metadata,'$.intent.sourceDevice')=?2
             AND json_extract(metadata,'$.intent.backendUrl')=?3
             AND json_extract(metadata,'$.intent.sourceRoute') IS NOT NULL
             AND (json_extract(metadata,'$.taskAddress') IS NOT NULL
                  OR json_extract(metadata,'$.terminalError') IS NOT NULL
                  OR json_extract(metadata,'$.cancelRequested')=1)
             AND json_extract(metadata,'$.resultReceipt') IS NULL
             AND coalesce(json_extract(metadata,'$.retryAt'),0)<=?4
             ORDER BY coalesce(json_extract(metadata,'$.retryAt'),0),created_at,id LIMIT 4",
        )?;
        let rows = statement.query_map(
            params![user, device, backend, Utc::now().timestamp()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| {
            let (id, raw) = row?;
            let metadata = serde_json::from_str(&raw)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            Ok((id, metadata))
        })
        .collect()
    }

    pub fn record_remote_stand_in_role_result(
        &self,
        id: &str,
        user: i64,
        attempt: u64,
        status: &str,
        receipt: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "UPDATE loop_items SET metadata=CASE WHEN ?5 IS NOT NULL
               THEN json_remove(json_set(metadata,'$.resultStatus',?3,'$.resultReceipt',?5,
                   '$.resolvedResult',json_extract(metadata,'$.pendingResult')),'$.pendingResult','$.retryAt')
               ELSE json_set(metadata,'$.resultStatus',?3,'$.retryAt',?4) END,updated_at=?6
             WHERE id=?1 AND resource_type='stand_in_role_request' AND json_extract(metadata,'$.userId')=?2 AND coalesce(json_extract(metadata,'$.attempt'),0)=?7
               AND json_extract(metadata,'$.resultReceipt') IS NULL",
            params![id, user, status, Utc::now().timestamp() + 15, receipt, now(), attempt],
        )?;
        Ok(())
    }

    pub fn stage_remote_stand_in_role_result(
        &self,
        id: &str,
        user: i64,
        attempt: u64,
        result: &Value,
    ) -> Result<bool, TaskRuntimeError> {
        Ok(self.connection()?.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.pendingResult',json(?3),'$.resultStatus',?4),updated_at=?5
             WHERE id=?1 AND resource_type='stand_in_role_request' AND json_extract(metadata,'$.userId')=?2
               AND coalesce(json_extract(metadata,'$.attempt'),0)=?6
               AND json_extract(metadata,'$.resultReceipt') IS NULL
               AND (json_extract(metadata,'$.pendingResult') IS NULL
                    OR json_extract(metadata,'$.pendingResult')=json(?3))",
            params![id,user,result.to_string(),result["status"].as_str(),now(),attempt],
        )? == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_survives_reopen_and_binds_retries_to_the_original_target() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let intent = json!({"sourceDevice":"desktop","targetDevice":"cloud","roleId":"writer"});
        LocalTaskStore::open(&path)
            .unwrap()
            .reserve_stand_in_role_request("first", 7, "request", &intent, 1)
            .unwrap();
        let store = LocalTaskStore::open(path).unwrap();
        assert!(matches!(
            store.record_stand_in_role_task_address("first", 7, 0, "another-device"),
            Err(TaskRuntimeError::TaskNotFound)
        ));
        store
            .record_stand_in_role_task_address("first", 7, 0, "cloud")
            .unwrap();
        store
            .reserve_stand_in_role_request("first", 7, "request", &intent, 1)
            .unwrap();
        let mut other_target = intent.clone();
        other_target["targetDevice"] = json!("another-device");
        assert!(matches!(
            store.reserve_stand_in_role_request("first", 7, "request", &other_target, 1),
            Err(TaskRuntimeError::VersionConflict)
        ));
        assert!(matches!(
            store.reserve_stand_in_role_request("second", 7, "request", &intent, 1),
            Err(TaskRuntimeError::StandInRoleRequestLimit)
        ));
        store
            .reserve_stand_in_role_request("unrelated", 8, "request", &intent, 1)
            .unwrap();
    }

    #[test]
    fn prerequisites_must_already_exist_in_the_requesters_delegation_scope() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let predecessor = json!({"sourceDevice":"desktop","sourceTaskId":"conversation",
            "roleDelegation":{"ancestors":["conversation"]}});
        store
            .reserve_stand_in_role_request("prerequisite", 7, "root", &predecessor, 16)
            .unwrap();
        let mut dependent = predecessor.clone();
        dependent["dependsOn"] = json!(["prerequisite"]);
        store
            .reserve_stand_in_role_request("consumer", 7, "root", &dependent, 16)
            .unwrap();
        for (owner, root, device, parent) in [
            (8, "root", "desktop", "conversation"),
            (7, "other-root", "desktop", "conversation"),
            (7, "root", "remote", "conversation"),
            (7, "root", "desktop", "unrelated-worker"),
        ] {
            dependent["sourceDevice"] = json!(device);
            dependent["sourceTaskId"] = json!(parent);
            assert!(matches!(
                store.reserve_stand_in_role_request("unauthorized", owner, root, &dependent, 16),
                Err(TaskRuntimeError::StandInRoleDependencyInvalid)
            ));
        }
    }

    #[test]
    fn branch_cancellation_survives_reopen_and_excludes_other_branches_and_owners() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let backend = "https://example.test";
        let store = LocalTaskStore::open(&path).unwrap();
        for (id, owner, root, ancestors) in [
            ("engineering", 7, "root", json!(["conversation"])),
            (
                "database",
                7,
                "root",
                json!(["conversation", "engineering"]),
            ),
            ("announcement", 7, "root", json!(["conversation"])),
            ("new-request", 7, "other", json!(["conversation"])),
            ("foreign", 8, "root", json!(["conversation", "engineering"])),
        ] {
            let intent = json!({"sourceDevice":"desktop","sourceRoute":"desktop-route",
                "targetDevice":"cloud","backendUrl":backend,"roleDelegation":{"ancestors":ancestors}});
            store
                .reserve_stand_in_role_request(id, owner, root, &intent, 16)
                .unwrap();
        }
        store
            .record_stand_in_role_task_address("engineering", 7, 0, "cloud")
            .unwrap();
        let mut cancelled = store
            .request_stand_in_role_cancellation(
                7,
                "desktop",
                "conversation",
                "root",
                Some("engineering"),
            )
            .unwrap();
        cancelled.sort();
        assert_eq!(cancelled, ["database", "engineering"]);
        drop(store);

        let store = LocalTaskStore::open(path).unwrap();
        assert!(store
            .request_stand_in_role_cancellation(
                7,
                "desktop",
                "conversation",
                "root",
                Some("engineering")
            )
            .unwrap()
            .is_empty());
        let queued = store
            .pending_remote_stand_in_role_requests(7, "desktop", backend)
            .unwrap();
        assert_eq!(queued.len(), 2);
        assert!(queued
            .iter()
            .all(|(id, _)| matches!(id.as_str(), "announcement" | "new-request")));
        let branches = store
            .remote_stand_in_role_requests(7, "desktop", "root")
            .unwrap();
        let mut batch = store
            .remote_stand_in_role_requests_for_roots(7, "desktop", &["root", "other", "root"])
            .unwrap()
            .into_iter()
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        batch.sort();
        assert_eq!(
            batch,
            ["announcement", "database", "engineering", "new-request"]
        );
        assert!(branches.iter().any(|(id, row)| id == "engineering"
            && row["cancelRequested"] == true
            && row["taskAddress"]["deviceId"] == "cloud"));
        assert_eq!(
            store
                .pending_remote_stand_in_role_requests(8, "desktop", backend)
                .unwrap()[0]
                .0,
            "foreign"
        );
        let database = branches.iter().find(|(id, _)| id == "database").unwrap();
        assert!(store
            .matching_stand_in_role_request("database", 7, &database.1["intent"], Some(false))
            .unwrap()
            .is_none());
        assert!(matches!(
            store.reserve_stand_in_role_request("late-child", 7, "root", &database.1["intent"], 16),
            Err(TaskRuntimeError::StandInRoleRequestCancelled)
        ));

        assert!(!store
            .request_stand_in_role_cancellation(7, "desktop", "conversation", "root", None)
            .unwrap()
            .is_empty());
        let announcement = branches
            .iter()
            .find(|(id, _)| id == "announcement")
            .unwrap();
        assert!(matches!(
            store.reserve_stand_in_role_request(
                "late-sibling",
                7,
                "root",
                &announcement.1["intent"],
                16
            ),
            Err(TaskRuntimeError::StandInRoleRequestCancelled)
        ));
    }

    #[test]
    fn reconnect_recovers_only_the_scoped_unacknowledged_dispatches() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let backend = "https://example.test";
        let intent = json!({"sourceDevice":"desktop","sourceRoute":"desktop-route",
            "targetDevice":"cloud","backendUrl":backend,
            "roleDelegation":{"ancestors":["original-conversation","source-task"]}});
        let store = LocalTaskStore::open(&path).unwrap();
        for id in ["pending", "accepted", "denied", "offline"] {
            store
                .reserve_stand_in_role_request(id, 7, "root", &intent, 4)
                .unwrap();
        }
        store
            .record_stand_in_role_task_address("accepted", 7, 0, "cloud")
            .unwrap();
        store
            .record_stand_in_role_route_failure("denied", 7, 0, "permission_denied", false)
            .unwrap();
        store
            .record_stand_in_role_route_failure("offline", 7, 0, "device_offline", true)
            .unwrap();
        drop(store);
        let store = LocalTaskStore::open(path).unwrap();
        let pending = store
            .pending_remote_stand_in_role_requests(7, "desktop", backend)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, "pending");
        assert_eq!(pending[0].1["intent"], intent);
        assert!(store
            .pending_remote_stand_in_role_requests(8, "desktop", backend)
            .unwrap()
            .is_empty());
        assert!(store
            .pending_remote_stand_in_role_requests(7, "cloud", backend)
            .unwrap()
            .is_empty());
        let branches = store
            .role_requests_for_conversation(7, "desktop", "original-conversation")
            .unwrap();
        assert_eq!(branches.len(), 4);
        assert!(branches
            .iter()
            .any(|(id, _, row)| { id == "accepted" && row["taskAddress"]["deviceId"] == "cloud" }));
        for (user, device, conversation) in [
            (8, "desktop", "original-conversation"),
            (7, "cloud", "original-conversation"),
            (7, "desktop", "source-task"),
        ] {
            assert!(store
                .role_requests_for_conversation(user, device, conversation)
                .unwrap()
                .is_empty());
        }
        assert!(store
            .matching_stand_in_role_request("accepted", 8, &intent, Some(false))
            .unwrap()
            .is_none());
        assert!(store
            .matching_stand_in_role_request("accepted", 7, &intent, Some(false))
            .unwrap()
            .is_some());
        store.connection().unwrap().execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.retryAt',0) WHERE id='offline'",
            [],
        ).unwrap();
        let recovered = store
            .pending_remote_stand_in_role_requests(7, "desktop", backend)
            .unwrap();
        assert_eq!(recovered.len(), 2);
        assert!(recovered
            .iter()
            .any(|(id, saved)| id == "offline" && saved["intent"] == intent));
        assert!(matches!(
            store.record_stand_in_role_task_address("denied", 7, 0, "cloud"),
            Err(TaskRuntimeError::TaskNotFound)
        ));
    }

    #[test]
    fn remote_result_is_immutable_until_delivered_and_receipt_survives_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let backend = "https://example.test";
        let intent = json!({"sourceDevice":"desktop","sourceRoute":"desktop-route",
            "targetDevice":"cloud","backendUrl":backend});
        let store = LocalTaskStore::open(&path).unwrap();
        store
            .reserve_stand_in_role_request("task", 7, "root", &intent, 1)
            .unwrap();
        store
            .record_stand_in_role_task_address("task", 7, 0, "cloud")
            .unwrap();
        let result = json!({"status":"done","resultId":"first","conclusion":"Verified result"});
        assert!(store
            .stage_remote_stand_in_role_result("task", 7, 0, &result)
            .unwrap());
        assert!(store
            .stage_remote_stand_in_role_result("task", 7, 0, &result)
            .unwrap());
        assert!(!store
            .stage_remote_stand_in_role_result(
                "task",
                7,
                0,
                &json!({"status":"failed","resultId":"later"}),
            )
            .unwrap());
        drop(store);
        let store = LocalTaskStore::open(path).unwrap();
        let pending = store
            .due_remote_stand_in_role_results(7, "desktop", backend)
            .unwrap();
        assert_eq!(pending[0].1["pendingResult"], result);
        store
            .record_remote_stand_in_role_result("task", 7, 0, "done", Some("first"))
            .unwrap();
        assert!(store
            .due_remote_stand_in_role_results(7, "desktop", backend)
            .unwrap()
            .is_empty());
        let requests = store
            .remote_stand_in_role_requests(7, "desktop", "root")
            .unwrap();
        assert_eq!(requests[0].1["resultReceipt"], "first");
        assert!(requests[0].1["pendingResult"].is_null());
        assert_eq!(requests[0].1["resolvedResult"], result);
    }

    #[test]
    fn retry_uses_the_same_intent_and_accepts_each_attempt_only_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let intent = json!({"sourceDevice":"desktop","sourceRoute":"owned-desktop",
            "targetDevice":"cloud","backendUrl":"backend"});
        store
            .reserve_stand_in_role_request("task", 7, "root", &intent, 1)
            .unwrap();
        store
            .record_stand_in_role_task_address("task", 7, 0, "cloud")
            .unwrap();
        store
            .stage_remote_stand_in_role_result("task", 7, 0, &json!({"status":"failed"}))
            .unwrap();
        store
            .record_remote_stand_in_role_result("task", 7, 0, "failed", Some("first"))
            .unwrap();
        assert!(!store.retry_stand_in_role_request("task", 8, 0).unwrap());
        assert!(store.retry_stand_in_role_request("task", 7, 0).unwrap());
        drop(store);
        let store = LocalTaskStore::open(path).unwrap();
        assert!(!store.retry_stand_in_role_request("task", 7, 0).unwrap());
        let row = store.stand_in_role_request("task", 7).unwrap().unwrap();
        assert_eq!(row["attempt"], 1);
        assert_eq!(row["intent"], intent);
        assert!(row["taskAddress"].is_null() && row["resolvedResult"].is_null());
        assert_eq!(
            store
                .pending_remote_stand_in_role_requests(7, "desktop", "backend")
                .unwrap(),
            vec![("task".into(), row)]
        );
    }
}
