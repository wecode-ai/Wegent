//! Retry a failed native startup within its original logical conversation.
use super::*;

#[cfg(test)]
#[path = "startup_recovery_tests.rs"]
mod tests;

impl RuntimeWorkRpcHandler {
    pub(super) async fn recover_failed_session_start(
        &self,
        link: Option<&RuntimeTaskLink>,
        payload: Value,
        activity: bool,
        owner_message: Option<OwnerMessage>,
    ) -> Result<Option<Value>, AppIpcError> {
        let Some(link) = link.filter(|link| {
            crate::runtime_work::conversation_sessions::is_identity_conversation(link)
                && link.status == "failed"
                && runtime_session_id_from_link(link).is_none()
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
            return Box::pin(self.send_message_with_activity_checks(
                payload,
                activity,
                owner_message,
                false,
                None,
                None,
            ))
            .await
            .map(Some);
        }
        Box::pin(self.create_task_after_local_checks(payload, activity, None, None))
            .await
            .map(Some)
    }

    pub(super) fn preserve_failed_start_context(&self, link: &mut RuntimeTaskLink) {
        let Some(previous) = self
            .local_task_link(&link.local_task_id)
            .filter(|previous| {
                previous.status == "failed" && runtime_session_id_from_link(previous).is_none()
            })
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
