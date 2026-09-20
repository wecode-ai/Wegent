// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use std::{
    fs,
    future::{ready, Ready},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::{mpsc, Mutex, MutexGuard};
use wegent_executor::{
    agents::CodexAppServerEngine,
    emitter::{EventEnvelope, ResponsesEventBuilder},
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
};

const TIMEOUT: Duration = Duration::from_secs(10);

#[path = "codex_standard_execution_contract/subagents.rs"]
mod subagents;

#[path = "codex_standard_execution_contract/reasoning.rs"]
mod reasoning;

#[path = "codex_standard_execution_contract/debug_stdout.rs"]
mod debug_stdout;

#[path = "codex_standard_execution_contract/workspace.rs"]
mod workspace;

#[path = "codex_standard_execution_contract/streaming.rs"]
mod streaming;

#[path = "codex_standard_execution_contract/mcp_forms.rs"]
mod mcp_forms;

#[derive(Clone)]
struct ChannelSink(mpsc::UnboundedSender<EventEnvelope>);

impl EventSink for ChannelSink {
    type SendFuture = Ready<Result<(), String>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        ready(
            self.0
                .send(event)
                .map_err(|_| "event sink closed".to_owned()),
        )
    }
}

#[derive(Clone)]
struct FailingSink;

impl EventSink for FailingSink {
    type SendFuture = Ready<Result<(), String>>;

    fn send(&self, _: EventEnvelope) -> Self::SendFuture {
        ready(Err("callback delivery failed".to_owned()))
    }
}

#[tokio::test]
async fn codex_streams_commentary_reasoning_tools_and_final_before_completion() {
    let _lock = env_lock().await;
    let fixture = Fixture::new("stream");
    let engine = fixture.engine();
    let request = fixture.request("first");
    let (sink, mut events) = event_channel();
    let mut run = engine.run_with_events(request.clone(), sink, builder(&request));
    let mut collected = Vec::new();

    tokio::time::timeout(TIMEOUT, async {
        loop {
            tokio::select! {
                outcome = &mut run => panic!("completed before streamed events: {outcome:?}"),
                event = events.recv() => {
                    collected.push(event.expect("stream sink must remain open"));
                    if has_streamed_content(&collected) { break; }
                }
            }
        }
    })
    .await
    .expect("all content must stream while the process waits for completion permission");

    assert!(collected
        .iter()
        .all(|event| event.task_id == request.task_id));
    assert!(collected.iter().all(|event| event.subtask_id == "first"));
    assert!(collected.iter().all(|event| event.message_id == Some(71)));
    assert!(collected
        .iter()
        .any(|event| event.data["block"]["type"] == "thinking"
            && event.data["block"]["content"] == "Checking the execution path"));
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    assert_completed(tokio::time::timeout(TIMEOUT, run).await.unwrap());
}

#[tokio::test]
async fn codex_reasoning_uses_standard_snapshots_without_repeating_completed_summary() {
    let _lock = env_lock().await;
    let notifications = [
        notification(
            "item/reasoning/summaryTextDelta",
            json!({"itemId": "reasoning", "delta": "先"}),
        ),
        notification(
            "item/reasoning/summaryTextDelta",
            json!({"itemId": "reasoning", "delta": "分析"}),
        ),
        notification(
            "item/completed",
            json!({"item": {"id": "reasoning", "type": "reasoning", "summary": [{"type": "summary_text", "text": "先分析，再处理"}]}}),
        ),
        notification(
            "item/agentMessage/delta",
            json!({"itemId": "final", "phase": "finalAnswer", "delta": "done"}),
        ),
    ];
    let (_, events) = execute_notifications(&notifications).await;
    let mut snapshots: Vec<(String, String)> = Vec::new();
    for event in &events {
        if event.data["block"]["type"] == "thinking" {
            snapshots.push((
                event.data["block"]["id"].as_str().unwrap().to_owned(),
                event.data["block"]["content"].as_str().unwrap().to_owned(),
            ));
        }
        if let Some((_, content)) = snapshots
            .iter_mut()
            .find(|(id, _)| event.data["block_id"] == *id)
        {
            let updates = &event.data["updates"];
            assert!(
                updates.get("content_delta").is_none(),
                "reasoning requires complete snapshots: {updates}"
            );
            if let Some(value) = updates["content"].as_str() {
                *content = value.to_owned();
            }
        }
    }
    assert_eq!(
        snapshots
            .into_iter()
            .map(|(_, content)| content)
            .collect::<String>(),
        "先分析，再处理"
    );
    assert!(
        !events
            .iter()
            .any(|event| event.event_type == "response.reasoning_summary_text.delta"),
        "reasoning must not be duplicated through a second rendering path"
    );
}

