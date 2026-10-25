// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::*;

#[test]
fn command_notifications_preserve_all_native_terminal_statuses() {
    for (status, expected) in [
        ("inProgress", "pending"),
        ("completed", "done"),
        ("failed", "error"),
        ("declined", "error"),
    ] {
        let params = json!({"item": {
            "id":"command", "type":"commandExecution", "command":"cat private.txt",
            "status":status, "processId":null, "exitCode":null, "aggregatedOutput":null
        }});
        let (id, updates) = tool_update_from_notification(&params).unwrap();
        assert_eq!(id, "command");
        assert_eq!(updates["status"], expected, "native status: {status}");
        assert_eq!(updates["render_payload"]["status"], status);
        assert!(updates["render_payload"]["exitCode"].is_null());
    }
}

#[test]
fn declined_commands_remain_terminal_errors_in_native_history() {
    let thread = json!({"id":"thread", "cwd":"/project", "turns":[{
        "id":"turn", "status":"completed", "items":[{
            "id":"command", "type":"commandExecution", "command":"cat private.txt",
            "status":"declined", "processId":null, "exitCode":null,
            "aggregatedOutput":null
        }]
    }]});
    let messages = transcript_messages(&thread, "device");
    let block = &messages[0]["blocks"][0];
    assert_eq!(block["status"], "error");
    assert_eq!(block["render_payload"]["status"], "declined");
    assert!(block["render_payload"]["processId"].is_null());
}
