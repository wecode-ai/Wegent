use super::*;

impl LocalTaskStore {
    pub fn claim_next_local_execution(
        &self,
        claim: &LocalExecutionClaim,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        self.claim_next_execution_for_runtime(
            claim.execution_device_id.as_deref(),
            &claim.runtime_instance_id,
            claim.lease_seconds,
        )
    }

    pub fn claim_next_execution_for_runtime(
        &self,
        execution_device_id: Option<&str>,
        runtime_instance_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        self.claim_next_execution_with_catalog(
            execution_device_id,
            runtime_instance_id,
            lease_seconds,
            None,
        )
    }

    pub fn has_queued_executions(&self) -> Result<bool, TaskRuntimeError> {
        Ok(self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_item_executions WHERE execution_environment='local' AND status='queued')",
            [], |row| row.get(0),
        )?)
    }

    pub fn claim_next_execution_with_catalog(
        &self,
        execution_device_id: Option<&str>,
        runtime_instance_id: &str,
        lease_seconds: u64,
        catalog: Option<&Value>,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        if runtime_instance_id.trim().is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "Runtime instance identity is required".to_owned(),
            ));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut sql = String::from(
            "SELECT e.id, e.execution_scope
             FROM loop_item_executions e
             WHERE e.execution_environment = 'local' AND e.status = 'queued'",
        );
        if execution_device_id.is_some() {
            // Robots created before device binding have no bound device; the
            // claiming Executor adopts those runs atomically.
            sql.push_str(
                " AND (e.execution_device_id = ?1
                     OR e.execution_device_id IS NULL
                     OR e.execution_device_id = '')",
            );
        }
        sql.push_str(" ORDER BY e.priority_weight DESC, e.queued_at ASC, e.id ASC");
        let mut statement = connection.prepare(&sql)?;
        let candidates = if let Some(device_id) = execution_device_id {
            statement
                .query_map(params![device_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let occupied_scopes = {
            let mut statement = connection.prepare(
                "SELECT execution_scope FROM loop_item_executions
                 WHERE status IN ('claimed', 'running', 'cancel_requested')
                   AND execution_scope != ''",
            )?;
            let scopes = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            scopes
        };
        let Some((candidate_id, _)) = candidates.into_iter().find(|(_, execution_scope)| {
            execution_scope.is_empty() || !occupied_scopes.contains(execution_scope)
        }) else {
            return Ok(None);
        };
        let now = now();
        let runtime_device_id = execution_device_id.unwrap_or("local-device");
        let pending = execution_row(&connection, candidate_id)?;
        project_coordination_commands::authorize_execution_on(&connection, &pending)?;
        let issue = get_item_from(&connection, &pending.loop_item_id, "task")?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let conflict = issue.metadata.get("runner_binding_conflict").is_some()
            || issue
                .metadata
                .pointer("/runner_binding/environment_id")
                .and_then(Value::as_str)
                .is_some_and(|bound| bound != runtime_device_id);
        let mut payload = local_execution_runtime_payload(&pending);
        let project = get_item_from(&connection, &pending.cloud_project_id, "project")?;
        if project.is_none() {
            drop(statement);
            connection.rollback()?;
            drop(guard);
            self.fail_runtime_preflight(candidate_id, "Project is unavailable")?;
            return Err(TaskRuntimeError::ProjectNotFound);
        }
        let resume_conflict = payload["resumeEnvironmentId"]
            .as_str()
            .is_some_and(|bound| bound != runtime_device_id);
        let validation = if conflict || resume_conflict {
            Err(TaskRuntimeError::Invalid(
                "ISSUE_RUNNER_CONFLICT: Issue is bound to another runner".into(),
            ))
        } else {
            crate::task_runtime::runner_routing::resolve_pending(
                &mut payload,
                catalog,
                runtime_device_id,
            )
        };
        if let Err(error) = validation {
            connection.execute("UPDATE loop_item_executions SET status='waiting_runtime', error_message=?1 WHERE id=?2", params![error.to_string(), candidate_id])?;
            drop(statement);
            connection.commit()?;
            return Err(error);
        }

        let runtime_task_id = payload["continueTaskId"]
            .as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("codex-queue-{candidate_id}"));
        let lease_seconds = lease_seconds.max(60);
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET status = 'claimed', claimed_at = ?1, heartbeat_at = ?1,
                 execution_device_id = COALESCE(NULLIF(execution_device_id, ''), ?4),
                 runtime_instance_id = ?6,
                 runtime_device_id = ?4, runtime_task_id = ?5,
                 lease_expires_at = ?2, version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status = 'queued'",
            params![
                now,
                lease_expiry(&now, lease_seconds),
                candidate_id,
                runtime_device_id,
                runtime_task_id,
                runtime_instance_id,
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        connection.execute(
            "UPDATE loop_item_executions SET execution_payload=?1 WHERE id=?2",
            params![payload.to_string(), candidate_id],
        )?;
        let mut execution = execution_row(&connection, candidate_id)?;
        drop(statement);
        connection.execute(
            "UPDATE loop_items
             SET metadata=json_set(COALESCE(metadata, '{}'), '$.runner_binding',
                 json_object('environment_id', ?1))
             WHERE id=?2 AND json_extract(metadata, '$.runner_binding') IS NULL",
            params![runtime_device_id, issue.id],
        )?;
        connection.commit()?;
        drop(guard);
        let mut payload = local_execution_runtime_payload(&execution);
        let preflight = self
            .get_project(&execution.cloud_project_id)
            .and_then(|project| {
                execution_workspace::apply_project_workspace(
                    &mut payload,
                    &project.metadata,
                    runtime_device_id,
                    &execution.cloud_project_id,
                )
            });
        if let Err(error) = preflight {
            self.fail_runtime_preflight(candidate_id, &error.to_string())?;
            return Err(error);
        }
        execution.execution_payload = Some(payload);
        Ok(Some(execution))
    }

    pub fn heartbeat_execution(
        &self,
        execution_id: i64,
        runtime_device_id: Option<&str>,
        runtime_task_id: Option<&str>,
        lease_seconds: u64,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if !matches!(
            current.status.as_str(),
            "claimed" | "running" | "cancel_requested"
        ) {
            return Ok(None);
        }
        if runtime_device_id != current.runtime_device_id.as_deref()
            || runtime_task_id != current.runtime_task_id.as_deref()
        {
            return Ok(None);
        }
        let now = now();
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET heartbeat_at = ?1, lease_expires_at = ?2,
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('claimed', 'running', 'cancel_requested')",
            params![now, lease_expiry(&now, lease_seconds.max(60)), execution_id,],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn request_runtime_start(
        &self,
        execution_id: i64,
        runtime_device_id: &str,
        runtime_task_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "claimed"
            || current.start_requested_at.is_some()
            || current.runtime_device_id.as_deref() != Some(runtime_device_id)
            || current.runtime_task_id.as_deref() != Some(runtime_task_id)
        {
            return Ok(None);
        }
        project_coordination_commands::authorize_execution_on(&connection, &current)?;
        let timestamp = now();
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET start_requested_at = ?1, heartbeat_at = ?1, lease_expires_at = ?2,
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status = 'claimed' AND start_requested_at IS NULL",
            params![
                timestamp,
                lease_expiry(&timestamp, lease_seconds.max(60)),
                execution_id,
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        ensure_execution_binding(&connection, execution_id)?;
        let execution = execution_row(&connection, execution_id)?;
        connection.commit()?;
        Ok(Some(execution))
    }

    pub fn confirm_runtime_accepted(
        &self,
        execution_id: i64,
        runtime_device_id: &str,
        runtime_task_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "claimed"
            || current.start_requested_at.is_none()
            || current.runtime_device_id.as_deref() != Some(runtime_device_id)
            || current.runtime_task_id.as_deref() != Some(runtime_task_id)
        {
            return Ok(None);
        }
        let timestamp = now();
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET observed_state = 'accepted', sync_state = 'in_sync', observed_at = ?1,
                 heartbeat_at = ?1, lease_expires_at = ?2, error_message = '',
                 termination_reason = '',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status = 'claimed'",
            params![
                timestamp,
                lease_expiry(&timestamp, lease_seconds.max(60)),
                execution_id,
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let address = json!({"deviceId": runtime_device_id, "taskId": runtime_task_id}).to_string();
        connection.execute(
            "UPDATE loop_item_comments
             SET metadata = json_set(metadata, '$.runtime_address', json(?1)),
                 updated_at = ?2
             WHERE deleted_at IS NULL
               AND json_extract(metadata, '$.execution_id') = ?3",
            params![address, timestamp, execution_id],
        )?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn mark_runtime_dispatch_unknown(
        &self,
        execution_id: i64,
        runtime_device_id: &str,
        runtime_task_id: &str,
        error: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "claimed"
            || current.start_requested_at.is_none()
            || current.runtime_device_id.as_deref() != Some(runtime_device_id)
            || current.runtime_task_id.as_deref() != Some(runtime_task_id)
        {
            return Ok(Some(current));
        }
        let timestamp = now();
        connection.execute(
            "UPDATE loop_item_executions
             SET sync_state = 'stale', error_message = ?1,
                 termination_reason = 'runtime_dispatch_unknown',
                 version = version + 1, updated_at = ?2
             WHERE id = ?3 AND status = 'claimed'",
            params![truncate(error, 2000), timestamp, execution_id],
        )?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn mark_runtime_running(
        &self,
        runtime_task_id: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = now();
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET status = CASE WHEN status = 'cancel_requested'
                               THEN status ELSE 'running' END,
                 observed_state = 'running', sync_state = 'in_sync',
                 observed_at = ?1, started_at = COALESCE(started_at, ?1),
                 heartbeat_at = ?1, lease_expires_at = ?2, error_message = '',
                 termination_reason = '',
                 version = version + 1, updated_at = ?1
             WHERE runtime_task_id = ?3
               AND status IN ('claimed', 'running', 'cancel_requested')",
            params![timestamp, lease_expiry(&timestamp, 300), runtime_task_id],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let execution_id = connection.query_row(
            "SELECT id FROM loop_item_executions WHERE runtime_task_id = ?1
             AND status IN ('running', 'cancel_requested') ORDER BY id DESC LIMIT 1",
            params![runtime_task_id],
            |row| row.get(0),
        )?;
        connection.execute("UPDATE loop_item_comments SET status='streaming', updated_at=?1 WHERE deleted_at IS NULL AND json_extract(metadata,'$.execution_id')=?2", params![timestamp, execution_id])?;
        let execution = execution_row(&connection, execution_id)?;
        let dispatch_role = execution
            .execution_payload
            .as_ref()
            .and_then(|payload| payload.get("dispatch_role"))
            .and_then(Value::as_str);
        if !matches!(dispatch_role, Some("manager" | "member")) {
            move_runtime_comment_task_to_in_progress(
                &connection,
                &execution.loop_item_id,
                execution
                    .execution_payload
                    .as_ref()
                    .and_then(|payload| payload["automation_run_id"].as_str()),
            )?;
        }
        connection.commit()?;
        Ok(Some(execution))
    }

    pub fn reconcile_execution_snapshot(
        &self,
        execution_id: i64,
        runtime_status: &str,
        running: bool,
        turn_status: Option<&str>,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let current = {
            let connection = self.connection()?;
            execution_row(&connection, execution_id)?
        };
        if matches!(
            current.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            return Ok(Some(current));
        }
        let status = runtime_status.trim().to_ascii_lowercase();
        let turn = turn_status.unwrap_or("").trim().to_ascii_lowercase();
        if running || matches!(status.as_str(), "running" | "in_progress" | "inprogress") {
            let Some(runtime_task_id) = current.runtime_task_id.as_deref() else {
                return Ok(Some(current));
            };
            return self.mark_runtime_running(runtime_task_id);
        }
        match turn.as_str() {
            "completed" | "succeeded" => {
                return self.complete_execution(execution_id, Some("Runtime reconciled"));
            }
            "failed" | "error" => {
                return self.fail_execution(
                    execution_id,
                    "Runtime reported a failed turn during reconciliation",
                    true,
                );
            }
            "interrupted" | "cancelled" | "canceled" | "aborted" => {
                return self.cancel_execution_observed(
                    execution_id,
                    Some("Runtime reconciled cancellation"),
                );
            }
            _ => {}
        }
        match status.as_str() {
            "completed" | "succeeded" => {
                return self.complete_execution(execution_id, Some("Runtime reconciled"));
            }
            "failed" | "error" => {
                return self.fail_execution(
                    execution_id,
                    "Runtime reported a failed task during reconciliation",
                    true,
                );
            }
            "cancelled" | "canceled" => {
                return self.cancel_execution_observed(
                    execution_id,
                    Some("Runtime reconciled cancellation"),
                );
            }
            "missing" => {
                let error = if current.termination_reason == "runtime_dispatch_unknown"
                    && !current.error_message.trim().is_empty()
                {
                    current.error_message.as_str()
                } else {
                    "Runtime task disappeared before execution completed"
                };
                return self.fail_execution(execution_id, error, true);
            }
            _ => {}
        }

        let connection = self.connection()?;
        let timestamp = now();
        if matches!(
            status.as_str(),
            "accepted" | "active" | "pending" | "queued" | "starting"
        ) {
            connection.execute(
                "UPDATE loop_item_executions
                 SET observed_state = 'accepted', sync_state = 'in_sync',
                     observed_at = ?1, heartbeat_at = ?1, lease_expires_at = ?2,
                     error_message = '', termination_reason = '',
                     version = version + 1, updated_at = ?1
                 WHERE id = ?3
                   AND status IN ('claimed', 'running', 'cancel_requested')",
                params![timestamp, lease_expiry(&timestamp, 300), execution_id],
            )?;
        } else {
            connection.execute(
                "UPDATE loop_item_executions
                 SET sync_state = 'diverged', error_message = ?1,
                     version = version + 1, updated_at = ?2
                 WHERE id = ?3
                   AND status IN ('claimed', 'running', 'cancel_requested')",
                params![
                    format!(
                        "Runtime returned unrecognized status '{}'",
                        if status.is_empty() {
                            "missing"
                        } else {
                            &status
                        }
                    ),
                    timestamp,
                    execution_id,
                ],
            )?;
        }
        execution_row(&connection, execution_id).map(Some)
    }
}
