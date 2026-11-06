// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Control reads consume identity and runtime facts, independently of historical bodies.
use super::*;

#[derive(Debug, PartialEq)]
enum Activity {
    Active,
    Idle,
    Unknown,
}

struct OwnedControlState {
    turn_id: Option<String>,
    pending_transition: bool,
    goal_active: bool,
}

#[derive(Debug)]
pub(super) struct CodexControlSnapshot {
    pub(super) latest_turn_id: Option<String>,
    pub(super) active_turn_id: Option<String>,
    activity: Activity,
    terminal_status: Option<&'static str>,
    runtime_status: &'static str,
    latest_turn_status: &'static str,
    has_owned_control: bool,
    pending_owner_transition: bool,
    active_owner_goal: bool,
}

impl CodexControlSnapshot {
    // This proves absence of a runner only for an owner disposition. It never proves
    // the historical turn completed; callers must also fence local admissions.
    pub(super) fn is_inactive_for_owner_resolution(&self) -> bool {
        !self.pending_owner_transition
            && !self.active_owner_goal
            && (self.is_idle() || self.runtime_status == "notLoaded")
    }

    pub(super) fn has_active_owner_resolution_control(&self) -> bool {
        self.runtime_status == "active" || self.pending_owner_transition || self.active_owner_goal
    }

    pub(super) fn diagnostic_summary(&self) -> Value {
        json!({"runtimeStatus":self.runtime_status,"latestTurnStatus":self.latest_turn_status,
            "derivedActivity":format!("{:?}",self.activity),"hasOwnedControl":self.has_owned_control,
            "hasLatestTurn":self.latest_turn_id.is_some(),"hasActiveTurn":self.active_turn_id.is_some(),
            "pendingOwnerTransition":self.pending_owner_transition,"activeOwnerGoal":self.active_owner_goal})
    }

    pub(super) fn is_idle(&self) -> bool {
        self.activity == Activity::Idle
    }

    pub(super) fn terminal_task_status(&self) -> Option<&'static str> {
        self.terminal_status
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn read_codex_recent_turns(
        &self,
        thread_id: &str,
    ) -> Result<CodexControlSnapshot, String> {
        self.read_codex_recent_turns_with_client(&self.codex_app_server, thread_id)
            .await
    }

