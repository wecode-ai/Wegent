// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn inspect_live_conversation(&self, payload: &Value) -> Result<Value, AppIpcError> {
        let task_id = payload["taskId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or_else(|| AppIpcError::new("bad_request", "A local taskId is required"))?;
        let (thread_id, runtime, link_state) = self
            .store
            .try_read_loaded_task(task_id, |link| {
                let native = crate::runtime_work::lifecycle::native_execution_state(link);
                (
                    link.thread_id.clone(),
                    link.runtime.clone(),
                    json!({
                        "running": link.running,
                        "status": link.status,
                        "threadStatus": link.thread_status,
                        "turnStatus": link.turn_status,
                        "goalStatus": link.goal_status,
                        "interactionStatus": link.interaction_status,
                        "nativeExecution": native.as_ref().map(|state| json!({
                            "phase": state.phase,
                            "turnId": state.turn_id,
                            "latestTurnId": state.latest_turn_id,
                            "outcome": state.outcome,
                            "processGeneration": state.process_generation,
                            "nativeSequence": state.native_sequence,
                            "updatedAt": state.updated_at,
                        })),
                    }),
                )
            })
            .map_err(|_| AppIpcError::new("diagnostics_busy", "The live task index is busy"))?
            .ok_or_else(|| {
                AppIpcError::new("task_not_found", "Local conversation was not found")
            })?;
        let execution = self
            .active_local_executions
            .try_lock()
            .ok()
            .map(|executions| {
                executions.get(task_id).map(|execution| {
                    json!({
                        "id": execution.execution_id,
                        "stopRequested": execution.stop_requested,
                        "stopAcknowledged": execution.stop_acknowledged,
                        "turnId": execution.codex_turn.as_ref().map(|turn| &turn.turn_id),
                    })
                })
            });
        let queue = self
            .turn_scheduler
            .try_lock()
            .ok()
            .map(|scheduler| json!({"position": scheduler.queued_position(task_id)}));
        let observed = self
            .active_codex_transcript_items
            .try_lock()
            .ok()
            .map(|items| {
                items.get(task_id).map(|active| {
                    let pending = active
                        .items
                        .iter()
                        .rev()
                        .filter_map(|item| {
                            let data = &item["renderPayload"];
                            (data["interactionStatus"] == "pending").then(|| {
                                json!({
                                    "itemId": item["id"],
                                    "kind": data["kind"],
                                    "requestId": data["requestId"],
                                    "expiresAtUnixMs": data["expiresAtUnixMs"],
                                })
                            })
                        })
                        .take(10)
                        .collect::<Vec<_>>();
                    json!({"turnId": active.turn_id, "pendingInteractions": pending})
                })
            });
        let codex = (runtime == "codex")
            .then(|| {
                thread_id
                    .as_deref()
                    .map(|id| self.codex_app_server.live_thread_diagnostics(id))
            })
            .flatten();
        Ok(json!({
            "deviceId": self.device_id,
            "taskId": task_id,
            "threadId": thread_id,
            "runtime": runtime,
            "link": link_state,
            "execution": { "available": execution.is_some(), "active": execution.flatten() },
            "queue": queue,
            "observed": { "available": observed.is_some(), "turn": observed.flatten() },
            "codex": codex,
        }))
    }
}
