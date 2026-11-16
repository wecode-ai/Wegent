use super::*;

impl LocalTaskStore {
    pub fn list_executions(
        &self,
        project_id: &str,
        agent_id: Option<&str>,
        status_filter: Option<&str>,
        include_terminal: bool,
    ) -> Result<Vec<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut sql = String::from(
            "SELECT e.id, e.loop_item_id, e.cloud_project_id, e.agent_id,
                    e.assigner_user_id, e.execution_environment, e.execution_device_id,
                    e.status, e.priority_weight, e.queued_at, e.started_at, e.completed_at,
                    e.lease_expires_at, e.heartbeat_at, e.retry_attempt, e.error_message,
                    e.execution_note, e.approval_status, e.approved_by_user_id,
                    e.rejected_reason, e.runtime_device_id, e.runtime_task_id,
                    e.execution_payload, e.max_retries, e.version, e.created_at,
                    e.updated_at, e.attempt_no, e.previous_execution_id,
                    e.execution_scope, e.observed_state, e.sync_state,
                    e.claimed_at, e.start_requested_at, e.observed_at,
                    e.cancel_requested_at, e.last_event_seq, e.termination_reason,
                    COALESCE(t.title, t.name, ''), t.status, t.priority,
                    a.name, a.title, a.metadata, e.runtime_instance_id
             FROM loop_item_executions e
             LEFT JOIN loop_items t ON t.id = e.loop_item_id
             LEFT JOIN loop_items a ON a.id = e.agent_id
             WHERE e.cloud_project_id = ?1",
        );
        if agent_id.is_some() {
            sql.push_str(" AND e.agent_id = ?2");
        }
        if status_filter.is_some() {
            sql.push_str(" AND e.status = ?3");
        } else if !include_terminal {
            sql.push_str(
                " AND e.status IN ('pending_approval', 'queued', 'claimed', 'running',
                                   'cancel_requested')",
            );
        }
        sql.push_str(" ORDER BY e.priority_weight DESC, e.queued_at ASC, e.id ASC");
        let mut statement = connection.prepare(&sql)?;
        let rows = match (agent_id, status_filter) {
            (Some(agent_id), Some(status)) => {
                statement.query_map(params![project_id, agent_id, status], map_execution)?
            }
            (Some(agent_id), None) => {
                statement.query_map(params![project_id, agent_id], map_execution)?
            }
            (None, Some(status)) => {
                // The SQL always references ?3 for the status filter; bind an
                // explicit NULL agent so the placeholder count stays aligned.
                statement.query_map(params![project_id, None::<String>, status], map_execution)?
            }
            (None, None) => statement.query_map(params![project_id], map_execution)?,
        };
        let mut executions = Vec::new();
        for execution in rows {
            executions.push(execution?);
        }
        Ok(executions)
    }

    /// Resolve a local execution by the runtime task id assigned to it. The
    /// App dispatcher records the id with `heartbeat_execution` after it
    /// starts the run, so terminal runtime events can write the outcome back.
    pub fn execution_by_runtime_task_id(
        &self,
        runtime_task_id: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let execution_id: Option<i64> = connection
            .query_row(
                "SELECT id FROM loop_item_executions
                 WHERE runtime_task_id = ?1
                   AND status IN ('claimed', 'running', 'cancel_requested')
                 ORDER BY id DESC LIMIT 1",
                params![runtime_task_id],
                |row| row.get(0),
            )
            .optional()?;
        match execution_id {
            Some(id) => execution_row(&connection, id).map(Some),
            None => Ok(None),
        }
    }

    pub fn approve_execution(&self, execution_id: i64) -> Result<LocalExecution, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "pending_approval" {
            return Err(TaskRuntimeError::Invalid(
                "Run is not waiting for robot approval".to_owned(),
            ));
        }
        let now = now();
        connection.execute(
            "UPDATE loop_item_executions
             SET status = 'queued', queued_at = ?1, approval_status = 'approved',
                 approved_at = ?1, version = version + 1, updated_at = ?1
             WHERE id = ?2",
            params![now, execution_id],
        )?;
        execution_row(&connection, execution_id)
    }

    pub fn reject_execution(
        &self,
        execution_id: i64,
        reason: Option<String>,
    ) -> Result<LocalExecution, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "pending_approval" {
            return Err(TaskRuntimeError::Invalid(
                "Run is not waiting for robot approval".to_owned(),
            ));
        }
        let now = now();
        let reason = reason.unwrap_or_else(|| "Robot creator rejected the run".to_owned());
        connection.execute(
            "UPDATE loop_item_executions
             SET status = 'cancelled', approval_status = 'rejected',
                 rejected_reason = ?1, execution_note = ?1, completed_at = ?2,
                 observed_state = 'cancelled', sync_state = 'in_sync', observed_at = ?2,
                 termination_reason = 'approval_rejected',
                 version = version + 1, updated_at = ?2
             WHERE id = ?3",
            params![reason, now, execution_id],
        )?;
        update_agent_comment(&connection, execution_id, "cancelled", &reason, &now)?;
        execution_row(&connection, execution_id)
    }

    pub fn cancel_execution(
        &self,
        execution_id: i64,
        note: Option<&str>,
    ) -> Result<LocalExecution, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = execution_row(&transaction, execution_id)?;
        if matches!(
            current.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            transaction.rollback()?;
            return Ok(current);
        }

        let timestamp = now();
        let message = note.unwrap_or("AI execution was cancelled");
        let start_was_delivered = current.start_requested_at.is_some();
        if matches!(
            current.status.as_str(),
            "pending_approval" | "queued" | "waiting_runtime"
        ) || (current.status == "claimed" && !start_was_delivered)
        {
            let changed = transaction.execute(
                "UPDATE loop_item_executions
                 SET status = 'cancelled', completed_at = ?1, lease_expires_at = NULL,
                     observed_state = 'cancelled', sync_state = 'in_sync', observed_at = ?1,
                     cancel_requested_at = ?1, execution_note = ?2,
                     termination_reason = 'cancelled_before_start',
                     version = version + 1, updated_at = ?1
                 WHERE id = ?3 AND status = ?4 AND version = ?5",
                params![
                    timestamp,
                    message,
                    execution_id,
                    current.status,
                    current.version
                ],
            )?;
            if changed != 1 {
                transaction.rollback()?;
                return execution_row(&connection, execution_id);
            }
            update_agent_comment(&transaction, execution_id, "cancelled", message, &timestamp)?;
            transaction.commit()?;
            return execution_row(&connection, execution_id);
        }

        if !matches!(
            current.status.as_str(),
            "claimed" | "running" | "cancel_requested"
        ) {
            transaction.rollback()?;
            return Err(TaskRuntimeError::Invalid(format!(
                "Execution {} cannot be cancelled from status {}",
                execution_id, current.status
            )));
        }
        if current
            .runtime_device_id
            .as_deref()
            .unwrap_or("")
            .is_empty()
            || current.runtime_task_id.as_deref().unwrap_or("").is_empty()
        {
            transaction.rollback()?;
            return Err(TaskRuntimeError::Invalid(format!(
                "Delivered execution {execution_id} has no runtime identity"
            )));
        }
        if current.status != "cancel_requested" {
            let changed = transaction.execute(
                "UPDATE loop_item_executions
                 SET status = 'cancel_requested', cancel_requested_at = ?1,
                     sync_state = 'pending', execution_note = ?2,
                     version = version + 1, updated_at = ?1
                 WHERE id = ?3 AND status IN ('claimed', 'running') AND version = ?4",
                params![timestamp, message, execution_id, current.version],
            )?;
            if changed != 1 {
                transaction.rollback()?;
                return execution_row(&connection, execution_id);
            }
        }
        transaction.commit()?;
        execution_row(&connection, execution_id)
    }
}
