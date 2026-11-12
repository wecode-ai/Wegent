//! Personal review setup belongs to the current account on this Executor.
use super::*;
use crate::runtime_work::automations::{weekly_review, Automation, AutomationRun};
#[cfg(test)]
use crate::task_runtime::mcp::StandInMcpIdentity;

fn review_binding_denied(
    reason: &str,
    actor: &RuntimeTaskLink,
    user: i64,
    automation: Option<&Automation>,
    run: Option<&AutomationRun>,
) -> AppIpcError {
    let schedule = &actor.runtime_handle["executionRequest"]["standInSchedule"];
    let binding = run.and_then(|run| run.coordination.as_ref());
    log_executor_event(
        "stand-in review authorization denied",
        &[
            ("reason", reason.to_owned()),
            ("task_id", actor.local_task_id.clone()),
            ("user_id", user.to_string()),
            (
                "automation_id",
                schedule["id"].as_str().unwrap_or_default().to_owned(),
            ),
            (
                "schedule_version",
                schedule["version"]
                    .as_u64()
                    .map(|version| version.to_string())
                    .unwrap_or_default(),
            ),
            (
                "automation_version",
                automation
                    .map(|item| item.version.to_string())
                    .unwrap_or_default(),
            ),
            (
                "automation_enabled",
                automation
                    .map(|item| item.enabled.to_string())
                    .unwrap_or_default(),
            ),
            (
                "run_id",
                schedule["runId"].as_str().unwrap_or_default().to_owned(),
            ),
            (
                "run_automation_id",
                run.map(|item| item.automation_id.clone())
                    .unwrap_or_default(),
            ),
            (
                "run_status",
                run.map(|item| format!("{:?}", item.status))
                    .unwrap_or_default(),
            ),
            (
                "coordination_version",
                binding
                    .map(|item| item.automation_version.to_string())
                    .unwrap_or_default(),
            ),
            (
                "coordination_task_id",
                binding.map(|item| item.task_id.clone()).unwrap_or_default(),
            ),
        ],
    );
    AppIpcError::new(
        "permission_denied",
        format!("The review run binding is no longer valid: {reason}"),
    )
}

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
        let schedule = &actor.runtime_handle["executionRequest"]["standInSchedule"];
        let automation = schedule["id"]
            .as_str()
            .and_then(|id| self.automation_store.get(id))
            .ok_or_else(|| review_binding_denied("automation_missing", actor, user, None, None))?;
        let denied =
            |reason, run| review_binding_denied(reason, actor, user, Some(&automation), run);
        if actor.runtime_handle["origin"]["type"] != "stand_in_schedule"
            || actor.runtime_handle["origin"][flag] != true
            || actor.runtime_handle["origin"]["automationId"] != automation.id
            || automation.task_request["standInOwner"]["userId"] != user
            || automation.task_request["standInOwner"]["roleId"] != "@primary"
            || automation.task_request["standInCalendar"]["template"] != template
        {
            return Err(denied("identity_mismatch", None));
        }
        if json!(automation.version) != schedule["version"] {
            return Err(denied("automation_version_changed", None));
        }
        let run = self
            .automation_store
            .list_runs(Some(&automation.id))
            .into_iter()
            .find(|run| json!(run.id) == schedule["runId"])
            .ok_or_else(|| denied("run_missing", None))?;
        if !matches!(
            run.status,
            AutomationRunStatus::Pending | AutomationRunStatus::Running
        ) {
            return Err(denied("run_not_active", Some(&run)));
        }
        if !run.coordination.as_ref().is_some_and(|binding| {
            binding.user_id == user
                && binding.role_id == "@primary"
                && binding.automation_version == automation.version
                && binding.task_id == actor.local_task_id
        }) {
            return Err(denied("coordination_mismatch", Some(&run)));
        }
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
        let timezone = match payload.get("timezone") {
            None => "UTC",
            Some(value) => value.as_str().ok_or_else(|| {
                AppIpcError::new("bad_request", "timezone must be an IANA timezone")
            })?,
        };
        let template = weekly_review(
            user,
            &self.device_id,
            if method == "runtime.stand_in.onboarding.complete" && payload["weeklyReview"] == true {
                payload["time"].as_str().unwrap_or("09:00")
            } else {
                "09:00"
            },
            timezone,
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
