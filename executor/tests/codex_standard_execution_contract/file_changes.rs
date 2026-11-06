// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use axum::{routing::post, Json, Router};
use wegent_executor::{
    agents::{
        interactive_mcp::is_deferred_user_input_result, AgentCommandPlanner, AgentProcessEngine,
    },
    callback::CallbackSink,
    runner::BackgroundTaskRunner,
    server::TaskRunner,
};

struct CallbackServer {
    url: String,
    events: mpsc::UnboundedReceiver<Value>,
    task: tokio::task::JoinHandle<()>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl CallbackServer {
    async fn start() -> Self {
        let (sender, events) = mpsc::unbounded_channel();
        let app = Router::new().route(
            "/callback",
            post(move |Json(value): Json<Value>| {
                let sender = sender.clone();
                async move {
                    let _ = sender.send(value);
                    Json(json!({"success": true}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/callback", listener.local_addr().unwrap());
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap()
        });
        Self {
            url,
            events,
            task,
            shutdown: Some(shutdown),
        }
    }

    async fn finish(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
            (&mut self.task).await.unwrap();
        }
    }

    async fn terminal(&mut self, subtask_id: &str, expected: &str) -> Vec<Value> {
        tokio::time::timeout(TIMEOUT, async {
            let mut events = Vec::new();
            loop {
                let event = self.events.recv().await.expect("callback server open");
                assert_eq!(
                    event["subtask_id"],
                    subtask_id.parse::<i64>().unwrap(),
                    "{event}"
                );
                let terminal = matches!(
                    event["event_type"].as_str(),
                    Some("response.completed" | "response.incomplete" | "error")
                );
                if terminal {
                    assert_eq!(event["event_type"], expected, "{event}");
                }
                events.push(event);
                if terminal {
                    return events;
                }
            }
        })
        .await
        .expect("execution must finish or suspend through HTTP callback")
    }
}

impl Drop for CallbackServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn codex_file_changes_survive_two_native_forms_and_rejected_answers() {
    let _lock = env_lock().await;
    let fixture = Fixture::new("two-questions");
    let (_config, repo, request) = repository_request(&fixture, "910", "9101");
    let first_question = question(json!(41));
    let second_question = question(json!("second-request"));
    let script = fake_codex_script(fixture.root.path(), "two-questions", &first_question);
    let script = insert_before(
        script,
        &format!("printf '%s\\n' '{}'", first_question),
        &write_command(&repo, "before-answer.txt"),
    );
    let script = insert_before(
        script,
        &format!("printf '%s\\n' '{}'", second_question),
        &write_command(&repo, "between-answers.txt"),
    );
    let script = script.replace(
        "*'\"result\":'*) complete ;;",
        &format!(
            "*'\"result\":'*) {}; complete ;;",
            write_command(&repo, "after-answers.txt")
        ),
    );
    fs::write(&fixture.binary, script).unwrap();
    let mut callbacks = CallbackServer::start().await;
    let runner = process_runner(&fixture, &callbacks);

    runner.submit(request.clone()).await;
    let first = callbacks.terminal("9101", "response.completed").await;
    assert_waiting_callback(&first);
    let first_form = callback_form(&first);
    let first_answer = form_answer(&request, &first_form, "9102");

    let mut invalid = first_answer.clone();
    invalid.subtask_id = "9199".to_owned();
    invalid.extra.get_mut("interactive_form_answer").unwrap()["tool_use_id"] = json!("stale");
    runner.submit(invalid).await;
    assert_no_snapshot(&callbacks.terminal("9199", "error").await);
    assert!(rpc_answers(&fixture.messages()).is_empty());

    runner.submit(first_answer.clone()).await;
    let second = callbacks.terminal("9102", "response.completed").await;
    assert_waiting_callback(&second);
    let second_form = callback_form(&second);
    assert_ne!(first_form["call_id"], second_form["call_id"]);
    runner
        .submit(form_answer(&first_answer, &second_form, "9103"))
        .await;
    let final_events = callbacks.terminal("9103", "response.completed").await;
    let response = completed_response(&final_events);

    assert_eq!(response["stop_reason"], "end_turn");
    for field in ["file_changes", "task_file_changes"] {
        assert_snapshot_paths(
            &response[field],
            &[
                "after-answers.txt",
                "before-answer.txt",
                "between-answers.txt",
            ],
        );
    }
    assert_single_turn(&fixture.messages());
    let answers = rpc_answers(&fixture.messages());
    assert_eq!(answers.len(), 2);
    assert_eq!(answers[0]["id"], 41);
    assert_eq!(answers[1]["id"], "second-request");
    callbacks.finish().await;
}

#[tokio::test]
async fn codex_cancelled_and_failed_form_captures_do_not_leak_into_the_next_turn() {
    let _lock = env_lock().await;
    for cancel in [true, false] {
        let fixture = Fixture::new("question");
        let (_config, repo, request) = repository_request(&fixture, "920", "9201");
        let first_question = question(json!(41));
        let script = insert_before(
            fake_codex_script(fixture.root.path(), "question", &first_question),
            &format!("printf '%s\\n' '{}'", first_question),
            &write_command(&repo, "abandoned.txt"),
        );
        let script = script.replace(
            r#"{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}"#,
            r#"{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"failed","error":{"message":"fixture failure"}}}}"#,
        );
        fs::write(&fixture.binary, script).unwrap();
        let mut callbacks = CallbackServer::start().await;
        let runner = process_runner(&fixture, &callbacks);
        runner.submit(request.clone()).await;
        let waiting = callbacks.terminal("9201", "response.completed").await;
        assert_waiting_callback(&waiting);
        let answer = form_answer(&request, &callback_form(&waiting), "9202");
        let pid = fixture.messages()[0]["pid"].as_i64().unwrap() as i32;

        if cancel {
            assert!(
                runner
                    .cancel(request.task_id.clone(), Some(request.subtask_id.clone()))
                    .await
            );
            assert_no_snapshot(&callbacks.terminal("9201", "response.incomplete").await);
            runner.submit(answer).await;
            assert_no_snapshot(&callbacks.terminal("9202", "error").await);
        } else {
            runner.submit(answer).await;
            assert_no_snapshot(&callbacks.terminal("9202", "error").await);
        }
        wait_for_process_exit(pid).await;

        let script = fake_codex_script(fixture.root.path(), "mcp-form", &first_question);
        fs::write(fixture.root.path().join("form-finished"), "resume").unwrap();
        let script = script.replace(
            "        complete\n      else",
            &format!(
                "        {}\n        complete\n      else",
                write_command(&repo, "new-turn.txt")
            ),
        );
        fs::write(&fixture.binary, script).unwrap();
        let mut next = request.clone();
        next.subtask_id = "9203".to_owned();
        next.new_session = true;
        runner.submit(next).await;
        let completed = callbacks.terminal("9203", "response.completed").await;
        let response = completed_response(&completed);
        assert_snapshot_paths(&response["file_changes"], &["new-turn.txt"]);
        assert_snapshot_paths(
            &response["task_file_changes"],
            &["abandoned.txt", "new-turn.txt"],
        );
        callbacks.finish().await;
    }
}

#[tokio::test]
async fn codex_file_changes_survive_mcp_form_process_exit_and_thread_resume() {
    let _lock = env_lock().await;
    let deferred = json!({
        "__silent_exit__": true, "__deferred_user_input__": true,
        "success": true, "status": "waiting_for_user_response"
    });
    let form = notification(
        "item/completed",
        json!({
            "turnId": "turn-1", "item": {
                "id": "mcp-form-1", "type": "mcpToolCall", "status": "completed",
                "server": "interactive_wegent-interactive-form-question",
                "tool": "interactive_form_question", "error": null,
                "arguments": {"questions": [{"id": "choice", "question": "Continue?",
                    "input_type": "choice", "options": [{"label": "Ship", "value": "Ship"}]}]},
                "result": {"content": [{"type": "text", "text": deferred.to_string()}],
                    "structuredContent": {"result": deferred.to_string()}, "isError": false}
            }
        }),
    );
    let fixture = Fixture::with_initial_message("mcp-form", form.clone());
    let (_config, repo, request) = repository_request(&fixture, "930", "9301");
    let script = insert_before(
        fake_codex_script(fixture.root.path(), "mcp-form", &form),
        &format!("printf '%s\\n' '{}'", form),
        &write_command(&repo, "before-answer.txt"),
    );
    let script = script.replace(
        "        complete\n      else",
        &format!(
            "        {}\n        complete\n      else",
            write_command(&repo, "after-answer.txt")
        ),
    );
    fs::write(&fixture.binary, script).unwrap();
    let mut callbacks = CallbackServer::start().await;
    let runner = process_runner(&fixture, &callbacks);
    runner.submit(request.clone()).await;
    let waiting = callbacks.terminal("9301", "response.completed").await;
    assert_waiting_callback(&waiting);
    let mut answer = form_answer(&request, &callback_form(&waiting), "9302");
    answer.project_workspace_path = None;
    runner.submit(answer).await;
    let completed = callbacks.terminal("9302", "response.completed").await;
    let response = completed_response(&completed);

    for field in ["file_changes", "task_file_changes"] {
        assert_snapshot_paths(&response[field], &["after-answer.txt", "before-answer.txt"]);
    }
    let messages = fixture.messages();
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.get("pid").is_some())
            .count(),
        2,
        "MCP answers must resume after the deferred turn's process exits"
    );
    assert!(messages
        .iter()
        .any(|message| message["method"] == "thread/resume"));
    callbacks.finish().await;
}

fn repository_request(
    fixture: &Fixture,
    task_id: &str,
    subtask_id: &str,
) -> (Vec<EnvGuard>, PathBuf, ExecutionRequest) {
    let guards = vec![
        EnvGuard::set("GIT_CONFIG_GLOBAL", "/dev/null"),
        EnvGuard::set("GIT_CONFIG_NOSYSTEM", "1"),
    ];
    let repo = fixture.root.path().join("repository");
    fs::create_dir(&repo).unwrap();
    let mut git = std::process::Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            git.env_remove(key);
        }
    }
    let output = git
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .arg("-C")
        .arg(&repo)
        .args(["init", "--initial-branch=main"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let mut request = fixture.request(subtask_id);
    request.task_id = task_id.to_owned();
    request.project_workspace_path = Some(repo.display().to_string());
    (guards, repo, request)
}

fn process_runner(
    fixture: &Fixture,
    callbacks: &CallbackServer,
) -> BackgroundTaskRunner<AgentProcessEngine, CallbackSink> {
    BackgroundTaskRunner::new(
        AgentProcessEngine::new(AgentCommandPlanner::new(
            "unused-claude",
            fixture.binary.to_str().unwrap(),
        )),
        CallbackSink::new(&callbacks.url).unwrap(),
    )
}

fn insert_before(script: String, marker: &str, command: &str) -> String {
    assert!(script.contains(marker), "fixture marker missing: {marker}");
    script.replace(marker, &format!("{command}\n        {marker}"))
}

fn write_command(repo: &Path, path: &str) -> String {
    let target = repo
        .join(path)
        .display()
        .to_string()
        .replace('\'', "'\"'\"'");
    format!("printf '%s\\n' '{path}' > '{target}'")
}

fn callback_form(events: &[Value]) -> Value {
    let mut item = events
        .iter()
        .find(|event| {
            event["event_type"] == "response.output_item.added"
                && event["data"]["item"]["name"] == "interactive_form_question"
        })
        .expect("callback must publish the interactive form")["data"]["item"]
        .clone();
    assert_eq!(item["type"], "function_call");
    assert_eq!(item["id"], item["call_id"]);
    let done = events
        .iter()
        .find(|event| {
            event["event_type"] == "response.output_item.done"
                && event["data"]["item"]["call_id"] == item["call_id"]
        })
        .expect("callback must publish the deferred tool result");
    let output: Value =
        serde_json::from_str(done["data"]["item"]["output"].as_str().unwrap()).unwrap();
    // MCP results retain FastMCP's content/structuredContent wrapper; native
    // requestUserInput results carry the waiting payload directly.
    assert!(is_deferred_user_input_result(&output), "{output}");
    item["arguments"] = serde_json::from_str(item["arguments"].as_str().unwrap()).unwrap();
    item
}

fn completed_response(events: &[Value]) -> &Value {
    &events.last().unwrap()["data"]["response"]
}

fn assert_no_snapshot(events: &[Value]) {
    let response = completed_response(events);
    assert!(response.get("file_changes").is_none());
    assert!(response.get("task_file_changes").is_none());
}

fn assert_waiting_callback(events: &[Value]) {
    let response = completed_response(events);
    assert_eq!(response["stop_reason"], "tool_deferred");
    assert_eq!(response["silent_exit_reason"], "waiting_for_user_input");
    assert_no_snapshot(events);
}

fn assert_snapshot_paths(changes: &Value, expected: &[&str]) {
    assert_eq!(changes["status"], "active", "{changes}");
    let paths: Vec<_> = changes["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, expected);
    let patch = changes["diff"].as_str().unwrap();
    for path in expected {
        assert!(patch.contains(&format!("+{path}\n")), "{patch}");
    }
}
