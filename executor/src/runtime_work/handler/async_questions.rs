//! Persist async question state before either notification receiver publishes it.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn persist_async_question_interaction(
        &self,
        task_id: &str,
        message: &Value,
        delivering_turn: Option<&ActiveCodexTurn>,
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
        // Native completion clears shared active state before the mapper queue drains.
        // Only a mapper still owned by the current execution may supply that context.
        let shared_active = self.active_codex_turn(task_id);
        let using_mapper_context = shared_active.is_none();
        let active = shared_active.or_else(|| {
            delivering_turn
                .filter(|turn| self.is_current_local_task_execution(task_id, turn.execution_id))
                .cloned()
        });
        let executing = self.is_active_local_task(task_id);
        let mut changed = false;
        self.store.update_task(task_id, |link| {
            if !question_belongs_to_current_turn(
                link,
                thread.as_deref(),
                turn.as_deref(),
                active.as_ref(),
                executing,
                using_mapper_context,
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
    using_mapper_context: bool,
) -> bool {
    if using_mapper_context
        && active.is_some_and(|active| {
            link.thread_id.as_deref() != Some(active.thread_id.as_str())
                || link.runtime_handle["lastTurnId"]
                    .as_str()
                    .is_some_and(|recorded| recorded != active.turn_id)
        })
    {
        return false;
    }
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
