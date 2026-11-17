use super::super::{
    child::CodexAppServerChild, debug_stdout::CodexStdout, json_rpc::JsonRpcConnection,
    CodexAppServerClient, CodexRpcOrigin, CodexRunState,
};
use super::*;

async fn fixture(
    ready: bool,
) -> (
    CodexAppServerClient,
    JsonRpcConnection,
    CodexAppServerChild,
    tempfile::TempDir,
) {
    let root = tempfile::tempdir().unwrap();
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .args([
            "-c",
            r#"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$WEWORK_OWNER_RPC_CALL_LOG"
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"test/bootstrap"'*) printf '{"id":%s,"result":{"ready":true}}\n' "$id" ;;
    *'"method":"test/hold"'*) held="$id" ;;
    *) case "$line" in
         *'"requestCollision":true'*) printf '{"id":%s,"method":"item/commandExecution/requestApproval","params":{}}\n' "$id" ;;
       esac
       printf '{"id":%s,"result":{"value":"owned"}}\n' "$id"
       printf '{"id":%s,"result":{"internal":true}}\n' "$held" ;;
  esac
done
"#,
        ])
        .env("WEWORK_OWNER_RPC_CALL_LOG", root.path().join("calls.jsonl"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    super::super::configure_codex_app_server_process_group(&mut command);
    let mut child = CodexAppServerChild::from(command.spawn().unwrap());
    let mut client = CodexAppServerClient::new("isolated-rpc-must-not-spawn-another-process");
    client.state = Arc::new(tokio::sync::Mutex::new(Default::default()));
    let registry = client.state.lock().await.isolated_rpc.clone();
    let (owner, requests) = registry.owner();
    owner.bind("thread").unwrap();
    child.hold_rpc_owner(owner.clone());
    let mut rpc = JsonRpcConnection::new(
        child.stdin.take().unwrap(),
        CodexStdout::new(child.stdout.take().unwrap(), None),
        1,
        CodexRpcOrigin::Dedicated(None),
    )
    .with_isolated_owner(owner, requests);
    if ready {
        rpc.activate_isolated_thread("thread").unwrap();
    }
    (client, rpc, child, root)
}

#[tokio::test]
async fn source_responses_are_multiplexed_without_consuming_the_model_response() {
    let (client, mut rpc, mut child, root) = fixture(true).await;
    let mut state = CodexRunState::default();
    let (model, source) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(
            rpc.request("test/hold", serde_json::json!({}), &mut state),
            client.request("thread/read", serde_json::json!({"threadId":"thread"})),
        )
    })
    .await
    .unwrap();
    assert_eq!(model.unwrap()["internal"], true);
    assert_eq!(source.unwrap()["value"], "owned");
    assert!(client.state.lock().await.process.is_none());
    let calls = std::fs::read_to_string(root.path().join("calls.jsonl")).unwrap();
    assert_eq!(calls.lines().count(), 2);
    assert!(!calls.contains("thread/resume"));
    child.kill().await.unwrap();
}

#[tokio::test]
async fn cancelled_queued_tool_calls_are_not_dispatched_and_live_calls_run_once() {
    let (client, mut rpc, mut child, root) = fixture(true).await;
    let owner = client
        .state
        .lock()
        .await
        .isolated_rpc
        .get("thread")
        .unwrap();
    let cancelled = owner
        .start_request("mcpServer/tool/call", serde_json::json!({"cancelled":true}))
        .await
        .unwrap();
    drop(cancelled);
    let mut state = CodexRunState::default();
    let (model, tool) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(
            rpc.request("test/hold", serde_json::json!({}), &mut state),
            client.call_mcp_app_tool(serde_json::json!({"threadId":"thread","tool":"permitted"})),
        )
    })
    .await
    .unwrap();
    assert!(model.is_ok());
    assert_eq!(tool.unwrap()["value"], "owned");
    assert!(client.state.lock().await.process.is_none());
    let calls = std::fs::read_to_string(root.path().join("calls.jsonl")).unwrap();
    assert_eq!(calls.lines().count(), 2);
    assert_eq!(calls.matches("mcpServer/tool/call").count(), 1);
    assert!(!calls.contains("cancelled"));
    child.kill().await.unwrap();
}

