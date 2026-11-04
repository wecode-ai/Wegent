// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn log_suspicious_transcript_outcomes(
        &self,
        response: &Value,
        thread: &Value,
        link: Option<&RuntimeTaskLink>,
        direct_override: bool,
    ) {
        let Some(task_id) = response.get("taskId").and_then(Value::as_str) else {
            return;
        };
        let turns = response
            .get("turns")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let running = self.is_active_local_task(task_id);
        let active = self.active_codex_turn(task_id);
        if !running && active.is_none() && !link.is_some_and(|link| link.running) {
            return;
        }
        let outcomes = terminal_outcome_summary(thread, turns);
        if outcomes.is_empty() {
            return;
        }
        let native = link.and_then(crate::runtime_work::lifecycle::native_execution_state);
        let observed = self
            .active_codex_transcript_items
            .lock()
            .ok()
            .and_then(|items| items.get(task_id).map(|turn| turn.turn_id.clone()));
        let identity = json!({
            "running": running,
            "directThreadOverride": direct_override,
            "timeline": thread.get("timeline"),
            "threadId": response.get("threadId"),
            "nativePhase": native.as_ref().map(|state| &state.phase),
            "nativeTurnId": native.as_ref().and_then(|state| state.turn_id.as_deref()),
            "latestTurnId": native.as_ref().and_then(|state| state.latest_turn_id.as_deref()),
            "requestTurnId": native.as_ref().and_then(|state| state.request_turn_id.as_deref()),
            "nativeSequence": native.as_ref().map(|state| state.native_sequence),
            "processGeneration": native.as_ref().and_then(|state| state.process_generation),
            "activeTurnId": active.as_ref().map(|turn| &turn.turn_id),
            "observedTurnId": observed,
            "outcomes": outcomes,
        });
        log_executor_event(
            "runtime transcript terminal while active",
            &[
                ("task_id", task_id.to_owned()),
                ("identity", identity.to_string()),
            ],
        );
    }
}

fn terminal_outcome_summary(thread: &Value, turns: &[Value]) -> Vec<Value> {
    turns
        .iter()
        .filter(|turn| {
            matches!(
                turn.get("runtimeStatus")
                    .or_else(|| turn.get("status"))
                    .and_then(Value::as_str),
                Some("cancelled" | "failed")
            )
        })
        .take(10)
        .map(|turn| {
            let source = thread
                .get("turns")
                .and_then(Value::as_array)
                .and_then(|rows| rows.iter().find(|row| row["id"] == turn["id"]));
            json!({
                "turnId": turn.get("id"),
                "status": turn.get("status"),
                "runtimeStatus": turn.get("runtimeStatus"),
                "completedAt": turn.get("completedAt"),
                "sourceStatus": source.and_then(|row| row.get("status")),
                "timelineCompleted": source.and_then(|row| row.get("timelineCompleted")),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_summary_excludes_conversation_and_error_contents() {
        let turn = json!({"id":"turn-2", "status":"cancelled", "error":"secret-error", "items":[{"text":"secret-prompt"}]});
        let thread = json!({"turns":[turn.clone()]});
        let result = terminal_outcome_summary(&thread, &[turn]);
        assert_eq!(result[0]["turnId"], "turn-2");
        assert_eq!(result[0]["sourceStatus"], "cancelled");
        assert!(!serde_json::to_string(&result).unwrap().contains("secret-"));
    }
}
