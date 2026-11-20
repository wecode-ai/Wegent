//! Wake at the persisted source deadline instead of skipping it at an earlier fixed tick.
use super::*;

pub(super) const INTERVAL_MS: i64 = 15_000;

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
}