#[tokio::test]
async fn codex_body_offsets_count_unicode_characters_and_preserve_completed_suffix() {
    let _lock = env_lock().await;
    let mut notifications: Vec<_> = ["你好", "🙂", "，世界"]
        .into_iter()
        .map(|delta| {
            notification(
                "item/agentMessage/delta",
                json!({"itemId": "final", "phase": "finalAnswer", "delta": delta}),
            )
        })
        .collect();
    notifications.push(notification(
        "item/completed",
        json!({"item": {
            "id": "final", "type": "agentMessage", "phase": "finalAnswer", "text": "你好🙂，世界！"
        }}),
    ));
    let (outcome, events) = execute_notifications(&notifications).await;
    let mut reconstructed = String::new();
    for event in events
        .iter()
        .filter(|event| event.event_type == "response.output_text.delta")
    {
        let offset = event.data["offset"]
            .as_u64()
            .expect("standard body delta requires offset");
        assert_eq!(offset as usize, reconstructed.chars().count());
        reconstructed.push_str(event.data["delta"].as_str().unwrap());
    }
    assert_eq!(reconstructed, "你好🙂，世界！");
    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: reconstructed
        }
    );
}

#[tokio::test]
async fn codex_completed_only_body_streams_a_standard_delta_before_turn_completion() {
    let _lock = env_lock().await;
    let fixture = Fixture::with_notifications(&[notification(
        "item/completed",
        json!({"item": {
            "id": "final", "type": "agentMessage", "phase": "finalAnswer", "text": "完整🙂正文"
        }}),
    )]);
    let request = fixture.request("first");
    let (sink, mut events) = event_channel();
    let mut run = fixture
        .engine()
        .run_with_events(request.clone(), sink, builder(&request));
    let body = tokio::time::timeout(TIMEOUT, async {
        loop {
            tokio::select! {
                outcome = &mut run => panic!("body was not streamed before completion: {outcome:?}"),
                event = events.recv() => {
                    let event = event.expect("stream sink must remain open");
                    if event.event_type.starts_with("response.output_text.") { break event; }
                }
            }
        }
    }).await.expect("completed item must immediately emit standard body content");
    assert_eq!(body.event_type, "response.output_text.delta");
    assert_eq!(body.data["delta"], "完整🙂正文");
    assert_eq!(body.data["offset"], 0);
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    assert_eq!(
        tokio::time::timeout(TIMEOUT, run).await.unwrap(),
        ExecutionOutcome::Completed {
            content: "完整🙂正文".to_owned()
        }
    );
}