#[tokio::test]
async fn stopping_owner_does_not_start_a_shared_process_or_replay_a_tool_call() {
    let (client, rpc, mut child, root) = fixture(true).await;
    drop(rpc);
    let result = client
        .call_mcp_app_tool(serde_json::json!({"threadId":"thread","tool":"permitted"}))
        .await;
    assert!(matches!(
        result,
        Err(super::super::CodexAppToolError::NotDispatched(_))
    ));
    let read = client.request("thread/read", serde_json::json!({"threadId":"thread"}));
    tokio::pin!(read);
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    assert!(client.state.lock().await.process.is_none());
    assert!(!root.path().join("calls.jsonl").exists());
    child.kill().await.unwrap();
    drop(child);
    // Only after native reaping may the read resolve through the shared path.
    // This fixture deliberately has no shared executable.
    let error = read.await.unwrap_err();
    assert!(!error.contains("owning isolated app-server"), "{error}");
}

#[tokio::test]
async fn waiting_for_input_services_source_reads_and_preserves_native_messages() {
    let (client, mut rpc, mut child, _) = fixture(true).await;
    let id = rpc
        .send_request("test/hold", serde_json::json!({}))
        .await
        .unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        rpc.while_waiting_for_input(
            client.request("thread/read", serde_json::json!({"threadId":"thread"})),
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(result["value"], "owned");
    let model = rpc.read_message().await.unwrap();
    assert_eq!(model["id"], id);
    assert_eq!(model["result"]["internal"], true);
    assert!(client.state.lock().await.process.is_none());
    child.kill().await.unwrap();
}

#[tokio::test]
async fn identical_thread_ids_in_different_homes_have_independent_owners() {
    let root = tempfile::tempdir().unwrap();
    let base = CodexAppServerClient::new("isolated-home-must-not-spawn-a-process");
    let first = base.for_home(root.path().join("one")).unwrap();
    let second = base.for_home(root.path().join("two")).unwrap();
    let (first_owner, mut first_requests) = first.state.lock().await.isolated_rpc.owner();
    let (second_owner, mut second_requests) = second.state.lock().await.isolated_rpc.owner();
    first_owner.bind("thread").unwrap();
    second_owner.bind("thread").unwrap();
    let (one, two, ()) = tokio::join!(
        first.request("thread/read", serde_json::json!({"threadId":"thread"})),
        second.request("thread/read", serde_json::json!({"threadId":"thread"})),
        async {
            first_requests
                .recv()
                .await
                .unwrap()
                .reply
                .send(Ok(serde_json::json!({"home":"one"})))
                .unwrap();
            second_requests
                .recv()
                .await
                .unwrap()
                .reply
                .send(Ok(serde_json::json!({"home":"two"})))
                .unwrap();
        },
    );
    assert_eq!(one.unwrap()["home"], "one");
    assert_eq!(two.unwrap()["home"], "two");
    assert!(base.state.lock().await.isolated_rpc.get("thread").is_none());
}

#[tokio::test]
async fn source_reads_wait_until_native_thread_restoration_is_complete() {
    let (client, mut rpc, mut child, root) = fixture(false).await;
    let mut state = CodexRunState::default();
    let (model, source) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(
            async {
                rpc.request("test/bootstrap", serde_json::json!({}), &mut state)
                    .await
                    .unwrap();
                let calls = std::fs::read_to_string(root.path().join("calls.jsonl")).unwrap();
                assert_eq!(calls.lines().count(), 1);
                assert!(!calls.contains("thread/read"));
                rpc.activate_isolated_thread("thread").unwrap();
                rpc.request("test/hold", serde_json::json!({}), &mut state)
                    .await
            },
            client.request("thread/read", serde_json::json!({"threadId":"thread"})),
        )
    })
    .await
    .unwrap();
    assert_eq!(model.unwrap()["internal"], true);
    assert_eq!(source.unwrap()["value"], "owned");
    child.kill().await.unwrap();
}

#[tokio::test]
async fn native_approval_ids_cannot_be_consumed_as_source_responses() {
    let (client, mut rpc, mut child, _) = fixture(true).await;
    let id = rpc
        .send_request("test/hold", serde_json::json!({}))
        .await
        .unwrap();
    let (model, source) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(
            async {
                let approval = rpc.read_message().await.unwrap();
                assert_eq!(approval["method"], "item/commandExecution/requestApproval");
                assert_eq!(approval["id"], id + 1);
                rpc.read_message().await
            },
            client.request(
                "thread/read",
                serde_json::json!({"threadId":"thread","requestCollision":true})
            ),
        )
    })
    .await
    .unwrap();
    assert_eq!(model.unwrap()["id"], id);
    assert_eq!(source.unwrap()["value"], "owned");
    child.kill().await.unwrap();
}
