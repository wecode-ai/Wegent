//! Personal review setup belongs to the current account on this Executor.
use super::*;
use crate::runtime_work::automations::weekly_review;
#[cfg(test)]
use crate::task_runtime::mcp::StandInMcpIdentity;

impl RuntimeWorkRpcHandler {
    pub(super) fn review_run_end(
        &self,
        actor: &RuntimeTaskLink,
        user: i64,
    ) -> Result<chrono::DateTime<chrono::Utc>, AppIpcError> {
        self.scheduled_review_run_end(actor, user, false)
    }

    pub(super) fn scheduled_review_run_end(
        &self,
        actor: &RuntimeTaskLink,
        user: i64,
        memory: bool,
    ) -> Result<chrono::DateTime<chrono::Utc>, AppIpcError> {
        use crate::runtime_work::automations::{MEMORY_REVIEW_TEMPLATE, WEEKLY_REVIEW_TEMPLATE};
        let (template, flag) = if memory {
            (MEMORY_REVIEW_TEMPLATE, "memoryReview")
        } else {
            (WEEKLY_REVIEW_TEMPLATE, "weeklyReview")
        };
        let denied = || {
            AppIpcError::new(
                "permission_denied",
                "The review run binding is no longer valid",
            )
        };
        let schedule = &actor.runtime_handle["executionRequest"]["standInSchedule"];
        let automation = schedule["id"]
            .as_str()
            .and_then(|id| self.automation_store.get(id))
            .ok_or_else(denied)?;
        if actor.runtime_handle["origin"]["type"] != "stand_in_schedule"
            || actor.runtime_handle["origin"][flag] != true
            || actor.runtime_handle["origin"]["automationId"] != automation.id
            || automation.task_request["standInOwner"]["userId"] != user
            || automation.task_request["standInOwner"]["roleId"] != "@primary"
            || automation.task_request["standInCalendar"]["template"] != template
            || json!(automation.version) != schedule["version"]
        {
            return Err(denied());
        }
        let run = self
            .automation_store
            .list_runs(Some(&automation.id))
            .into_iter()
            .find(|run| {
                json!(run.id) == schedule["runId"]
                    && matches!(
                        run.status,
                        AutomationRunStatus::Pending | AutomationRunStatus::Running
                    )
                    && run.coordination.as_ref().is_some_and(|binding| {
                        binding.user_id == user
                            && binding.role_id == "@primary"
                            && binding.automation_version == automation.version
                            && binding.task_id == actor.local_task_id
                    })
            })
            .ok_or_else(denied)?;
        Ok(run.scheduled_for)
    }

    pub(super) async fn stand_in_onboarding_rpc(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let template = weekly_review(
            user,
            &self.device_id,
            if method == "runtime.stand_in.onboarding.complete" && payload["weeklyReview"] == true {
                payload["time"].as_str().unwrap_or("09:00")
            } else {
                "09:00"
            },
            payload["language"].as_str().unwrap_or("zh-CN"),
        )
        .map_err(|error| AppIpcError::new("bad_request", error))?;
        let state = if method == "runtime.stand_in.onboarding.complete" {
            let selected = payload["weeklyReview"]
                .as_bool()
                .ok_or_else(|| AppIpcError::new("bad_request", "weeklyReview is required"))?;
            let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
            let _guard = gate.lock().await;
            let mut initialized = None;
            if selected
                && self
                    .automation_store
                    .stand_in_onboarding(user)
                    .map_err(|error| AppIpcError::new("automation_store_error", error))?
                    ["completed"]
                    != true
            {
                let store = LocalTaskStore::open(self.task_store_path.as_ref())
                    .map_err(super::stand_in::settings_error)?;
                if let Some(previous) = store
                    .materialize_implicit_primary(user, &self.device_id)
                    .map_err(super::stand_in::settings_error)?
                {
                    initialized = Some((store, previous));
                }
            }
            let result = match self
                .automation_store
                .complete_stand_in_onboarding(user, selected.then(|| template.clone()))
            {
                Ok(result) => result,
                Err(error) => {
                    if let Some((store, previous)) = initialized {
                        store
                            .restore_implicit_primary(user, &self.device_id, &previous)
                            .map_err(|rollback| {
                                AppIpcError::new(
                                    "automation_store_error",
                                    format!(
                                        "{error}; restoring primary settings failed: {rollback}"
                                    ),
                                )
                            })?;
                    }
                    return Err(AppIpcError::new("automation_store_error", error));
                }
            };
            self.emit_automations_changed(&template.id, "updated");
            result
        } else {
            self.automation_store
                .stand_in_onboarding(user)
                .map_err(|error| AppIpcError::new("automation_store_error", error))?
        };
        let settings = if method == "runtime.stand_in.onboarding.complete" {
            Some(
                LocalTaskStore::open(self.task_store_path.as_ref())
                    .map_err(super::stand_in::settings_error)?
                    .personal_stand_in(user, &self.device_id)
                    .map_err(super::stand_in::settings_error)?,
            )
        } else {
            None
        };
        Ok(json!({"state":state,"reviewTemplate":template,"settings":settings}))
    }
}

#[cfg(test)]
#[path = "stand_in_review_tests.rs"]
mod tests;
