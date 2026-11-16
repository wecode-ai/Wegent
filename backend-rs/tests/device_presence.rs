// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Focused tests use the same production projection without compiling the test-only Backend graph.

#[path = "../src/device_presence.rs"]
mod device_presence;

use device_presence::latest_online_time;

#[test]
fn offline_presence_survives_expiring_online_state() {
    assert_eq!(
        latest_online_time(Some("2026-11-06T08:00:00+08:00"), None).as_deref(),
        Some("2026-11-06T00:00:00+00:00")
    );
}

#[test]
fn latest_valid_observation_wins_without_moving_backwards() {
    assert_eq!(
        latest_online_time(Some("2026-11-06T00:00:00Z"), Some("2026-11-06T00:00:30Z")).as_deref(),
        Some("2026-11-06T00:00:30+00:00")
    );
    assert_eq!(
        latest_online_time(Some("2026-11-06T00:00:30Z"), Some("2026-11-06T00:00:00Z")).as_deref(),
        Some("2026-11-06T00:00:30+00:00")
    );
    assert_eq!(
        latest_online_time(Some("2026-11-06T00:00:30Z"), Some("invalid")).as_deref(),
        Some("2026-11-06T00:00:30+00:00")
    );
}

#[test]
fn unknown_or_invalid_history_stays_unknown() {
    assert!(latest_online_time(None, None).is_none());
    assert!(latest_online_time(Some("invalid"), None).is_none());
}
