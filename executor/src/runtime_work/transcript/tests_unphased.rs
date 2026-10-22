// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::super::*;

#[test]
fn active_unphased_snapshot_does_not_promote_process_text_before_the_next_tool() {
    let mut thread = json!({"id":"thread","turns":[{
        "id":"turn","status":"inProgress","items":[
            {"id":"user","type":"userMessage","content":[{"type":"inputText","text":"Inspect the failure"}]},
            {"id":"preamble","type":"agentMessage","text":"Inspecting the context."}
        ]
    }]});
    let live = transcript_messages(&thread, "device");
    assert_eq!(live[1]["content"], "");
    assert_eq!(live[1]["blocks"][0]["type"], "text");
    assert_eq!(live[1]["blocks"][0]["content"], "Inspecting the context.");

    thread["turns"][0]["status"] = json!("completed");
    let completed = transcript_messages(&thread, "device");
    assert_eq!(completed[1]["content"], "Inspecting the context.");
}

#[test]
fn active_explicit_final_snapshot_keeps_authoritative_answer_content() {
    let thread = json!({"id":"thread","turns":[{
        "id":"turn","status":"inProgress","items":[
            {"id":"user","type":"userMessage","content":[{"type":"inputText","text":"Inspect the failure"}]},
            {"id":"final","type":"agentMessage","phase":"final_answer","text":"The failure is fixed."}
        ]
    }]});
    let messages = transcript_messages(&thread, "device");
    assert_eq!(messages[1]["content"], "The failure is fixed.");
}
