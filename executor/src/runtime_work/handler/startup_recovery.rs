//! Retry an interrupted native startup within its original logical conversation.
use super::*;

#[cfg(test)]
#[path = "startup_recovery_tests.rs"]
mod tests;

impl RuntimeWorkRpcHandler {
    fn has_recoverable_session_start(&self, link: &RuntimeTaskLink) -> bool {
        if runtime_session_id_from_link(link).is_some() {
            return false;
        }
        if link.status == "failed" {
            return true;
        }
        if !matches!(link.status.as_str(), "active" | "queued" | "cancelled") {
            return false;
        }
        let origin = &link.runtime_handle["origin"];
        crate::runtime_work::worktrees::RequestWorktreeOwner::from_origin(
            Some(origin),
            &link.local_task_id,
            &self.device_id,
        )
        .is_ok_and(|owner| {
            owner.is_some_and(|owner| {
                origin["type"] == "issue_dispatch"
                    && origin["initiatedBy"] == "stand_in"
                    && origin["assistantRequestId"] == owner.request_id
                    && origin["userId"] == owner.owner_user_id
                    && origin["deviceId"] == self.device_id
                    && origin["runtimeTaskId"] == link.local_task_id
                    && link.local_task_id == format!("assistant-request-{}", owner.request_id)
            })
        })
    }

    pub(super) async fn recover_session_start(
        &self,
        link: Option<&RuntimeTaskLink>,
        payload: Value,
        request: ExecutionRequest,
        activity: bool,
    ) -> Result<Option<Value>, AppIpcError> {
        let Some(link) = link.filter(|link| {
            crate::runtime_work::conversation_sessions::is_identity_conversation(link)
                && self.has_recoverable_session_start(link)
                && !self.is_busy_local_task(&link.local_task_id)
                && link.interaction_status.is_none()
        }) else {
            return Ok(None);
        };
        let user = super::super::runtime_owner::runtime_user(&link.runtime_handle["origin"])?;
        // A missing thread is not proof that a previous command never ran.
        // Unconfirmed commands keep their native recovery/owner review boundary.
        if let Some(thread) = self.recover_settled_command_session(&link.local_task_id, user)? {
            self.store.update_task(&link.local_task_id, |link| {
                link.thread_id = Some(thread.clone());
            });
            return Box::pin(self.send_message_with_activity_checks(payload, activity, false))
                .await
                .map(Some);
        }
        // Preserve the prepared identity and original command input across recreation.
        Box::pin(self.create_task_after_local_checks(payload, activity, Some(request)))
            .await
            .map(Some)
    }

    pub(super) fn preserve_session_start_context(&self, link: &mut RuntimeTaskLink) {
        let Some(previous) = self
            .local_task_link(&link.local_task_id)
            .filter(|previous| self.has_recoverable_session_start(previous))
        else {
            return;
        };
        link.created_at = previous.created_at;
        for key in ["startupFailure", "standInIssueWakeups"] {
            if let Some(value) = previous.runtime_handle.get(key) {
                link.runtime_handle[key] = value.clone();
            }
        }
        let current = link.runtime_handle["userMessagePresentations"].clone();
        if let Some(previous) = previous.runtime_handle.get("userMessagePresentations") {
            link.runtime_handle["userMessagePresentations"] = previous.clone();
        }
        for presentation in current.as_array().into_iter().flatten() {
            append_runtime_handle_user_message_presentation(
                &mut link.runtime_handle,
                presentation.clone(),
            );
        }
    }
}