#[tokio::test]
async fn codex_commentary_and_tool_updates_use_complete_standard_snapshots() {
    let _lock = env_lock().await;
    let notifications = [
        notification(
            "item/agentMessage/delta",
            json!({"itemId": "commentary", "phase": "commentary", "delta": "开始"}),
        ),
        notification(
            "item/agentMessage/delta",
            json!({"itemId": "commentary", "phase": "commentary", "delta": "检查"}),
        ),
        notification(
            "item/completed",
            json!({"item": {"id": "commentary", "type": "agentMessage", "phase": "commentary", "text": "开始检查"}}),
        ),
        notification(
            "item/started",
            json!({"item": {"id": "tool", "type": "commandExecution", "command": "printf version", "status": "inProgress"}}),
        ),
        notification(
            "item/commandExecution/outputDelta",
            json!({"itemId": "tool", "delta": "版本"}),
        ),
        notification(
            "item/commandExecution/outputDelta",
            json!({"itemId": "tool", "delta": "正常"}),
        ),
        notification(
            "item/completed",
            json!({"item": {"id": "tool", "type": "commandExecution", "command": "printf version", "status": "completed", "aggregatedOutput": "版本正常", "exitCode": 0}}),
        ),
        notification(
            "item/agentMessage/delta",
            json!({"itemId": "final", "phase": "finalAnswer", "delta": "done"}),
        ),
    ];
    let (_, events) = execute_notifications(&notifications).await;
    let updates: Vec<_> = events
        .iter()
        .filter(|event| event.event_type == "response.block.updated")
        .map(|event| &event.data["updates"])
        .collect();
    for update in &updates {
        assert!(
            update.get("content_delta").is_none(),
            "standard content must be a snapshot: {update}"
        );
        assert!(
            update.get("tool_output_delta").is_none(),
            "standard tool output must be a snapshot: {update}"
        );
    }
    assert!(updates.iter().any(|update| update["content"] == "开始检查"));
    let tool_outputs: Vec<_> = updates
        .iter()
        .filter_map(|update| update["tool_output"].as_str())
        .collect();
    assert!(
        tool_outputs
            .iter()
            .all(|output| "版本正常".starts_with(output))
            && tool_outputs
                .windows(2)
                .all(|pair| pair[1].starts_with(pair[0])),
        "tool snapshots must retain prior chunks: {tool_outputs:?}"
    );
    assert_eq!(tool_outputs.last(), Some(&"版本正常"));
}

#[tokio::test]
async fn codex_native_form_resumes_the_same_process_across_engine_clones_and_subtasks() {
    let _lock = env_lock().await;
    let fixture = Fixture::new("question");
    let engine = fixture.engine();
    let request = fixture.request("first");
    let (outcome, events) = execute(&engine, request.clone()).await;
    assert_waiting(outcome);
    let form = form_call(&events);
    assert_eq!(form["arguments"]["questions"][0]["id"], "choice");
    assert_eq!(form["arguments"]["questions"][0]["input_type"], "choice");
    assert_eq!(
        form["arguments"]["questions"][0]["options"][0]["value"],
        "Ship"
    );
    assert_eq!(form["arguments"]["questions"][1]["input_type"], "text");
    assert!(form.get("render_payload").is_none());

    let answer = form_answer(&request, &form, "second");
    let (outcome, events) = execute(&engine.clone(), answer).await;
    assert_completed(outcome);
    assert!(events.iter().all(|event| event.subtask_id == "second"));
    assert_single_turn(&fixture.messages());
    assert_eq!(
        rpc_answers(&fixture.messages()),
        vec![json!({
            "id": 41,
            "result": {"answers": {
                "choice": {"answers": ["Ship"]},
                "notes": {"answers": ["checked"]}
            }}
        })]
    );
}

#[tokio::test]
async fn codex_wrong_task_or_tool_answers_do_not_consume_the_pending_form() {
    let _lock = env_lock().await;
    let fixture = Fixture::new("question");
    let engine = fixture.engine();
    let request = fixture.request("first");
    let (outcome, events) = execute(&engine, request.clone()).await;
    assert_waiting(outcome);
    let answer = form_answer(&request, &form_call(&events), "second");

    let mut wrong_task = answer.clone();
    wrong_task.task_id = "another-task".to_owned();
    assert_failed(execute(&engine, wrong_task).await.0);
    let mut wrong_tool = answer.clone();
    wrong_tool.extra.get_mut("interactive_form_answer").unwrap()["tool_use_id"] =
        json!("stale-tool");
    assert_failed(execute(&engine, wrong_tool).await.0);
    let mut unrelated_message = request;
    unrelated_message.subtask_id = "unrelated".to_owned();
    assert_failed(execute(&engine, unrelated_message).await.0);
    assert!(rpc_answers(&fixture.messages()).is_empty());

    assert_completed(execute(&engine, answer).await.0);
    assert_eq!(rpc_answers(&fixture.messages()).len(), 1);
    assert_single_turn(&fixture.messages());
}

