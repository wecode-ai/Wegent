//! Calendar entries supply timed intake facts, never execution configuration.
use super::*;
use crate::runtime_work::automations::{Automation, AutomationRun};

impl RuntimeWorkRpcHandler {
    pub(super) fn queue_calendar_run(
        &self,
        store: &LocalTaskStore,
        automation: &Automation,
        run: &AutomationRun,
    ) -> Result<(), AppIpcError> {
        if run.status != AutomationRunStatus::Pending {
            return Ok(());
        }
        let current = match self.current_arrangement(run) {
            Ok(current) => current,
            Err(error) => {
                self.automation_store
                    .mark_needs_attention(&run.id, error.message)
                    .map_err(|error| AppIpcError::new("calendar_store_error", error))?;
                return Ok(());
            }
        };
        let owner = &current.task_request["standInOwner"];
        let user = owner["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("permission_denied", "Missing calendar owner"))?;
        store.enqueue_stand_in_event(user, json!(["calendar",run.id]), json!({
            "kind":"calendar", "roleScoped":true, "roleIds":[owner["roleId"]],
            "runId":run.id, "automationId":automation.id, "automationVersion":current.version,
            "notBefore":run.scheduled_for, "title":current.name,
            "message":{"id":run.id,"text":current.prompt,"at":run.scheduled_for},
            "source":{"providerId":"calendar","id":automation.id,"name":current.name}
        })).map_err(super::stand_in::settings_error)?;
        Ok(())
    }

    pub(super) fn calendar_intake_run(
        &self,
        role: &Value,
        event: &Value,
    ) -> Result<(Automation, AutomationRun), AppIpcError> {
        let invalid = || {
            AppIpcError::new(
                "source_removed",
                "The calendar entry changed or is no longer pending",
            )
        };
        let run = self
            .automation_store
            .list_runs(None)
            .into_iter()
            .find(|run| run.id == event["runId"] && run.status == AutomationRunStatus::Pending)
            .ok_or_else(invalid)?;
        let automation = self.current_arrangement(&run).map_err(|_| invalid())?;
        if !automation.task_request["standInCalendar"].is_object()
            || role["calendar"]["policy"]["automatic"] == false
            || automation.id != event["automationId"]
            || json!(automation.version) != event["automationVersion"]
            || automation.task_request["standInOwner"]["userId"] != role["userId"]
            || automation.task_request["standInOwner"]["roleId"] != role["id"]
        {
            return Err(invalid());
        }
        Ok((automation, run))
    }
}
