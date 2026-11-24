// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route-table ownership for the internal chat-history subtask endpoints.
//!
//! Opting into the record route (`.../subtasks/{subtask_id}`) selects Rust. Its list
//! sibling (`.../subtasks`) stays on the Python fallback: its recorded case
//! exceeds the Replay identity bound (4096 entities per interaction) during
//! source dependency preparation, so no target behavior can satisfy it.

fn route_table() -> crate::RouteTable {
    crate::app_test_support::cutover_route_table(&[(
        "/api/internal/chat/history/:session_id/subtasks/:subtask_id",
        &["GET"],
    )])
}

#[test]
fn subtask_record_route_is_rust_owned() {
    let table = route_table();
    assert!(
        table.matches(
            &http::Method::GET,
            "/api/internal/chat/history/task-607617613450527/subtasks/607617613453930"
        ),
        "GET .../subtasks/{{subtask_id}} must be Rust-owned"
    );
}

#[test]
fn subtask_list_route_stays_on_python() {
    let table = route_table();
    assert!(
        !table.matches(
            &http::Method::GET,
            "/api/internal/chat/history/task-607617613450527/subtasks"
        ),
        "GET .../subtasks must remain on Python"
    );
}

/// A record path must not be shadowed by, or shadow, other methods.
#[test]
fn subtask_record_route_owns_only_get() {
    let table = route_table();
    let path = "/api/internal/chat/history/task-1/subtasks/2";
    assert!(!table.matches(&http::Method::POST, path));
    assert!(!table.matches(&http::Method::DELETE, path));
}
