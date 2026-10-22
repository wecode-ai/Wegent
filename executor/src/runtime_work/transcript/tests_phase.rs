use super::super::*;

fn text_snapshot(turn_status: &str, phase: Option<&str>, response_item: bool) -> Value {
    let mut item = json!({
        "id": "message-1",
        "type": "agentMessage",
        "text": "Inspecting the failure.",
        "status": "completed"
    });
    if response_item {
        item = json!({
            "id": "message-1",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Inspecting the failure."}],
            "status": "completed"
        });
    }
    if let Some(phase) = phase {
        item["phase"] = json!(phase);
    }
    json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "status": turn_status,
            "items": [item]
        }]
    })
}

#[test]
fn active_snapshot_does_not_promote_completed_unphased_text_before_tool_arrives() {
    for response_item in [false, true] {
        for status in ["running", "inProgress", "active", "busy", "pending"] {
            let mut thread = text_snapshot(status, None, response_item);
            let messages = transcript_messages(&thread, "device-1");
            assert_eq!(messages[0]["status"], "streaming");
            assert_eq!(messages[0]["content"], "", "{status}, {response_item}");
            assert_eq!(messages[0]["runtimeItems"][0]["type"], "block");
            assert_eq!(messages[0]["blocks"][0]["type"], "text");
            assert_eq!(
                messages[0]["blocks"][0]["content"],
                "Inspecting the failure."
            );

            thread["turns"][0]["items"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "id": "call-1", "type": "function_call", "call_id": "call-1",
                    "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"
                }));
            let with_tool = transcript_messages(&thread, "device-1");
            assert_eq!(with_tool[0]["content"], "");
            assert_eq!(
                with_tool[0]["runtimeItems"][0],
                messages[0]["runtimeItems"][0]
            );
            assert_eq!(with_tool[0]["blocks"][1]["type"], "tool");
        }
    }
}

#[test]
fn completed_snapshot_promotes_unphased_text_to_final_output() {
    for response_item in [false, true] {
        let thread = text_snapshot("completed", None, response_item);
        let messages = transcript_messages(&thread, "device-1");
        assert_eq!(messages[0]["status"], "done");
        assert_eq!(messages[0]["content"], "Inspecting the failure.");
        assert_eq!(messages[0]["runtimeItems"][0]["type"], "assistant_text");
        assert!(messages[0]["blocks"].as_array().unwrap().is_empty());
    }
}

#[test]
fn active_snapshot_respects_explicit_assistant_phases() {
    for response_item in [false, true] {
        for phase in ["analysis", "commentary", "final_answer"] {
            let thread = text_snapshot("inProgress", Some(phase), response_item);
            let messages = transcript_messages(&thread, "device-1");
            assert_eq!(messages[0]["status"], "streaming");
            if phase == "final_answer" {
                assert_eq!(messages[0]["content"], "Inspecting the failure.");
                assert!(messages[0]["blocks"].as_array().unwrap().is_empty());
            } else {
                assert_eq!(messages[0]["content"], "");
                assert_eq!(
                    messages[0]["blocks"][0]["content"],
                    "Inspecting the failure."
                );
            }
        }
    }
}