#[tokio::test]
async fn codex_preserves_a_second_form_and_its_string_rpc_id() {
    let _lock = env_lock().await;
    let fixture = Fixture::new("two-questions");
    let engine = fixture.engine();
    let request = fixture.request("first");
    let (outcome, events) = execute(&engine, request.clone()).await;
    assert_waiting(outcome);
    let first_form = form_call(&events);
    let first_answer = form_answer(&request, &first_form, "second");
    let (outcome, events) = execute(&engine.clone(), first_answer.clone()).await;
    assert_waiting(outcome);
    let second_form = form_call(&events);
    assert_ne!(first_form["call_id"], second_form["call_id"]);
    assert_eq!(events.last().unwrap().subtask_id, "second");

    assert_failed(execute(&engine, first_answer.clone()).await.0);
    let second_answer = form_answer(&first_answer, &second_form, "third");
    assert_completed(execute(&engine.clone(), second_answer).await.0);
    let answers = rpc_answers(&fixture.messages());
    assert_eq!(answers.len(), 2);
    assert_eq!(answers[0]["id"], 41);
    assert_eq!(answers[1]["id"], "second-request");
    assert_eq!(
        answers[1]["result"]["answers"]["choice"]["answers"],
        json!(["Ship"])
    );
    assert_single_turn(&fixture.messages());
}

#[tokio::test]
async fn codex_cancelling_a_pending_form_cleans_up_the_process_and_rejects_stale_answers() {
    let _lock = env_lock().await;
    let fixture = Fixture::new("question");
    let engine = fixture.engine();
    let request = fixture.request("first");
    let (outcome, events) = execute(&engine, request.clone()).await;
    assert_waiting(outcome);
    let answer = form_answer(&request, &form_call(&events), "second");
    let pid = fixture.messages()[0]["pid"].as_i64().unwrap() as i32;

    assert!(engine
        .cancel_pending(&request.task_id, Some("wrong-subtask"))
        .is_none());
    let event = engine
        .clone()
        .cancel_pending(&request.task_id, Some("first"))
        .unwrap();
    assert_eq!(event.task_id, request.task_id);
    assert_eq!(event.subtask_id, "first");
    assert_eq!(event.message_id, Some(71));
    assert!(engine.cancel_pending(&request.task_id, None).is_none());
    assert_failed(execute(&engine, answer).await.0);
    assert!(rpc_answers(&fixture.messages()).is_empty());
    wait_for_process_exit(pid).await;
}

#[tokio::test]
async fn codex_cancelling_a_pending_form_terminates_its_tool_child_process() {
    let _lock = env_lock().await;
    let fixture = Fixture::new("question-with-child");
    let engine = fixture.engine();
    let request = fixture.request("first");
    assert_waiting(execute(&engine, request.clone()).await.0);
    let messages = fixture.messages();
    let parent_pid = messages[0]["pid"].as_i64().unwrap() as i32;
    let child_pid = messages
        .iter()
        .find_map(|message| message["childPid"].as_i64())
        .expect("fake app-server must start a long-lived tool child") as i32;
    let mut cleanup = ProcessCleanup(vec![child_pid, parent_pid]);
    assert_eq!(unsafe { libc::kill(parent_pid, 0) }, 0);
    assert_eq!(unsafe { libc::kill(child_pid, 0) }, 0);

    assert!(engine.cancel_pending(&request.task_id, None).is_some());

    wait_for_process_exit(parent_pid).await;
    wait_for_process_exit(child_pid).await;
    cleanup.0.clear();
}

#[tokio::test]
async fn codex_propagates_stream_sink_failure() {
    let _lock = env_lock().await;
    let fixture = Fixture::new("stream");
    let engine = fixture.engine();
    let request = fixture.request("first");

    let outcome = tokio::time::timeout(
        TIMEOUT,
        engine.run_with_events(request.clone(), FailingSink, builder(&request)),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "callback delivery failed".to_owned()
        }
    );
    assert!(engine.cancel_pending(&request.task_id, None).is_none());
    wait_for_process_exit(fixture.messages()[0]["pid"].as_i64().unwrap() as i32).await;
}