    pub(super) async fn read_codex_recent_turns_with_client(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
    ) -> Result<CodexControlSnapshot, String> {
        let mut page = super::super::codex_transcript_page::request_codex_turn_page(
            client,
            json!({
                "threadId":thread_id,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"
            }),
        )
        .await?;
        let turns = page
            .get_mut("data")
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
            .ok_or("thread/turns/list returned no metadata page")?;
        if turns.len() > 1
            || turns.iter().any(|turn| {
                turn["items"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
            })
        {
            return Err("Control turn metadata exceeded its requested page budget".to_owned());
        }
        // Read runtime activity after turn metadata: a new Goal turn may start between reads.
        let mut metadata = read_codex_thread_metadata(client, thread_id).await?;
        let mut thread = metadata
            .get_mut("thread")
            .map(Value::take)
            .filter(Value::is_object)
            .ok_or("thread/read returned a response without thread metadata")?;
        thread["turns"] = Value::Array(turns);
        let owned = self.owned_control_state(thread_id);
        Ok(control_snapshot(&thread, owned))
    }

    fn owned_control_state(&self, thread_id: &str) -> Option<OwnedControlState> {
        let link = self.store.find_summary_by_thread_id(thread_id)?;
        let native = crate::runtime_work::lifecycle::native_execution_state(&link);
        use crate::runtime_work::lifecycle::NativeExecutionPhase;
        let owns_native = native
            .as_ref()
            .is_some_and(|state| state.phase != NativeExecutionPhase::Idle);
        if !self.is_active_local_task(&link.local_task_id) && !owns_native {
            return None;
        }
        Some(OwnedControlState {
            turn_id: native
                .as_ref()
                .and_then(|state| state.turn_id.clone())
                .or_else(|| {
                    self.active_codex_turn(&link.local_task_id)
                        .map(|turn| turn.turn_id)
                }),
            pending_transition: native.as_ref().is_some_and(|state| {
                matches!(
                    state.phase,
                    NativeExecutionPhase::Queued
                        | NativeExecutionPhase::Starting
                        | NativeExecutionPhase::Continuing
                        | NativeExecutionPhase::Recovering
                )
            }),
            goal_active: link.goal_status.as_deref() == Some("active"),
        })
    }
}

fn control_snapshot(thread: &Value, owned: Option<OwnedControlState>) -> CodexControlSnapshot {
    let turn = thread["turns"].as_array().and_then(|turns| turns.last());
    let latest_turn_id = turn.and_then(|turn| string_field(turn, "id"));
    let runtime = super::super::response::codex_thread_status_type(thread);
    let runtime_status = match runtime.as_deref() {
        Some("active") => "active",
        Some("idle") => "idle",
        Some("notLoaded") => "notLoaded",
        Some("systemError") => "systemError",
        None => "missing",
        _ => "unknown",
    };
    let latest_turn_status = match turn.and_then(|turn| turn["status"].as_str()) {
        Some("inProgress") => "inProgress",
        Some("interrupted") => "interrupted",
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("cancelled") => "cancelled",
        None => "missing",
        _ => "unknown",
    };
    let has_owned_control = owned.is_some();
    let pending_owner_transition = owned.as_ref().is_some_and(|owned| owned.pending_transition);
    let active_owner_goal = owned.as_ref().is_some_and(|owned| owned.goal_active);
    let awaiting_next_turn = owned.as_ref().is_some_and(|owned| {
        owned.pending_transition
            || (owned.goal_active && codex_thread_terminal_task_status(thread) == Some("done"))
    });
    let metadata_active_turn_id = codex_thread_in_progress_turn_id(thread);
    let activity = match runtime.as_deref() {
        Some("active") => Activity::Active,
        Some("idle") if awaiting_next_turn => Activity::Active,
        Some("idle")
            if owned.as_ref().map_or(true, |owned| {
                owned.turn_id.is_some() && owned.turn_id == latest_turn_id
            }) =>
        {
            Activity::Idle
        }
        Some("notLoaded") if owned.is_some() => Activity::Active,
        // Missing runtime status cannot prove completion, but a running turn can
        // still identify the provider-only execution that an explicit stop targets.
        None if !awaiting_next_turn && metadata_active_turn_id.is_some() => Activity::Active,
        _ => Activity::Unknown,
    };
    let active_turn_id = (activity == Activity::Active)
        .then(|| {
            if awaiting_next_turn && runtime.as_deref() != Some("active") {
                return None;
            }
            owned
                .filter(|_| !awaiting_next_turn)
                .and_then(|owned| owned.turn_id)
                .or(metadata_active_turn_id)
                .or_else(|| {
                    turn.filter(|turn| {
                        !awaiting_next_turn
                            && turn["status"] == "interrupted"
                            && turn["completedAt"].is_null()
                    })
                    .and_then(|turn| string_field(turn, "id"))
                })
        })
        .flatten();
    let terminal_status = (activity == Activity::Idle)
        .then(|| codex_thread_terminal_task_status(thread))
        .flatten()
        .filter(|status| {
            // Turn lists can synthesize interruption without observing a terminal boundary.
            *status != "cancelled"
                || turn.is_some_and(|turn| turn["completedAt"].as_i64().is_some())
        });
    CodexControlSnapshot {
        latest_turn_id,
        active_turn_id,
        activity,
        terminal_status,
        runtime_status,
        latest_turn_status,
        has_owned_control,
        pending_owner_transition,
        active_owner_goal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_disposition_does_not_turn_unloaded_history_into_completion_or_bypass_goals() {
        for runtime in ["notLoaded", "idle"] {
            let thread = json!({"status":{"type":runtime},"turns":[{"id":"current","status":"interrupted"}]});
            let native = control_snapshot(&thread, None);
            assert!(native.is_inactive_for_owner_resolution());
            assert_eq!(native.terminal_task_status(), None);
            if runtime == "notLoaded" {
                assert!(!native.is_idle());
            }
            for (pending_transition, goal_active) in [(true, false), (false, true)] {
                let owned = Some(OwnedControlState {
                    turn_id: Some("current".into()),
                    pending_transition,
                    goal_active,
                });
                let native = control_snapshot(&thread, owned);
                assert!(!native.is_inactive_for_owner_resolution());
                assert!(native.has_active_owner_resolution_control());
            }
        }
    }

    #[test]
    fn missing_runtime_status_preserves_only_positive_running_turn_evidence() {
        for status in ["inProgress", "completed", "failed", "interrupted"] {
            let thread = json!({"turns":[{
                "id":"current","status":status,"completedAt":123
            }]});
            let snapshot = control_snapshot(&thread, None);
            assert!(!snapshot.is_idle(), "{status}");
            assert_eq!(snapshot.terminal_task_status(), None, "{status}");
            assert_eq!(
                snapshot.active_turn_id.as_deref(),
                (status == "inProgress").then_some("current"),
                "{status}"
            );
        }
    }

    #[test]
    fn explicit_runtime_facts_and_pending_transition_override_running_history() {
        for runtime in ["idle", "notLoaded", "unrecognized"] {
            let thread = json!({"status":{"type":runtime},"turns":[{
                "id":"current","status":"inProgress"
            }]});
            let snapshot = control_snapshot(&thread, None);
            assert_eq!(snapshot.is_idle(), runtime == "idle", "{runtime}");
            assert_eq!(snapshot.active_turn_id, None, "{runtime}");
            assert_eq!(snapshot.terminal_task_status(), None, "{runtime}");
        }
        let thread = json!({"turns":[{"id":"old","status":"inProgress"}]});
        for goal_active in [false, true] {
            let snapshot = control_snapshot(
                &thread,
                Some(OwnedControlState {
                    turn_id: Some("old".into()),
                    pending_transition: true,
                    goal_active,
                }),
            );
            assert!(!snapshot.is_idle());
            assert_eq!(snapshot.active_turn_id, None);
            assert_eq!(snapshot.terminal_task_status(), None);
        }
    }

    #[test]
    fn cancellation_outcome_requires_a_completion_fact() {
        let mut thread = json!({"status":{"type":"idle"},"turns":[{
            "id":"turn-1","status":"interrupted","completedAt":null
        }]});
        assert_eq!(control_snapshot(&thread, None).terminal_task_status(), None);
        thread["turns"][0]["completedAt"] = json!(123);
        assert_eq!(
            control_snapshot(&thread, None).terminal_task_status(),
            Some("cancelled")
        );
    }

    #[test]
    fn a_successful_goal_turn_cannot_settle_the_owning_execution_or_interrupt_the_old_turn() {
        let thread = json!({"status":{"type":"idle"},"turns":[{
            "id":"finished","status":"completed","completedAt":123
        }]});
        for (pending_transition, goal_active) in [(true, false), (false, true)] {
            let snapshot = control_snapshot(
                &thread,
                Some(OwnedControlState {
                    turn_id: Some("finished".into()),
                    pending_transition,
                    goal_active,
                }),
            );
            assert!(!snapshot.is_idle());
            assert_eq!(snapshot.terminal_task_status(), None);
            assert_eq!(snapshot.active_turn_id, None);
        }
        let ordinary = control_snapshot(
            &thread,
            Some(OwnedControlState {
                turn_id: Some("finished".into()),
                pending_transition: false,
                goal_active: false,
            }),
        );
        assert!(ordinary.is_idle());
        assert_eq!(ordinary.terminal_task_status(), Some("done"));
    }
}
