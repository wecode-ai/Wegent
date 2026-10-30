//! Persist async question state before either notification receiver publishes it.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn persist_async_question_interaction(&self, task_id: &str, message: &Value) {
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
        let active = self.active_codex_turn(task_id);
        let executing = self.is_active_local_task(task_id);
        let mut changed = false;
        self.store.update_task(task_id, |link| {
            if !question_belongs_to_current_turn(
                link,
                thread.as_deref(),
                turn.as_deref(),
                active.as_ref(),
                executing,
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
    active: Option<&ActiveCodexTurn>,
    executing: bool,
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
    let current_turn = active
        .map(|active| active.turn_id.as_str())
        .or_else(|| link.runtime_handle["lastTurnId"].as_str());
    !turn.is_some_and(|turn| {
        (executing && active.is_none()) || current_turn.is_some_and(|current| turn != current)
    })
}