#[tokio::test]
async fn codex_command_approval_returns_a_decision_to_the_original_rpc_request() {
    let _lock = env_lock().await;
    assert_approval_round_trip(command_approval(), "allow_once", "accept").await;
}

#[tokio::test]
async fn codex_file_approval_returns_a_session_decision_to_the_original_rpc_request() {
    let _lock = env_lock().await;
    assert_approval_round_trip(file_approval(), "allow_session", "acceptForSession").await;
}

#[tokio::test]
async fn codex_mcp_elicitation_returns_typed_form_values_to_the_original_rpc_request() {
    let _lock = env_lock().await;
    let _startup_timeout = EnvGuard::set("WEGENT_CODEX_TURN_STARTUP_TIMEOUT_SECONDS", "1");
    let fixture = Fixture::with_interaction(mcp_elicitation());
    let engine = fixture.engine();
    let request = fixture.request("first");
    let (outcome, events) = execute(&engine, request.clone()).await;
    assert_waiting(outcome);
    let form = form_call(&events);
    let mut answer = form_answer(&request, &form, "second");
    answer.extra.get_mut("interactive_form_answer").unwrap()["answers"] = json!({
        "color": "Green", "attempts": "3", "confirmed": "true", "notes": "Reviewed"
    });

    // Waiting for a user after receiving the form is no longer a startup stall.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_completed(execute(&engine.clone(), answer).await.0);

    assert_eq!(
        rpc_answers(&fixture.messages()),
        vec![json!({
            "id": "mcp-elicitation-81",
            "result": {
                "action": "accept",
                "content": {"color": "green", "attempts": 3, "confirmed": true, "notes": "Reviewed"},
                "_meta": null
            }
        })]
    );
    assert_single_turn(&fixture.messages());
}

#[tokio::test]
async fn codex_cancels_pending_native_approvals_and_mcp_elicitations() {
    let _lock = env_lock().await;
    for interaction in [command_approval(), file_approval(), mcp_elicitation()] {
        let fixture = Fixture::with_interaction(interaction);
        let engine = fixture.engine();
        let request = fixture.request("first");
        let (outcome, events) = execute(&engine, request.clone()).await;
        assert_waiting(outcome);
        let answer = form_answer(&request, &form_call(&events), "second");
        let pid = fixture.messages()[0]["pid"].as_i64().unwrap() as i32;

        let cancelled = engine.cancel_pending(&request.task_id, None).unwrap();

        assert_eq!(cancelled.task_id, request.task_id);
        assert_eq!(cancelled.subtask_id, "first");
        assert!(engine.cancel_pending(&request.task_id, None).is_none());
        assert_failed(execute(&engine, answer).await.0);
        assert!(rpc_answers(&fixture.messages()).is_empty());
        wait_for_process_exit(pid).await;
    }
}

async fn assert_approval_round_trip(interaction: Value, selection: &str, decision: &str) {
    let request_id = interaction["id"].clone();
    let context = interaction["params"].clone();
    let fixture = Fixture::with_interaction(interaction);
    let engine = fixture.engine();
    let request = fixture.request("first");
    let (outcome, events) = execute(&engine, request.clone()).await;
    assert_waiting(outcome);
    let form = form_call(&events);
    let question = &form["arguments"]["questions"][0];
    assert_eq!(question["id"], "__codex_approval");
    let question_text = question["question"].as_str().unwrap();
    for key in [
        "command",
        "cwd",
        "reason",
        "grantRoot",
        "additionalPermissions",
        "networkApprovalContext",
        "proposedExecpolicyAmendment",
        "proposedNetworkPolicyAmendments",
    ] {
        if let Some(value) = context.get(key) {
            let detail = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            assert!(
                question_text.contains(&detail),
                "approval question omits {key}: {question_text}"
            );
        }
    }
    assert!(question["options"]
        .as_array()
        .unwrap()
        .iter()
        .any(|option| option["value"] == selection));
    let mut answer = form_answer(&request, &form, "second");
    answer.extra.get_mut("interactive_form_answer").unwrap()["answers"] =
        json!({"__codex_approval": selection});

    assert_completed(execute(&engine.clone(), answer).await.0);

    assert_eq!(
        rpc_answers(&fixture.messages()),
        vec![json!({
            "id": request_id, "result": {"decision": decision}
        })]
    );
    assert_single_turn(&fixture.messages());
}

