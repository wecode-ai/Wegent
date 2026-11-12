use super::*;

impl LocalTaskStore {
    pub fn complete_execution(
        &self,
        execution_id: i64,
        content: Option<&str>,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = execution_row(&transaction, execution_id)?;
        let timestamp = now();
        let changed = transaction.execute(
            "UPDATE loop_item_executions
             SET status = 'completed', completed_at = ?1, lease_expires_at = NULL,
                 observed_state = 'succeeded', sync_state = 'in_sync', observed_at = ?1,
                 execution_note = ?2, termination_reason = 'runtime_succeeded',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('claimed', 'running', 'cancel_requested')",
            params![timestamp, content.unwrap_or(""), execution_id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return execution_row(&connection, execution_id).map(Some);
        }
        update_agent_comment(
            &transaction,
            execution_id,
            &execution_row(&transaction, execution_id)?.status,
            content.unwrap_or(""),
            &timestamp,
        )?;
        let dispatch_role = current
            .execution_payload
            .as_ref()
            .and_then(|payload| payload.get("dispatch_role"))
            .and_then(Value::as_str);
        if !matches!(dispatch_role, Some("manager" | "member")) {
            let project = work_container_from(&transaction, &current.cloud_project_id)?
                .ok_or(TaskRuntimeError::ProjectNotFound)?;
            let next_status = current.task_status.as_deref().map(|status| {
                project_status::runtime_transition_status(&project.metadata, status, "in_review")
            });
            transaction.execute(
                "UPDATE loop_items
                 SET status = ?3,
                     metadata = json_set(metadata, '$.is_unread', json('true')),
                     version = version + 1, updated_at = ?1
                 WHERE id = ?2 AND status != 'completed'
                   AND NOT EXISTS (
                       SELECT 1 FROM loop_item_comments pending_comment
                       WHERE pending_comment.task_id=?2
                         AND pending_comment.deleted_at IS NULL
                         AND pending_comment.status IN ('pending','streaming')
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM loop_item_executions active_execution
                       WHERE active_execution.loop_item_id=?2
                         AND active_execution.status IN (
                             'queued','pending_approval','claimed','running',
                             'cancel_requested'
                         )
                   )",
                params![timestamp, current.loop_item_id, next_status],
            )?;
            local_automation::on_status_changed(
                &transaction,
                &current.loop_item_id,
                current.task_status.as_deref(),
                current
                    .execution_payload
                    .as_ref()
                    .and_then(|payload| payload["automation_run_id"].as_str()),
            )?;
        }
        transaction.commit()?;
        drop(connection);
        self.resume_manager_for_finished_round(execution_id)?;
        let connection = self.connection()?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn fail_execution(
        &self,
        execution_id: i64,
        error: &str,
        requeue: bool,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        self.fail_execution_with_outcome(execution_id, error, requeue, false)
    }

    /// Record a definite Runtime refusal; transport uncertainty must use `fail_execution`.
    pub fn reject_runtime_dispatch(
        &self,
        execution_id: i64,
        error: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        self.fail_execution_with_outcome(execution_id, error, false, true)
    }

    fn fail_execution_with_outcome(
        &self,
        execution_id: i64,
        error: &str,
        requeue: bool,
        rejected: bool,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = execution_row(&transaction, execution_id)?;
        if matches!(
            current.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            transaction.rollback()?;
            return Ok(Some(current));
        }
        let timestamp = now();
        let error = truncate(error, 2000);
        let changed = transaction.execute(
            "UPDATE loop_item_executions
             SET status = 'failed', completed_at = ?1, lease_expires_at = NULL,
                 observed_state = 'failed', sync_state = 'in_sync', observed_at = ?1,
                 error_message = ?2, termination_reason = 'runtime_failed',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('claimed', 'running', 'cancel_requested')",
            params![timestamp, error, execution_id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return execution_row(&connection, execution_id).map(Some);
        }
        update_agent_comment(&transaction, execution_id, "failed", &error, &timestamp)?;
        if rejected {
            human_requests::reject_execution_reply(&transaction, &current)?;
        }
        if requeue && current.retry_attempt < current.max_retries {
            transaction.execute(
                "INSERT INTO loop_item_executions (
                    loop_item_id, cloud_project_id, agent_id, execution_environment,
                    execution_device_id, assigner_user_id, status, priority_weight,
                    queued_at, retry_attempt, max_retries, error_message, execution_note,
                    approval_status, approved_by_user_id, approved_at, execution_payload,
                    attempt_no, previous_execution_id, execution_scope,
                    observed_state, sync_state, version, created_at, updated_at
                 )
                 SELECT loop_item_id, cloud_project_id, agent_id, execution_environment,
                        execution_device_id, assigner_user_id, 'queued', priority_weight,
                        ?1, retry_attempt + 1, max_retries, ?2, execution_note,
                        approval_status, approved_by_user_id, approved_at, execution_payload,
                        attempt_no + 1, id, execution_scope,
                        'unconfirmed', 'pending', 1, ?1, ?1
                 FROM loop_item_executions WHERE id = ?3",
                params![timestamp, error, execution_id],
            )?;
            let retry_id = transaction.last_insert_rowid();
            create_execution_comment(&transaction, retry_id, "pending", "")?;
            transaction.commit()?;
            return execution_row(&connection, retry_id).map(Some);
        }
        transaction.commit()?;
        drop(connection);
        self.resume_manager_for_finished_round(execution_id)?;
        let connection = self.connection()?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn fail_runtime_preflight(
        &self,
        execution_id: i64,
        error: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = execution_row(&transaction, execution_id)?;
        if !matches!(current.status.as_str(), "queued" | "claimed")
            || current.start_requested_at.is_some()
        {
            transaction.rollback()?;
            return Ok(Some(current));
        }
        let timestamp = now();
        let error = truncate(error, 2000);
        let changed = transaction.execute(
            "UPDATE loop_item_executions
             SET status = 'failed', completed_at = ?1, lease_expires_at = NULL,
                 sync_state = 'in_sync', error_message = ?2,
                 termination_reason = 'runtime_preflight_failed',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('queued', 'claimed') AND start_requested_at IS NULL",
            params![timestamp, error, execution_id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return execution_row(&connection, execution_id).map(Some);
        }
        update_agent_comment(&transaction, execution_id, "failed", &error, &timestamp)?;
        human_requests::reject_unstarted_execution_reply(&transaction, &current)?;
        transaction.commit()?;
        drop(connection);
        self.resume_manager_for_finished_round(execution_id)?;
        let connection = self.connection()?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn cancel_execution_observed(
        &self,
        execution_id: i64,
        note: Option<&str>,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = now();
        let message = note.unwrap_or("Runtime task was cancelled");
        let changed = transaction.execute(
            "UPDATE loop_item_executions
             SET status = 'cancelled', completed_at = ?1, lease_expires_at = NULL,
                 observed_state = 'cancelled', sync_state = 'in_sync', observed_at = ?1,
                 execution_note = ?2, termination_reason = 'runtime_cancelled',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('claimed', 'running', 'cancel_requested')",
            params![timestamp, message, execution_id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return execution_row(&connection, execution_id).map(Some);
        }
        update_agent_comment(&transaction, execution_id, "cancelled", message, &timestamp)?;
        transaction.commit()?;
        drop(connection);
        self.resume_manager_for_finished_round(execution_id)?;
        let connection = self.connection()?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn recover_stale_local_executions(&self) -> Result<(u64, u64), TaskRuntimeError> {
        let connection = self.connection()?;
        let stale: Vec<i64> = {
            let mut statement = connection.prepare(
                "SELECT id FROM loop_item_executions
                 WHERE status IN ('claimed', 'running', 'cancel_requested')
                   AND lease_expires_at IS NOT NULL
                   AND lease_expires_at < ?1",
            )?;
            let rows = statement.query_map(params![now()], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut requeued = 0u64;
        let mut unknown = 0u64;
        for id in stale {
            let current = execution_row(&connection, id)?;
            let now = now();
            if current.status == "claimed" && current.start_requested_at.is_none() {
                connection.execute(
                    "UPDATE loop_item_executions
                     SET status = 'queued', queued_at = ?1, lease_expires_at = NULL,
                         claimed_at = NULL, observed_state = 'unconfirmed',
                         sync_state = 'pending', error_message = ?2,
                         version = version + 1, updated_at = ?1
                     WHERE id = ?3",
                    params![now, "Unstarted claim lease expired locally", id],
                )?;
                requeued += 1;
            } else {
                connection.execute(
                    "UPDATE loop_item_executions
                     SET sync_state = 'stale',
                         error_message = CASE
                           WHEN termination_reason = 'runtime_dispatch_unknown'
                                AND error_message != ''
                           THEN error_message ELSE ?2 END,
                         termination_reason = CASE
                           WHEN termination_reason = 'runtime_dispatch_unknown'
                           THEN termination_reason ELSE 'runtime_observation_stale' END,
                         version = version + 1, updated_at = ?1
                     WHERE id = ?3",
                    params![now, "Runtime state requires reconciliation", id],
                )?;
                unknown += 1;
            }
        }
        Ok((requeued, unknown))
    }

    pub fn stale_local_executions(&self) -> Result<Vec<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let ids = {
            let mut statement = connection.prepare(
                "SELECT id FROM loop_item_executions
                 WHERE status IN ('claimed', 'running', 'cancel_requested')
                   AND sync_state = 'stale'
                   AND runtime_device_id IS NOT NULL
                   AND runtime_device_id != ''
                   AND runtime_task_id IS NOT NULL
                   AND runtime_task_id != ''
                 ORDER BY observed_at ASC, id ASC",
            )?;
            let rows = statement.query_map([], |row| row.get(0))?;
            rows.collect::<Result<Vec<i64>, _>>()?
        };
        ids.into_iter()
            .map(|id| execution_row(&connection, id))
            .collect()
    }

    /// Enqueue a local robot run for a comment-triggered execution and create
    /// the optimistic agent comment that tracks its status in the task thread.
    pub fn enqueue_execution(
        &self,
        project_id: &str,
        task_id: &str,
        agent_id: &str,
        mut payload: Value,
        trigger_message_id: Option<&str>,
    ) -> Result<LocalExecution, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let group_owned = get_item_from(&connection, project_id, "chat_group")?.is_some();
        if group_owned {
            chat_groups::require_participation(&connection, project_id, task_id, true)?;
        }
        let agent = if group_owned {
            task_resource_agent(&connection, project_id, task_id, agent_id)?
        } else {
            get_item_from(&connection, agent_id, "chat_agent")?.ok_or_else(|| {
                TaskRuntimeError::Invalid("Robot is not active in this project".to_owned())
            })?
        };
        let task =
            get_item_from(&connection, task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        if (!group_owned && agent.cloud_project_id.as_deref() != Some(project_id))
            || agent.status.as_deref() != Some("active")
            || task.cloud_project_id.as_deref() != Some(project_id)
        {
            return Err(TaskRuntimeError::Invalid(
                "Robot or Issue is not active in this project".into(),
            ));
        }
        if let Some(trigger) = trigger_message_id {
            let trigger_record = comment_row(&connection, trigger)?;
            if trigger_record.project_id != project_id || trigger_record.task_id != task_id {
                return Err(TaskRuntimeError::Invalid(
                    "Comment does not belong to this Issue".into(),
                ));
            }
            let existing: Option<i64> = connection.query_row(
                "SELECT id FROM loop_item_executions WHERE loop_item_id=?1 AND agent_id=?2 AND json_extract(execution_payload, '$.trigger_message_id')=?3 ORDER BY id DESC LIMIT 1",
                params![task_id, agent_id, trigger], |row| row.get(0),
            ).optional()?;
            if let Some(id) = existing {
                let existing = execution_row(&connection, id)?;
                resource_bindings::require_current_comment_crew(
                    &connection,
                    project_id,
                    task_id,
                    agent_id,
                    existing.execution_payload.as_ref().unwrap_or(&Value::Null),
                )?;
                return execution_row(&connection, id);
            }
            payload = local_execution_activity::comment_execution_payload(
                &connection,
                &trigger_record,
                agent_id,
                payload,
            )?;
            if !payload.is_object() {
                payload = json!({});
            }
            payload["trigger_message_id"] = json!(trigger);
            if let Some(request_id) = payload["human_request_id"].as_str() {
                let user = trigger_record.sender_id.parse::<i64>().map_err(|_| {
                    TaskRuntimeError::Invalid("A human reply requires a valid sender".into())
                })?;
                let question = human_requests::claim_reply_on(
                    &connection,
                    project_id,
                    task_id,
                    request_id,
                    user,
                    trigger,
                )?;
                if payload["continueTaskId"] != question["runtime_task_id"] {
                    return Err(TaskRuntimeError::Invalid(
                        "Question execution binding changed".into(),
                    ));
                }
            }
        }
        if trigger_message_id.is_some() {
            resource_bindings::require_current_comment_crew(
                &connection,
                project_id,
                task_id,
                agent_id,
                &payload,
            )?;
        }
        let execution_id = create_local_execution(
            &connection,
            task_id,
            project_id,
            agent_id,
            &agent,
            task.priority.as_deref().unwrap_or("none"),
            payload.clone(),
        )?;
        let execution = execution_row(&connection, execution_id)?;
        connection.commit()?;
        Ok(execution)
    }

    pub fn local_execution_payload(
        &self,
        execution_id: i64,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let payload: Option<String> = connection.query_row(
            "SELECT execution_payload FROM loop_item_executions WHERE id = ?1",
            params![execution_id],
            |row| row.get(0),
        )?;
        Ok(payload
            .and_then(|value| serde_json::from_str(&value).ok())
            .filter(Value::is_object))
    }
}
