// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub const TERMINAL_STAGE_STATUSES: &[&str] =
    &["passed", "failed", "rejected", "cancelled", "skipped"];

pub fn can_transition_stage(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    if TERMINAL_STAGE_STATUSES.contains(&from) {
        return false;
    }
    matches!(
        (from, to),
        ("pending", "waiting_approval")
            | ("pending", "queued")
            | ("pending", "passed")
            | ("pending", "blocked")
            | ("waiting_approval", "queued")
            | ("waiting_approval", "passed")
            | ("waiting_approval", "rejected")
            | ("waiting_approval", "cancelled")
            | ("queued", "claimed")
            | ("queued", "running")
            | ("queued", "failed")
            | ("queued", "cancelled")
            | ("claimed", "running")
            | ("claimed", "failed")
            | ("claimed", "cancelled")
            | ("running", "passed")
            | ("running", "failed")
            | ("running", "cancelled")
            | ("blocked", "passed")
            | ("blocked", "failed")
            | ("blocked", "cancelled")
    )
}

pub fn group_satisfied(completion: &str, statuses: &[String]) -> bool {
    match completion {
        "any" => statuses.iter().any(|status| status == "passed"),
        _ => !statuses.is_empty() && statuses.iter().all(|status| status == "passed"),
    }
}
