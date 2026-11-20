//! Cancel waits only against the current native Goal, never a delayed projection.
use super::*;

fn waiting(record: &Value, task: &str) -> bool {
    record["task_id"] == task
        && !record["waiting_goal"].is_null()
        && matches!(
            record["status"].as_str(),
            Some("preparing" | "armed" | "pending" | "resuming_goal")
        )
}

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) fn resume_goal_after_owner_input(
        &self,
        task: &str,
        thread: &str,
    ) {
        if self
            .store
            .read_task(task, |link| link.goal_status.as_deref() == Some("blocked"))
            != Some(true)
        {
            return;
        }
        let handler = self.clone();
        let task = task.to_owned();
        let thread = thread.to_owned();
        tokio::spawn(async move {
            if let Err(error) = handler.resume_blocked_goal_for_owner(&task, &thread).await {
                log_executor_event(
                    "manual event Goal resume failed",
                    &[("task_id", task), ("code", error.code)],
                );
            }
        });
    }

    async fn resume_blocked_goal_for_owner(
        &self,
        task: &str,
        thread: &str,
    ) -> Result<(), AppIpcError> {
        let records = self.connection_goal_records(task)?;
        if records.is_empty() {
            return Ok(());
        }
        let goal = self.read_event_goal(task).await?;
        if goal["status"] != "blocked" || goal["threadId"] != thread {
            return Ok(());
        }
        let identity = goal_identity(&goal);
        if !records.values().any(|record| {
            record["session"]["engine"] == "Codex"
                && record["session"]["id"] == thread
                && record["waiting_goal"] == identity
        }) {
            return Ok(());
        }
        let result = self
            .set_task_goal(json!({
                "taskId": task, "status": "active", "eventGoalExpected": goal,
            }))
            .await?;
        if result["accepted"] != true {
            return Err(invalid("Cannot resume the Goal after owner input"));
        }
        Ok(())
    }

    fn connection_goal_records(
        &self,
        task: &str,
    ) -> Result<serde_json::Map<String, Value>, AppIpcError> {
        event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Waiting(task),
            |state| {
                Ok(state["operations"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .filter(|(_, record)| waiting(record, task))
                    .map(|(id, record)| (id.clone(), record.clone()))
                    .collect())
            },
        )
    }

    pub(in crate::runtime_work::handler) fn schedule_connection_goal_reconciliation(
        &self,
        task: &str,
    ) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        {
            let mut pending = self
                .connection_goal_reconciliations
                .lock()
                .expect("Goal reconciliation registry poisoned");
            if let Some(revision) = pending.get_mut(task) {
                *revision = revision.saturating_add(1);
                return;
            }
            pending.insert(task.into(), 1);
        }
        let handler = self.clone();
        let task = task.to_owned();
        runtime.spawn(async move {
            loop {
                let revision = handler.connection_goal_reconciliations.lock().unwrap()[&task];
                if let Err(error) = handler.reconcile_connection_goal_waits(&task).await {
                    log_executor_event(
                        "Goal event-wait reconciliation deferred",
                        &[("code", error.code)],
                    );
                }
                let mut pending = handler.connection_goal_reconciliations.lock().unwrap();
                if pending.get(&task) == Some(&revision) {
                    pending.remove(&task);
                    break;
                }
            }
        });
    }

    pub(super) async fn reconcile_connection_goal_waits(
        &self,
        task: &str,
    ) -> Result<(), AppIpcError> {
        let gate = self.task_send_gate(&format!("goal-status:{task}"));
        let _guard = gate.lock().await;
        if self.connection_goal_records(task)?.is_empty() {
            return Ok(());
        }
        let current = self.read_event_goal(task).await?;
        let link = self
            .store
            .get_task(task)
            .ok_or_else(|| invalid("Conversation no longer exists"))?;
        // Read records again after the RPC: admission can advance a waiting phase.
        for (id, mut record) in self.connection_goal_records(task)? {
            let same_goal = goal_identity(&current) == record["waiting_goal"];
            let allowed = same_goal
                && (current["status"] == "blocked"
                    || (current["status"] == "active"
                        && matches!(
                            record["status"].as_str(),
                            Some("preparing" | "pending" | "resuming_goal")
                        )));
            let same_session = match session::validate(&record, &link) {
                Ok(()) => true,
                Err(error) if error.code == "native_session_changed" => false,
                Err(error) => return Err(error),
            };
            if !allowed || !same_session {
                record["status"] = json!(closed_goal_wait_status(
                    &record,
                    same_goal && same_session && current["status"] == "complete",
                ));
                self.save_event_subscription(&id, &record)?;
            }
        }
        Ok(())
    }

    pub(in crate::runtime_work::handler) fn cancel_connection_waits_for_goal_identity(
        &self,
        task: &str,
        goal: &Value,
    ) -> Result<(), AppIpcError> {
        for (id, mut record) in self.connection_goal_records(task)? {
            if record["waiting_goal"] != goal_identity(goal) {
                record["status"] = json!("cancelled");
                self.save_event_subscription(&id, &record)?;
            }
        }
        Ok(())
    }
}