fn has_streamed_content(events: &[EventEnvelope]) -> bool {
    let block = |kind: &str, content: &str| {
        events.iter().any(|event| {
            event.data["block"]["type"] == kind && event.data["block"]["content"] == content
        })
    };
    block("text", "Inspecting the source")
        && events
            .iter()
            .any(|event| event.data["block"]["type"] == "tool")
        && events.iter().any(|event| {
            event.event_type == "response.output_text.delta" && event.data["delta"] == "done"
        })
}

fn event_channel() -> (ChannelSink, mpsc::UnboundedReceiver<EventEnvelope>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    (ChannelSink(sender), receiver)
}

fn builder(request: &ExecutionRequest) -> ResponsesEventBuilder {
    ResponsesEventBuilder::new(&request.task_id, &request.subtask_id, "test-model")
        .with_message_id(Some(71))
}

async fn execute(
    engine: &CodexAppServerEngine,
    request: ExecutionRequest,
) -> (ExecutionOutcome, Vec<EventEnvelope>) {
    let (sink, mut events) = event_channel();
    let outcome = tokio::time::timeout(
        TIMEOUT,
        engine.run_with_events(request.clone(), sink, builder(&request)),
    )
    .await
    .expect("standard Codex execution must finish or suspend");
    let mut collected = Vec::new();
    while let Ok(event) = events.try_recv() {
        collected.push(event);
    }
    (outcome, collected)
}

fn form_call(events: &[EventEnvelope]) -> Value {
    let added = events
        .iter()
        .find(|event| {
            event.event_type == "response.output_item.added"
                && event.data["item"]["name"] == "interactive_form_question"
        })
        .unwrap_or_else(|| panic!("missing standard interactive form: {events:?}"));
    let mut item = added.data["item"].clone();
    assert_eq!(item["type"], "function_call");
    assert_eq!(item["id"], item["call_id"]);
    assert!(item["call_id"].as_str().is_some_and(|id| !id.is_empty()));
    let completed = events
        .iter()
        .find(|event| {
            event.event_type == "response.output_item.done"
                && event.data["item"]["call_id"] == item["call_id"]
        })
        .expect("form must provide a tool result for backend rendering");
    let output: Value =
        serde_json::from_str(completed.data["item"]["output"].as_str().unwrap()).unwrap();
    assert_eq!(output["__deferred_user_input__"], true);
    assert_eq!(output["status"], "waiting_for_user_response");
    item["arguments"] = serde_json::from_str(item["arguments"].as_str().unwrap()).unwrap();
    item
}

fn form_answer(original: &ExecutionRequest, form: &Value, subtask_id: &str) -> ExecutionRequest {
    let mut request = original.clone();
    request.subtask_id = subtask_id.to_owned();
    request.extra.insert(
        "interactive_form_answer".to_owned(),
        json!({
            "tool_use_id": form["call_id"],
            "status": "submitted",
            "answers": {"choice": "Ship", "notes": ["checked"]}
        }),
    );
    request
}

fn assert_completed(outcome: ExecutionOutcome) {
    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

fn assert_waiting(outcome: ExecutionOutcome) {
    assert_eq!(
        outcome,
        ExecutionOutcome::WaitingForUserInput {
            stop_reason: "tool_deferred".to_owned()
        }
    );
}

fn assert_failed(outcome: ExecutionOutcome) {
    assert!(
        matches!(outcome, ExecutionOutcome::Failed { .. }),
        "expected failure, got {outcome:?}"
    );
}

fn rpc_answers(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter(|message| message.get("result").is_some())
        .cloned()
        .collect()
}

fn assert_single_turn(messages: &[Value]) {
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.get("pid").is_some())
            .count(),
        1
    );
    for method in ["initialize", "thread/start", "turn/start"] {
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["method"] == method)
                .count(),
            1,
            "unexpected {method} restart"
        );
    }
}

