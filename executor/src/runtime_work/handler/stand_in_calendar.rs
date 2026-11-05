//! Calendar entries supply timed intake facts, never execution configuration.
use super::*;
use crate::runtime_work::automations::{Automation, AutomationRun};

/// Keep later deadlines pending while the same arrangement owns an execution.
pub(super) fn serialize_calendar_intake(events: Vec<Value>, busy: HashSet<String>) -> Vec<Value> {
    let mut earliest = HashMap::new();
    for (index, event) in events.iter().enumerate() {
        let Some(id) = event["automationId"]
            .as_str()
            .filter(|id| !busy.contains(*id))
        else {
            continue;
        };
        let Some(deadline) = event["notBefore"]
            .as_str()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        else {
            continue;
        };
        if event["kind"] == "calendar" {
            let selected = earliest.entry(id.to_owned()).or_insert((deadline, index));
            if deadline < selected.0 {
                *selected = (deadline, index);
            }
        }
    }
    events
        .into_iter()
        .enumerate()
        .filter(|(index, event)| {
            event["kind"] != "calendar"
                || event["automationId"]
                    .as_str()
                    .and_then(|id| earliest.get(id))
                    .is_some_and(|(_, selected)| selected == index)
        })
        .map(|(_, event)| event)
        .collect()
}

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

#[cfg(test)]
mod serialization_tests {
    use super::*;

    #[test]
    fn deadlines_wait_for_the_previous_run_without_blocking_other_arrangements() {
        let events = vec![
            json!({"id":"a-first","kind":"calendar","automationId":"a","status":"pending","notBefore":"2026-11-04T10:00:00Z"}),
            json!({"id":"a-next","kind":"calendar","automationId":"a","status":"pending","notBefore":"2026-11-04T10:01:00Z"}),
            json!({"id":"b-first","kind":"calendar","automationId":"b","status":"pending","notBefore":"2026-11-04T10:00:00Z"}),
            json!({"id":"work","kind":"work_state","taskId":"original"}),
        ];
        let ids = |rows: Vec<Value>| {
            rows.into_iter()
                .map(|row| row["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(serialize_calendar_intake(events.clone(), HashSet::new())),
            vec!["a-first", "b-first", "work"]
        );
        assert_eq!(
            ids(serialize_calendar_intake(
                events.clone(),
                HashSet::from(["a".to_owned()])
            )),
            vec!["b-first", "work"]
        );
        assert_eq!(
            ids(serialize_calendar_intake(
                events[1..].to_vec(),
                HashSet::new()
            )),
            vec!["a-next", "b-first", "work"]
        );
        assert!(events[..3].iter().all(|event| event["status"] == "pending"));
        assert_eq!(
            ids(serialize_calendar_intake(
                events.into_iter().rev().collect(),
                HashSet::new()
            )),
            vec!["work", "b-first", "a-first"]
        );
    }
}
