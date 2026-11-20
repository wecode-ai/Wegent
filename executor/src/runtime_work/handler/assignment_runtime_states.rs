//! Observe existing recipient-owned tasks; receipt sync never starts execution.
use super::stand_in::settings_error;
use super::*;

fn runtime_state(
    status: &str,
    running: bool,
    interaction: bool,
    handle: &Value,
) -> (&'static str, &'static str, Option<String>) {
    if interaction {
        return ("waiting_user", "user_input_required", None);
    }
    if running {
        return ("running", "runtime_running", None);
    }
    match status {
        "failed" => ("failed", "runtime_failed", None),
        "cancelled" => ("cancelled", "runtime_cancelled", None),
        "done" => {
            let origin = &handle["origin"];
            let public_turn = &handle["standInPublicTurn"];
            let result = handle["standInIssueReplies"]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, report)| {
                    report["sent"] == true
                        && origin["humanAssignmentId"].is_string()
                        && report["origin"]["humanAssignmentId"] == origin["humanAssignmentId"]
                        && public_turn["turn"].is_string()
                        && public_turn["thread"].is_string()
                        && public_turn["generation"].is_number()
                        && public_turn["turn"] == handle["lastTurnId"]
                        && report["publicTurn"] == *public_turn
                })
                .filter_map(|(_, report)| report["messageId"].as_str())
                .next_back();
            match result {
                Some(id) => ("completed", "public_result_published", Some(id.to_owned())),
                None => ("waiting_user", "awaiting_publication", None),
            }
        }
        _ => ("queued", "awaiting_runtime", None),
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn record_assignment_start_failure(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<(), AppIpcError> {
        if config["projectStore"] != "cloud"
            || config["manual"] == true
            || binding["dispatchRoundId"] != "direct"
            || issue["assignee_user_id"] != config["userId"]
        {
            return Ok(());
        }
        let Some(connection) = self.backend_connection_snapshot()? else {
            return Ok(());
        };
        LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?
            .queue_assignment_receipt(&json!({
                "projectId":config["projectId"],"issueId":issue["id"],"assignmentId":binding["assignmentId"],
                "userId":config["userId"],"deviceId":self.cloud_device_id()?,"backendUrl":connection.backend_url,
                "taskId":null,"dispatch":{"state":"failed","reasonCode":"execution_rejected","observedAt":chrono::Utc::now()},
            })).map_err(settings_error)
    }

    pub(super) fn queue_assignment_runtime_states(&self) -> Result<(), AppIpcError> {
        let Some(connection) = self.backend_connection_snapshot()? else {
            return Ok(());
        };
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for task in self.local_task_links(true) {
            let origin = &task.runtime_handle["origin"];
            if origin["type"] != "issue_dispatch"
                || origin["initiatedBy"] != "stand_in"
                || origin["projectStore"] != "cloud"
                || origin["trigger"] != "assignment"
                || origin["roundId"] != "direct"
                || origin["backendUrl"].as_str() != Some(connection.backend_url.as_str())
                || !origin["assignmentId"].is_string()
                || self.archived_link_is_deleted(&task)
            {
                continue;
            }
            let (state, reason, result) = runtime_state(
                &task.status,
                task.running,
                task.interaction_status.is_some(),
                &task.runtime_handle,
            );
            let signature = json!([origin["humanAssignmentId"], state, result]);
            if task.runtime_handle["assignmentReceiptState"] == signature {
                continue;
            }
            store.queue_assignment_receipt(&json!({
                "projectId":origin["cloudProjectId"], "issueId":origin["loopItemId"],
                "assignmentId":origin["assignmentId"], "userId":origin["userId"],
                "backendUrl":origin["backendUrl"],"deviceId":self.cloud_device_id()?,
                "taskId":task.local_task_id,
                "dispatch":{"state":state,"reasonCode":reason,"publicMessageId":result,"observedAt":chrono::Utc::now()},
            })).map_err(settings_error)?;
            self.store
                .try_update_task(&task.local_task_id, |link| {
                    link.runtime_handle["assignmentReceiptState"] = signature;
                })
                .map_err(|error| AppIpcError::new("receipt_persistence", error.to_string()))?;
        }
        Ok(())
    }

    pub(super) async fn record_assignment_policy_block(
        &self,
        context: &Value,
        issue: &str,
        assignment: &str,
        reason: &str,
    ) -> Result<(), AppIpcError> {
        let connection = self.backend_connection_snapshot()?.ok_or_else(|| {
            AppIpcError::new("cloud_unavailable", "Cloud connection is unavailable")
        })?;
        let owner = Self::connected_runtime_user(&connection).await?;
        if context["userId"].as_i64() != Some(owner) {
            self.log_stand_in_decision(
                context,
                &json!({"id":issue,"human_task_binding":{"assignmentId":assignment}}),
                "notification_account_mismatch",
                json!({}),
            );
            return Ok(());
        }
        LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?
            .queue_assignment_receipt(&json!({
                "projectId":context["projectId"],"issueId":issue,"assignmentId":assignment,
                "userId":context["userId"],"backendUrl":connection.backend_url,
                "deviceId":self.cloud_device_id()?,"taskId":null,
                "dispatch":{"state":"blocked_policy","reasonCode":reason,"observedAt":chrono::Utc::now()},
            })).map_err(settings_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_completion_requires_publication_for_the_same_assignment() {
        let mut handle = json!({
            "origin":{"humanAssignmentId":"new"},
            "lastTurnId":"current",
            "standInPublicTurn":{"thread":"thread","turn":"current","generation":2},
            "standInIssueReplies":{"old":{"sent":true,"messageId":"old-result","origin":{"humanAssignmentId":"old"}}}
        });
        assert_eq!(
            runtime_state("done", false, false, &handle).0,
            "waiting_user"
        );
        handle["standInIssueReplies"]["new"] = json!({"sent":true,"messageId":"new-result","origin":{"humanAssignmentId":"new"},"publicTurn":{"thread":"thread","turn":"previous","generation":2}});
        assert_eq!(
            runtime_state("done", false, false, &handle).0,
            "waiting_user"
        );
        handle["standInIssueReplies"]["new"]["publicTurn"] =
            json!({"thread":"thread","turn":"current","generation":1});
        assert_eq!(
            runtime_state("done", false, false, &handle).0,
            "waiting_user"
        );
        handle["standInIssueReplies"]["new"]["publicTurn"] = handle["standInPublicTurn"].clone();
        assert_eq!(
            runtime_state("done", false, false, &handle),
            (
                "completed",
                "public_result_published",
                Some("new-result".into())
            )
        );
        assert_eq!(runtime_state("done", true, false, &handle).0, "running");
        assert_eq!(runtime_state("done", true, true, &handle).0, "waiting_user");
        handle["lastTurnId"] = json!("next");
        assert_eq!(
            runtime_state("done", false, false, &handle).0,
            "waiting_user"
        );
    }
}
