//! Shared task lifecycle decisions for automatic and explicit Stand-in dispatch.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn dispatch_stand_in_task(
        &self,
        payload: Value,
        retry: bool,
    ) -> Result<Value, AppIpcError> {
        // These large futures must not inflate every enclosing stand-in state
        // machine and exhaust Windows worker stacks during nested polling.
        let result = if retry {
            let task_id = runtime_task_id(&payload)
                .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
            if self
                .local_task_link(&task_id)
                .is_some_and(|task| task.status == "archived")
            {
                let restored = Box::pin(self.unarchive_task(json!({"taskId":task_id}))).await?;
                if restored["success"] == false {
                    return Err(AppIpcError::new(
                        "stand_in_start_failed",
                        restored["error"]
                            .as_str()
                            .unwrap_or("Cannot restore Stand-in task"),
                    ));
                }
            }
            Box::pin(self.send_message(payload)).await
        } else {
            Box::pin(self.create_task(payload)).await
        };
        result.and_then(|result| {
            if result["success"] == false || result["accepted"] == false {
                Err(AppIpcError::new(
                    "stand_in_start_failed",
                    result["error"]
                        .as_str()
                        .unwrap_or("Stand-in execution was not accepted"),
                ))
            } else {
                Ok(result)
            }
        })
    }

    pub(super) fn stand_in_task_is_handled(
        &self,
        config: &Value,
        task_id: &str,
        already_bound: bool,
    ) -> bool {
        let task = self.local_task_link(task_id);
        if self.store.is_deleted_archived_task_id(task_id)
            || task
                .as_ref()
                .is_some_and(|task| self.archived_link_is_deleted(task))
        {
            return true;
        }
        let retry = config["manual"] == true
            && task
                .as_ref()
                .is_some_and(|task| matches!(task.status.as_str(), "failed" | "archived"));
        (already_bound || task.is_some()) && !retry
    }

    pub(super) async fn execute_stand_in_task(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
        already_bound: bool,
    ) -> Result<(), AppIpcError> {
        let task_id = self.stand_in_task_id(config, binding);
        if self.stand_in_task_is_handled(config, &task_id, already_bound) {
            self.log_stand_in_decision(
                config,
                issue,
                "task_already_exists",
                json!({"taskId":task_id}),
            );
            return Ok(());
        }
        let result = async {
            let payload = self.prepare_stand_in_task(config, issue, binding).await?;
            if already_bound {
                self.dispatch_stand_in_task(payload, true).await.map(|_| ())
            } else {
                self.create_stand_in_task(config, issue, binding, payload)
                    .await
            }
        }
        .await;
        let reason = if result.is_ok() {
            "dispatch_completed"
        } else {
            "dispatch_failed"
        };
        self.log_stand_in_decision(
            config,
            issue,
            reason,
            json!({"taskId":task_id,"errorCode":result.as_ref().err().map(|error| &error.code)}),
        );
        self.record_stand_in_dispatch(config, &result);
        result
    }
}

#[cfg(test)]
#[path = "stand_in_execution_tests.rs"]
mod tests;