async fn wait_for_process_exit(pid: i32) {
    tokio::time::timeout(TIMEOUT, async {
        // Signal zero only checks process existence.
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("suspended Codex process must be reaped after cancellation or sink failure");
}

struct ProcessCleanup(Vec<i32>);

impl Drop for ProcessCleanup {
    fn drop(&mut self) {
        // Clean up test-owned processes even if an assertion fails.
        for pid in &self.0 {
            unsafe {
                libc::kill(*pid, libc::SIGKILL);
            }
        }
    }
}

async fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

struct EnvGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

struct Fixture {
    _env: Vec<EnvGuard>,
    root: TempDir,
    binary: PathBuf,
}

impl Fixture {
    fn new(mode: &str) -> Self {
        Self::with_initial_message(mode, question(json!(41)))
    }

    fn with_interaction(interaction: Value) -> Self {
        Self::with_initial_message("question", interaction)
    }

    fn with_notifications(notifications: &[Value]) -> Self {
        Self::with_initial_message("notifications", json!(notifications))
    }

    fn with_initial_message(mode: &str, interaction: Value) -> Self {
        let root = tempfile::tempdir().unwrap();
        let guards = [
            ("WEGENT_EXECUTOR_HOME", "executor"),
            ("WEGENT_CODEX_HOME", "codex"),
            ("WEGENT_WORKSPACE_ROOT", "workspaces"),
        ]
        .into_iter()
        .map(|(key, suffix)| EnvGuard::set(key, root.path().join(suffix)))
        .collect();
        let binary = root.path().join("fake-codex");
        fs::write(&binary, fake_codex_script(root.path(), mode, &interaction)).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            _env: guards,
            root,
            binary,
        }
    }

    fn engine(&self) -> CodexAppServerEngine {
        CodexAppServerEngine::new(self.binary.to_str().unwrap())
    }

    fn request(&self, subtask_id: &str) -> ExecutionRequest {
        ExecutionRequest {
            task_id: format!(
                "standard-codex-{}",
                self.root.path().file_name().unwrap().to_str().unwrap()
            ),
            subtask_id: subtask_id.to_owned(),
            user_name: Some("test-user".to_owned()),
            prompt: json!("Inspect the execution path"),
            bot: json!([{"id": 17, "shell_type": "Codex"}]),
            model_config: json!({"model": "openai", "model_id": "test-model", "protocol": "openai-responses"}),
            project_workspace_path: Some(self.root.path().to_str().unwrap().to_owned()),
            ..ExecutionRequest::default()
        }
    }

    fn messages(&self) -> Vec<Value> {
        fs::read_to_string(self.root.path().join("rpc.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

fn notification(method: &str, mut params: Value) -> Value {
    params["threadId"] = json!("thread-1");
    json!({"method": method, "params": params})
}

async fn execute_notifications(notifications: &[Value]) -> (ExecutionOutcome, Vec<EventEnvelope>) {
    let fixture = Fixture::with_notifications(notifications);
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    execute(&fixture.engine(), fixture.request("first")).await
}

fn question(id: Value) -> Value {
    json!({"id": id, "method": "item/tool/requestUserInput", "params": {
        "threadId": "thread-1", "turnId": "turn-1", "itemId": "question-item",
        "questions": [
            {"id": "choice", "header": "Action", "question": "What next?", "options": [
                {"label": "Ship", "description": "Finish this task"},
                {"label": "Review", "description": "Review changes"}
            ]},
            {"id": "notes", "header": "Notes", "question": "Any notes?", "options": []}
        ]
    }})
}

fn command_approval() -> Value {
    json!({"id": 81, "method": "item/commandExecution/requestApproval", "params": {
        "threadId": "thread-1", "turnId": "turn-1", "itemId": "command-81",
        "command": "git status", "cwd": "/workspace", "reason": "Inspect repository state",
        "additionalPermissions": {"network": {"enabled": true}},
        "networkApprovalContext": {"host": "api.example.test", "protocol": "https"},
        "proposedExecpolicyAmendment": ["git", "status"],
        "proposedNetworkPolicyAmendments": [{"host": "api.example.test", "action": "allow"}],
        "availableDecisions": ["accept", "acceptForSession", "decline", "cancel"]
    }})
}

fn file_approval() -> Value {
    json!({"id": "file-approval-81", "method": "item/fileChange/requestApproval", "params": {
        "threadId": "thread-1", "turnId": "turn-1", "itemId": "file-81",
        "reason": "Update repository file", "grantRoot": "/workspace"
    }})
}

fn mcp_elicitation() -> Value {
    json!({"id": "mcp-elicitation-81", "method": "mcpServer/elicitation/request", "params": {
        "threadId": "thread-1", "turnId": "turn-1", "serverName": "test-server",
        "mode": "form", "message": "Choose task settings",
        "requestedSchema": {"type": "object", "properties": {
            "color": {"type": "string", "title": "Color", "enum": ["green", "blue"], "enumNames": ["Green", "Blue"]},
            "attempts": {"type": "integer", "title": "Attempts"},
            "confirmed": {"type": "boolean", "title": "Confirmed"},
            "notes": {"type": "string", "title": "Notes"}
        }, "required": ["color", "attempts", "confirmed", "notes"]}
    }})
}

fn fake_codex_script(root: &Path, mode: &str, interaction: &Value) -> String {
    let script = r#"#!/bin/sh
LOG_PATH='__ROOT__/rpc.jsonl'
printf '{"pid":%s}\n' "$$" >> "$LOG_PATH"
if [ '__MODE__' = question-with-child ]; then
  sleep 300 &
  printf '{"childPid":%s}\n' "$!" >> "$LOG_PATH"
fi
complete() {
  printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","itemId":"final","delta":"done","phase":"finalAnswer"}}'
  printf '%s\n' '{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}'
  exit 0
}
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{"protocolVersion":1}}' ;;
    *'"method":"initialized"'*) ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*)
      printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
      printf '%s\n' '{"method":"thread/started","params":{"thread":{"id":"thread-1"}}}' ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}'
      if [ '__MODE__' = stream ]; then
        printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","itemId":"commentary","delta":"Inspecting the source","phase":"commentary"}}'
        printf '%s\n' '{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"thread-1","itemId":"reasoning","delta":"Checking the execution path"}}'
        printf '%s\n' '{"method":"item/started","params":{"threadId":"thread-1","item":{"id":"command","type":"commandExecution","command":"printf version","status":"inProgress"}}}'
        printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-1","item":{"id":"command","type":"commandExecution","command":"printf version","status":"completed","aggregatedOutput":"version","exitCode":0}}}'
        printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","itemId":"final","delta":"done","phase":"finalAnswer"}}'
        while [ ! -f '__ROOT__/release' ]; do sleep 0.01; done
        printf '%s\n' '{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}'
        exit 0
      elif [ '__MODE__' = notifications ]; then
        __NOTIFICATIONS__
        while [ ! -f '__ROOT__/release' ]; do sleep 0.01; done
        printf '%s\n' '{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}'
        exit 0
      elif [ '__MODE__' = mcp-form ] && [ -f '__ROOT__/form-finished' ]; then
        complete
      else
        printf '%s\n' '__FIRST_QUESTION__'
      fi ;;
    *'"method":"turn/interrupt"'*)
      touch '__ROOT__/form-finished'
      printf '%s\n' '{"id":4,"result":{}}'
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"interrupted"}}}'
      exit 0 ;;
    *'"id":41,'*)
      if [ '__MODE__' = two-questions ]; then
        printf '%s\n' '__SECOND_QUESTION__'
      else
        complete
      fi ;;
    *'"result":'*) complete ;;
  esac
done
"#;
    script
        .replace("__ROOT__", root.to_str().unwrap())
        .replace("__MODE__", mode)
        .replace("__FIRST_QUESTION__", &interaction.to_string())
        .replace(
            "__NOTIFICATIONS__",
            &interaction
                .as_array()
                .into_iter()
                .flatten()
                .map(|value| {
                    format!(
                        "printf '%s\\n' '{}'",
                        value.to_string().replace('\'', "'\"'\"'")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .replace(
            "__SECOND_QUESTION__",
            &question(json!("second-request")).to_string(),
        )
}
