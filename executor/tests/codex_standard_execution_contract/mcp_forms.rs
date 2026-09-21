// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use wegent_executor::agents::interactive_mcp::is_deferred_user_input_result;

fn completed_form() -> Value {
    // The real app-server wraps FastMCP's serialized result in both content fields.
    let output = json!({
        "__silent_exit__": true, "__deferred_user_input__": true,
        "success": true, "status": "waiting_for_user_response"
    })
    .to_string();
    notification(
        "item/completed",
        json!({
            "turnId": "turn-1", "item": {
                "id": "mcp-form-1", "type": "mcpToolCall", "status": "completed",
                "server": "interactive_wegent-interactive-form-question",
                "tool": "interactive_form_question", "error": null,
                "arguments": {"questions": [
                    {"id": "features", "question": "Which features?", "input_type": "choice",
                     "multi_select": true, "options": [
                        {"label": "Search", "value": "search", "recommended": true},
                        {"label": "Cart", "value": "cart"}
                     ]},
                    {"id": "notes", "question": "Any notes?", "input_type": "text", "required": false}
                ]},
                "result": {"content": [{"type": "text", "text": output}],
                           "structuredContent": {"result": output}, "isError": false}
            }
        }),
    )
}

#[tokio::test]
async fn mcp_form_renders_then_interrupts_and_resumes_saved_thread_with_answers() {
    let _lock = env_lock().await;
    let message = completed_form();
    let fixture = Fixture::with_initial_message("mcp-form", message.clone());
    let engine = fixture.engine();
    let mut request = fixture.request("first");
    // Session persistence accepts real task IDs, not tempfile names with dots.
    request.task_id = "520".to_owned();
    let (outcome, events) = execute(&engine, request.clone()).await;
    assert_waiting(outcome);

    let added = events
        .iter()
        .find(|e| e.event_type == "response.output_item.added")
        .unwrap();
    let done = events
        .iter()
        .find(|e| e.event_type == "response.output_item.done")
        .unwrap();
    assert_eq!(added.data["item"]["call_id"], "mcp-form-1");
    assert_eq!(added.data["item"]["name"], "interactive_form_question");
    assert_eq!(
        serde_json::from_str::<Value>(added.data["item"]["arguments"].as_str().unwrap()).unwrap(),
        message["params"]["item"]["arguments"]
    );
    let output: Value =
        serde_json::from_str(done.data["item"]["output"].as_str().unwrap()).unwrap();
    assert!(is_deferred_user_input_result(&output));
    assert!(!events
        .iter()
        .any(|e| e.event_type == "response.block.created"));
    assert!(fixture
        .messages()
        .iter()
        .any(|m| m["method"] == "turn/interrupt"));

    let mut answer = form_answer(&request, &added.data["item"], "answer");
    answer.extra.get_mut("interactive_form_answer").unwrap()["answers"] =
        json!({"features": ["search", "cart"], "notes": "中文🙂"});
    let mut wrong = answer.clone();
    wrong.extra.get_mut("interactive_form_answer").unwrap()["tool_use_id"] = json!("stale");
    assert_failed(execute(&engine, wrong).await.0);
    assert_failed(execute(&engine, request.clone()).await.0);
    answer.project_workspace_path = None;
    assert_completed(execute(&engine, answer).await.0);
    let messages = fixture.messages();
    let resume = messages
        .iter()
        .find(|m| m["method"] == "thread/resume")
        .unwrap();
    assert_eq!(resume["params"]["threadId"], "thread-1");
    let turn = messages
        .iter()
        .rfind(|m| m["method"] == "turn/start")
        .unwrap();
    let prompt = turn["params"]["input"][0]["text"].as_str().unwrap();
    let payload: Value = serde_json::from_str(prompt.split_once('\n').unwrap().1).unwrap();
    assert_eq!(payload["tool_use_id"], "mcp-form-1");
    assert_eq!(
        payload["answers"],
        json!({"features": ["search", "cart"], "notes": "中文🙂"})
    );
    assert_eq!(
        turn["params"]["cwd"],
        request.project_workspace_path.unwrap()
    );
}

#[tokio::test]
async fn mcp_form_cancel_answer_resumes_without_inventing_choices() {
    let _lock = env_lock().await;
    let fixture = Fixture::with_initial_message("mcp-form", completed_form());
    let engine = fixture.engine();
    let mut request = fixture.request("first");
    request.task_id = "520".to_owned();
    assert_waiting(execute(&engine, request.clone()).await.0);
    let mut answer = form_answer(&request, &json!({"call_id": "mcp-form-1"}), "cancel");
    answer.extra["interactive_form_answer"] =
        json!({"tool_use_id": "mcp-form-1", "status": "cancelled", "answers": {}});
    assert_completed(execute(&engine, answer).await.0);
    let messages = fixture.messages();
    let turn = messages
        .iter()
        .rfind(|m| m["method"] == "turn/start")
        .unwrap();
    assert!(turn["params"]["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("cancelled"));
}

#[tokio::test]
async fn failed_forms_and_unrelated_mcp_results_do_not_create_pending_forms() {
    let _lock = env_lock().await;
    for mutation in ["error", "unrelated", "child"] {
        let mut message = completed_form();
        match mutation {
            "error" => message["params"]["item"]["result"]["isError"] = json!(true),
            "unrelated" => message["params"]["item"]["tool"] = json!("read_file"),
            _ => message["params"]["threadId"] = json!("child-thread"),
        }
        let (outcome, events) = execute_notifications(&[message]).await;
        assert!(
            matches!(outcome, ExecutionOutcome::Completed { .. }),
            "{outcome:?}"
        );
        assert!(!events
            .iter()
            .any(|e| e.event_type == "response.output_item.done"));
    }
}
