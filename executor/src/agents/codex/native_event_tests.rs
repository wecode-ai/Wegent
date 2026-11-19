//! Keep event activation ahead of native Goal execution.
use std::{path::Path, sync::Arc, time::Duration};

use axum::{extract::State, routing::post, Json, Router};
use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore};

use crate::agents::CodexAppServerClient;

#[derive(Clone)]
struct Model {
    requests: mpsc::UnboundedSender<Value>,
    release: Arc<Semaphore>,
    count: Arc<std::sync::atomic::AtomicUsize>,
}

async fn respond(
    State(model): State<Model>,
    Json(input): Json<Value>,
) -> impl axum::response::IntoResponse {
    let index = model
        .count
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    model.requests.send(input).unwrap();
    if index == 0 {
        model.release.acquire().await.unwrap().forget();
    }
    let item = if index == 0 {
        json!({"type":"function_call","id":"fc_event","call_id":"call_event","name":"update_goal","arguments":"{\"status\":\"complete\"}"})
    } else {
        json!({"type":"message","id":"msg_event","role":"assistant","content":[{"type":"output_text","text":"Event processed.","annotations":[]}]})
    };
    let response = json!({"id":format!("resp_event_{index}"),"status":"completed","output":[item],"usage":{"input_tokens":11,"output_tokens":3,"total_tokens":14,"input_tokens_details":{"cached_tokens":0}}});
    let body: String = [
        json!({"type":"response.created","response":{"id":response["id"],"status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":response}),
    ]
    .iter()
    .map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap()))
    .collect();
    (
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        body,
    )
}

#[tokio::test]
#[ignore = "requires the repository-pinned Codex binary; invoked by the Executor CI job"]
async fn native_event_goal_injected_event_activates_before_first_request() {
    run_native_event_case(false).await;
}

#[tokio::test]
#[ignore = "requires the repository-pinned Codex binary; invoked by the Executor CI job"]
async fn native_event_goal_event_recovers_injection_without_repeating_work() {
    run_native_event_case(true).await;
}

