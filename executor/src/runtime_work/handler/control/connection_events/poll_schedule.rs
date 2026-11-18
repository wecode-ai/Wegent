//! Wake at the persisted source deadline instead of skipping it at an earlier fixed tick.
use super::*;

pub(super) const INTERVAL_MS: i64 = 15_000;

fn delay(state: &Value, ui: bool, started_at: i64, now: i64) -> Duration {
    if !ui
        && state["operations"].as_object().is_some_and(|rows| {
            rows.values().any(|row| {
                row["status"] == "pending"
                    && row["pending_wakeup"] == true
                    && row["cloud_subscription"].is_null()
            })
        })
    {
        return Duration::ZERO;
    }
    let records = state[if ui { "observers" } else { "operations" }]
        .as_object()
        .into_iter()
        .flat_map(|rows| rows.values());
    let wait = records
        .filter(|row| {
            if ui {
                row["status"] == "observing"
                    && row["cloud_registration"].is_null()
                    && row["expires_at"].as_i64().is_some_and(|at| at > now)
            } else {
                row["status"] == "armed" && row["cloud_subscription"].is_null()
            }
        })
        .filter_map(|row| row["observation_id"].as_str())
        .filter_map(|id| state["observations"].get(id))
        .filter_map(|source| {
            let due = source["next_poll_at"].as_i64()?;
            if due > now {
                Some(due.saturating_sub(now))
            } else if source["attempted_at"]
                .as_i64()
                .is_some_and(|at| at >= started_at)
            {
                // Other work outlasted a source attempted in this iteration.
                Some(0)
            } else {
                // A blocked or invalid consumer must not create a busy loop.
                None
            }
        })
        .min()
        .unwrap_or(INTERVAL_MS)
        .min(INTERVAL_MS);
    Duration::from_millis(wait as u64)
}

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) fn connection_maintenance_due(
        next: &mut i64,
        now: i64,
    ) -> bool {
        if now < *next {
            return false;
        }
        *next = now.saturating_add(INTERVAL_MS);
        true
    }

    pub(in crate::runtime_work::handler) fn connection_maintenance_delay(
        next: i64,
        now: i64,
        source: Duration,
    ) -> Duration {
        source.min(Duration::from_millis(next.saturating_sub(now).max(0) as u64))
    }

    pub(in crate::runtime_work::handler) fn connection_observation_poll_delay(
        &self,
        ui: bool,
        started_at: i64,
    ) -> Duration {
        let result =
            workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                Ok(delay(state, ui, started_at, now_ms()))
            });
        match result {
            Ok(delay) => delay,
            Err(error) => {
                log_executor_event("Observation schedule unavailable", &[("code", error.code)]);
                Duration::from_millis(INTERVAL_MS as u64)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staggered_source_wakes_do_not_accelerate_stand_ins_or_cleanup() {
        let mut next = 0;
        let mut calls = Vec::new();
        for now in [
            0, 1000, 3000, 7000, 14999, 15000, 16000, 23000, 29999, 30000,
        ] {
            if RuntimeWorkRpcHandler::connection_maintenance_due(&mut next, now) {
                calls.push(now);
            }
            assert_eq!(
                RuntimeWorkRpcHandler::connection_maintenance_delay(
                    next,
                    now,
                    Duration::from_millis(100)
                ),
                Duration::from_millis(100.min((next - now) as u64))
            );
        }
        assert_eq!(calls, vec![0, 15000, 30000]);
        assert_eq!(
            RuntimeWorkRpcHandler::connection_maintenance_delay(
                next,
                50000,
                Duration::from_secs(15)
            ),
            Duration::ZERO
        );
    }

    #[test]
    fn a_nonzero_collection_duration_does_not_add_another_scheduler_period() {
        let mut state = json!({"operations":{"model":{"status":"armed","observation_id":"source"}},"observers":{"ui":{"status":"observing","observation_id":"source","expires_at":100000}},"observations":{"source":{"attempted_at":106929,"next_poll_at":121929}}});
        state["observers"]["ui"]["expires_at"] = json!(200000);
        for ui in [false, true] {
            assert_eq!(
                delay(&state, ui, 121778, 121778),
                Duration::from_millis(151)
            );
            assert_eq!(
                delay(&state, ui, 121929, 121929),
                Duration::from_secs(15),
                "An already attempted blocked consumer cannot spin"
            );
            state["observations"]["source"]["attempted_at"] = json!(122037);
            state["observations"]["source"]["next_poll_at"] = json!(137037);
            assert_eq!(delay(&state, ui, 121929, 122037), Duration::from_secs(15));
            assert_eq!(
                delay(&state, ui, 121929, 140000),
                Duration::ZERO,
                "Work that outlasts the next deadline catches up without a further period"
            );
            state["observations"]["source"] = json!({"attempted_at":106929,"next_poll_at":121929});
        }
    }

    #[test]
    fn only_active_local_consumers_contribute_deadlines() {
        let mut state = json!({"operations":{"model":{"status":"pending","observation_id":"source"}},"observers":{"ui":{"status":"observing","observation_id":"source","expires_at":5}},"observations":{"source":{"attempted_at":0,"next_poll_at":1001}}});
        assert_eq!(delay(&state, false, 1000, 1000), Duration::from_secs(15));
        assert_eq!(delay(&state, true, 1000, 1000), Duration::from_secs(15));
        state["operations"]["model"]["status"] = json!("armed");
        assert_eq!(delay(&state, false, 1000, 1000), Duration::from_millis(1));
        state["operations"]["model"]["cloud_subscription"] = json!({"id":"cloud"});
        assert_eq!(delay(&state, false, 1000, 1000), Duration::from_secs(15));
    }

    #[test]
    fn a_new_pending_batch_wakes_once_while_blocked_retries_keep_the_maintenance_period() {
        let mut state = json!({"operations":{"model":{"status":"pending","pending_wakeup":true}},"observations":{}});
        assert_eq!(delay(&state, false, 1000, 1000), Duration::ZERO);
        assert_eq!(delay(&state, true, 1000, 1000), Duration::from_secs(15));
        state["operations"]["model"]["pending_wakeup"] = json!(false);
        assert_eq!(delay(&state, false, 1000, 1000), Duration::from_secs(15));
        state["operations"]["model"]["pending_wakeup"] = json!(true);
        state["operations"]["model"]["status"] = json!("cancelled");
        assert_eq!(delay(&state, false, 1000, 1000), Duration::from_secs(15));
    }
}
