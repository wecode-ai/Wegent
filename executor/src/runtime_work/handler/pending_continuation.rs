use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn bind_pending_continuation(
        &self,
        turn: &mut SpawnTurnRequest,
    ) -> Result<(), String> {
        if is_claude_runtime(&turn.runtime)
            || turn
                .send_payload
                .as_ref()
                .map_or(true, |payload| payload["startNewSession"] == true)
            || turn.resume_thread_id.is_some()
            || turn.direct_thread_id.is_some()
            || turn.fork_thread_id.is_some()
            || turn
                .request
                .extra
                .contains_key(project_preparation::DEFERRED_ENVIRONMENT)
        {
            return Ok(());
        }
        // Creation is accepted before its native session exists. Resolve that
        // same session only after the scheduler releases the initial execution.
        let link = self
            .local_task_link(&turn.local_task_id)
            .ok_or_else(|| "The original conversation no longer exists".to_owned())?;
        let thread_id = runtime_session_id_from_link(&link)
            .ok_or_else(|| "The original conversation has no native session".to_owned())?;
        if runtime_task_uses_ephemeral_codex_thread(&link) {
            turn.direct_thread_id = Some(thread_id);
        } else {
            turn.resume_thread_id = Some(thread_id);
        }
        Ok(())
    }
}