async fn run_native_event_case(recover_injection: bool) {
    let binary = std::env::var("WEWORK_GOAL_TEST_CODEX_BINARY").unwrap();
    assert!(Path::new(&binary).is_absolute() && Path::new(&binary).is_file());
    let mut _environment = crate::agents::CodexLaunchEnvironment::new();
    _environment.without_browser_bridge();
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("codex");
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::env::set_var("WEGENT_CODEX_HOME", &home);
    let (send, mut receive) = mpsc::unbounded_channel();
    let model = Model {
        requests: send,
        release: Arc::new(Semaphore::new(0)),
        count: Arc::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route("/v1/responses", post(respond))
        .with_state(model.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    std::fs::write(home.join("config.toml"), format!("model = \"event-test-model\"\nmodel_provider = \"event_fixture\"\n[features]\ngoals = true\n[model_providers.event_fixture]\nname = \"Event fixture\"\nbase_url = \"http://{address}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n")).unwrap();
    let client = CodexAppServerClient::isolated_for_test(&binary, home.clone());
    let result = std::panic::AssertUnwindSafe(async {
        // Initial sessions and resumed work use Wework's same native provider
        // identity; event_fixture remains the configured inference source.
        let provider=wegent_model_proxy::codex_model_catalog::PROVIDER_ID;
        let started = client.request("thread/start", json!({"cwd":workspace,"model":"event-test-model","modelProvider":provider,"approvalPolicy":"never","sandbox":"read-only","persistExtendedHistory":true})).await.unwrap();
        let thread = started["thread"]["id"].as_str().unwrap();
        client.request("thread/goal/set", json!({"threadId":thread,"objective":"Process the connected source event and complete this goal.","status":"blocked","tokenBudget":20000})).await.unwrap();
        let before = client.request("thread/goal/get",json!({"threadId":thread})).await.unwrap();
        let prompt = json!("Continue the original work. Untrusted source data: event-wakeup-source-fact.");
        let item = json!({"type":"message","id":"msg_wework_event_4af404a14e6a5e37428a4d00a0ab1a45","role":"user","content":[{"type":"input_text","text":prompt}]});
        if recover_injection {
            client.request("thread/inject_items",json!({"threadId":thread,"items":[item]})).await.unwrap();
            client.restart().await;
            client.request("thread/resume",json!({"threadId":thread,"cwd":workspace,"model":"event-test-model","modelProvider":provider,"approvalPolicy":"never","sandbox":"read-only","excludeTurns":true})).await.unwrap();
            assert_eq!(model.count.load(std::sync::atomic::Ordering::SeqCst),0,"restoring an injected waiting Goal must not start the model");
        }
        let mut notifications = client.subscribe_runtime_notifications().await.unwrap();
        let phases = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = phases.clone();
        let requests = model.count.clone();
        let admission = crate::agents::EventGoalAdmission::new(thread.into(),crate::runtime_work::normalize_runtime_goal_timestamps(before["goal"].clone()),"test-operation".into(),prompt.clone(),recover_injection.then(||"injection_requested".into()),Arc::new(tokio::sync::Mutex::new(())).lock_owned().await,Box::new(move |phase| {
            if phase == "injected" { assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst),0,"history injection must not start the model"); }
            captured.lock().unwrap().push(phase.to_owned());
            Ok(())
        }));
        let mut request = crate::protocol::ExecutionRequest {
            task_id:"42".into(),subtask_id:"source-message".into(),prompt:prompt.clone(),project_workspace_path:Some(workspace.display().to_string()),
            model_config:json!({"model_id":"event-test-model","model_provider":"event_fixture","runtime_config":{"codex":{"use_user_config":true}}}),
            ..Default::default()
        };
        request.extra.insert("client_user_message_id".into(),json!("source-message"));
        if recover_injection {
            request.prompt=json!(format!("{}\nFresh runtime preparation context.",prompt.as_str().unwrap()));
        }
        let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured_starts=starts.clone();
        let runner=client.clone();
        let native_thread=thread.to_owned();
        let run=tokio::spawn(async move { runner.run_turn_with_cancel(request,crate::agents::CodexAppServerTurnOptions {
            event_goal:Some(admission),resume_thread_id:Some(native_thread),active_turn_started:Some(Box::new(move |thread,turn| { captured_starts.lock().unwrap().push((thread,turn)); })),..Default::default()
        }).await });
        let first = tokio::time::timeout(Duration::from_secs(15),receive.recv()).await.unwrap().unwrap();
        let event = first["input"].as_array().unwrap().iter().find(|input| {
            input["role"] == "user" && input["content"].to_string().contains("event-wakeup-source-fact")
        }).expect("the first model request must contain the delivered event");
        assert_eq!(event["id"], item["id"], "injected message IDs must use the Responses message prefix");
        let active = client.request("thread/goal/get",json!({"threadId":thread})).await.unwrap();
        assert_eq!(active["goal"]["status"],"active","The Goal must be active before the first model response");
        tokio::time::sleep(Duration::from_millis(1100)).await;
        model.release.add_permits(1);
        let second = tokio::time::timeout(Duration::from_secs(15),receive.recv()).await.unwrap().unwrap();
        assert!(second["input"].to_string().contains("event-wakeup-source-fact"));
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let notification = notifications.recv().await.unwrap();
                if notification["method"] == "turn/completed" { break; }
            }
        }).await.unwrap();
        let outcome=tokio::time::timeout(Duration::from_secs(15),run).await.unwrap().unwrap().unwrap();
        assert!(matches!(outcome.outcome,crate::runner::ExecutionOutcome::Completed { .. }));
        assert_eq!(*phases.lock().unwrap(),if recover_injection { vec!["injected","activation_requested","activated"] } else { vec!["injection_requested","injected","activation_requested","activated"] });
        assert_eq!(starts.lock().unwrap().len(),1,"the actual Runner must attach to one native Goal turn");
        assert_eq!(starts.lock().unwrap()[0].0,thread);
        let after = client.request("thread/goal/get",json!({"threadId":thread})).await.unwrap();
        assert_eq!(after["goal"]["status"],"complete");
        assert_eq!(after["goal"]["createdAt"],before["goal"]["createdAt"]);
        assert_eq!(after["goal"]["tokenBudget"],before["goal"]["tokenBudget"]);
        assert!(after["goal"]["timeUsedSeconds"].as_u64().unwrap() >= 1);
        let history = client.request("thread/read",json!({"threadId":thread,"includeTurns":true})).await.unwrap();
        let rollout = std::fs::read_to_string(history["thread"]["path"].as_str().unwrap()).unwrap();
        let rows: Vec<Value> = rollout.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows.iter().filter(|row|row["type"]=="response_item" && row["payload"]["id"]==item["id"]).count(),1);
        assert_eq!(rows.iter().filter(|row|row["type"]=="event_msg" && row["payload"]["type"]=="task_started").count(),1,"activation must start exactly one native turn");
        let receipt = crate::agents::codex::event_receipt::read(&home,Path::new(history["thread"]["path"].as_str().unwrap()),thread,&item).unwrap();
        assert!(receipt.injected && receipt.activated && receipt.completed);
        assert!(receipt.turn_id.is_some());
        assert_eq!(model.count.load(std::sync::atomic::Ordering::SeqCst),2);
        client.request("thread/goal/set",json!({"threadId":thread,"status":"blocked"})).await.unwrap();
        let mut recovered = crate::agents::EventGoalAdmission::new(thread.into(),crate::runtime_work::normalize_runtime_goal_timestamps(before["goal"].clone()),"test-operation".into(),prompt.clone(),Some("activation_requested".into()),Arc::new(tokio::sync::Mutex::new(())).lock_owned().await,Box::new(|_|panic!("an already started event must not be activated again")));
        assert!(recovered.activate_for_test(&client,&home).await.is_err(),"losing the activation ACK must not repeat an event after the Goal blocks again");
        assert_eq!(model.count.load(std::sync::atomic::Ordering::SeqCst),2);
    }).catch_unwind().await;
    client.restart().await;
    server.abort();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
