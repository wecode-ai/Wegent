//! Persist async questions at the native notification publication boundary.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn persist_async_question_interaction(
        &self,
        task_id: &str,
        message: &CodexNotification,
    ) {
        let notification = codex_notification(message);
        if notification.method != "item/completed"
            || crate::runtime_work::codex_user_input::async_question_payload_from_item(
                notification.params,
            )
            .is_none()
        {
            return;
        }
        let thread = codex_notification_thread_id(message);
        let turn = codex_notification_turn_id(message);
        let mut changed = false;
        self.store.update_task(task_id, |link| {
            if !question_belongs_to_current_turn(
                link,
                thread.as_deref(),
                turn.as_deref(),
                message.process_generation(),
            ) || link.interaction_status.as_deref() == Some(INTERACTION_AWAITING_USER_REPLY)
            {
                return;
            }
            link.interaction_status = Some(INTERACTION_AWAITING_USER_REPLY.to_owned());
            link.updated_at = now_ms().max(link.updated_at);
            changed = true;
        });
        if changed {
            emit_runtime_work_changed(&self.event_tx, &self.device_id, task_id);
        }
    }
}

fn question_belongs_to_current_turn(
    link: &RuntimeTaskLink,
    thread: Option<&str>,
    turn: Option<&str>,
    process_generation: u64,
) -> bool {
    if matches!(link.status.as_str(), "failed" | "cancelled" | "archived")
        || link
            .interaction_status
            .as_deref()
            .is_some_and(|status| status != INTERACTION_AWAITING_USER_REPLY)
        || thread
            .zip(link.thread_id.as_deref())
            .is_some_and(|(question, root)| question != root)
    {
        return false;
    }
    // Native lifecycle identity remains authoritative after RPC observers finish.
    let native = crate::runtime_work::lifecycle::native_execution_state(link);
    if native
        .as_ref()
        .and_then(|state| state.process_generation)
        .is_some_and(|current| current != process_generation)
    {
        return false;
    }
    let current_turn = native
        .as_ref()
        .and_then(|state| state.turn_id.as_deref().or(state.latest_turn_id.as_deref()))
        .or_else(|| link.runtime_handle["lastTurnId"].as_str());
    !turn.is_some_and(|turn| current_turn.is_some_and(|current| turn != current))
}
