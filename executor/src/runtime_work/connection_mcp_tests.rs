use super::*;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

type RpcReply = (&'static str, Result<Value, AppIpcError>);

#[derive(Clone)]
struct FakeRpc {
    replies: Arc<Mutex<VecDeque<RpcReply>>>,
    calls: Arc<Mutex<Vec<(&'static str, Value)>>>,
}

impl FakeRpc {
    fn new(replies: Vec<RpcReply>) -> Self {
        Self {
            replies: Arc::new(Mutex::new(replies.into())),
            calls: Arc::default(),
        }
    }
    fn complete(&self) {
        assert!(self.replies.lock().unwrap().is_empty());
    }
}

impl McpRpc for FakeRpc {
    fn request(&self, method: &'static str, params: Value) -> Reply {
        self.calls.lock().unwrap().push((method, params));
        let (expected, response) = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("Unexpected RPC");
        assert_eq!(method, expected);
        Box::pin(async move { response })
    }
}

fn payload() -> Value {
    json!({"source":{"marketplaceId":"company","pluginId":"mail@company"},
        "expectedVersion":"1.2.0","operation":"callTool","server":"mail","tool":"read","arguments":{"id":"message-1"}})
}
fn installed() -> Value {
    json!({"marketplaces":[{"name":"company","path":"/market/company","plugins":[{
        "id":"mail@company","name":"mail","installed":true,"enabled":true,"localVersion":"1.2.0"}]}]})
}
fn detail() -> Value {
    json!({"plugin":{"marketplaceName":"company","summary":{"id":"mail@company"},"apps":[{"id":"connector_mail"}]}})
}
fn tool() -> Value {
    json!({"name":"read","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true,"destructiveHint":false}})
}
fn page() -> Value {
    json!({"data":[{"name":"mail","pluginId":"mail@company","tools":{"read":tool()},"runtimeStatus":"connected"}],"nextCursor":null})
}
fn setup() -> Vec<(&'static str, Result<Value, AppIpcError>)> {
    vec![
        ("plugin/installed", Ok(installed())),
        ("plugin/read", Ok(detail())),
        ("thread/start", Ok(json!({"thread":{"id":"background-1"}}))),
    ]
}
fn cleanup() -> (&'static str, Result<Value, AppIpcError>) {
    ("thread/unsubscribe", Ok(json!({})))
}

#[tokio::test]
async fn connection_mcp_reads_existing_plugin_without_a_model_turn_and_preserves_the_result() {
    let response = json!({"content":[{"type":"text","text":"mail"}],"structuredContent":{"id":"message-1"},"isError":false,"_meta":{"opaque":"preserved"}});
    let mut steps = setup();
    steps.extend([
        ("mcpServerStatus/list", Ok(page())),
        ("plugin/installed", Ok(installed())),
        ("mcpServer/tool/call", Ok(response.clone())),
        cleanup(),
    ]);
    let client = FakeRpc::new(steps);
    assert_eq!(execute(&client, payload()).await.unwrap(), response);
    client.complete();
    let calls = client.calls.lock().unwrap();
    assert!(calls.iter().all(|(method, _)| *method != "turn/start"));
    let start = &calls
        .iter()
        .find(|(method, _)| *method == "thread/start")
        .unwrap()
        .1;
    assert_eq!(start["ephemeral"], true);
    assert_eq!(start["approvalPolicy"], "never");
    assert_eq!(start["sandbox"], "read-only");
    let call = &calls
        .iter()
        .find(|(method, _)| *method == "mcpServer/tool/call")
        .unwrap()
        .1;
    assert_eq!(call["threadId"], "background-1");
    assert_eq!(call["arguments"], payload()["arguments"]);
    assert!(call.get("_meta").is_none());
}

#[tokio::test]
async fn connection_mcp_discovery_paginates_and_filters_other_plugins_writes_and_unmarked_tools() {
    let mut first = page();
    first["nextCursor"] = json!("next");
    first["data"][0]["pluginId"] = json!("mail@other");
    let mut second = page();
    second["data"][0]["tools"]["write"] =
        json!({"name":"write","annotations":{"readOnlyHint":false}});
    second["data"][0]["tools"]["unknown"] = json!({"name":"unknown"});
    let mut steps = setup();
    steps.extend([
        ("mcpServerStatus/list", Ok(first)),
        ("mcpServerStatus/list", Ok(second)),
        cleanup(),
    ]);
    let client = FakeRpc::new(steps);
    let mut input = payload();
    input["operation"] = json!("listTools");
    let result = execute(&client, input).await.unwrap();
    assert_eq!(result["tools"].as_array().unwrap().len(), 1);
    assert_eq!(result["tools"][0]["name"], "read");
    client.complete();
    let calls = client.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| *method == "mcpServerStatus/list")
            .nth(1)
            .unwrap()
            .1["cursor"],
        "next"
    );
}

#[tokio::test]
async fn connection_mcp_denies_other_dependencies_disabled_plugins_and_version_changes() {
    for mode in ["market", "disabled", "version", "duplicate"] {
        let mut inventory = installed();
        match mode {
            "market" => inventory["marketplaces"][0]["name"] = json!("other"),
            "disabled" => inventory["marketplaces"][0]["plugins"][0]["enabled"] = json!(false),
            "version" => {
                inventory["marketplaces"][0]["plugins"][0]["localVersion"] = json!("1.3.0")
            }
            _ => {
                let plugin = inventory["marketplaces"][0]["plugins"][0].clone();
                inventory["marketplaces"][0]["plugins"]
                    .as_array_mut()
                    .unwrap()
                    .push(plugin);
            }
        }
        let client = FakeRpc::new(vec![("plugin/installed", Ok(inventory))]);
        assert_eq!(
            execute(&client, payload()).await.unwrap_err().code,
            "dependency_unavailable"
        );
        client.complete();
    }
    let mut changed = installed();
    changed["marketplaces"][0]["plugins"][0]["enabled"] = json!(false);
    let mut steps = setup();
    steps.extend([
        ("mcpServerStatus/list", Ok(page())),
        ("plugin/installed", Ok(changed)),
        cleanup(),
    ]);
    let client = FakeRpc::new(steps);
    assert_eq!(
        execute(&client, payload()).await.unwrap_err().code,
        "dependency_unavailable"
    );
    client.complete();
}

#[tokio::test]
async fn connection_mcp_failure_and_auth_interaction_release_threads_without_replaying_calls() {
    for code in [
        "connection_mcp_failed",
        "connection_interaction_required",
        "connection_mcp_timeout",
    ] {
        let mut steps = setup();
        steps.extend([
            ("mcpServerStatus/list", Ok(page())),
            ("plugin/installed", Ok(installed())),
            ("mcpServer/tool/call", Err(failure(code, "test failure"))),
            cleanup(),
        ]);
        let client = FakeRpc::new(steps);
        assert_eq!(execute(&client, payload()).await.unwrap_err().code, code);
        client.complete();
        assert_eq!(
            client
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| *method == "mcpServer/tool/call")
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn connection_mcp_rejects_write_tools_and_catalog_failures_with_cleanup() {
    for mode in [
        "write",
        "destructive",
        "foreign",
        "catalog",
        "auth",
        "cursor",
    ] {
        let mut catalog = page();
        match mode {
            "write" => {
                catalog["data"][0]["tools"]["read"]["annotations"]["readOnlyHint"] = json!(false)
            }
            "destructive" => {
                catalog["data"][0]["tools"]["read"]["annotations"]["destructiveHint"] = json!(true)
            }
            "foreign" => catalog["data"][0]["pluginId"] = json!("mail@other"),
            "catalog" => catalog["data"][0]["toolsError"] = json!("unavailable"),
            "auth" => catalog["data"][0]["runtimeStatus"] = json!("authenticationRequired"),
            _ => catalog["nextCursor"] = json!({"bad":"cursor"}),
        }
        let mut steps = setup();
        steps.extend([("mcpServerStatus/list", Ok(catalog)), cleanup()]);
        let client = FakeRpc::new(steps);
        let error = execute(&client, payload()).await.unwrap_err();
        assert!(matches!(
            error.code.as_str(),
            "connection_tool_denied" | "connection_mcp_catalog_failed" | "connection_auth_required"
        ));
        client.complete();
    }
}

#[test]
fn connection_mcp_hosted_apps_require_connector_identity_from_the_exact_plugin() {
    let server = json!({"name":"codex_apps","pluginId":null});
    let mut hosted = tool();
    hosted["_meta"] = json!({"connector_id":"connector_mail"});
    assert!(tool_belongs_to_dependency(
        &server,
        &hosted,
        &payload(),
        &detail()
    ));
    assert!(!tool_belongs_to_dependency(
        &json!({"name":"codex_apps","pluginId":"foreign@other"}),
        &hosted,
        &payload(),
        &detail()
    ));
    hosted["_meta"]["connector_id"] = json!("connector_other");
    assert!(!tool_belongs_to_dependency(
        &server,
        &hosted,
        &payload(),
        &detail()
    ));
    hosted.as_object_mut().unwrap().remove("_meta");
    assert!(!tool_belongs_to_dependency(
        &server,
        &hosted,
        &payload(),
        &detail()
    ));
    assert!(validate_detail(
        &json!({"plugin":{"summary":{"id":"mail@other"},"marketplaceName":"company"}}),
        &payload()
    )
    .is_err());
}

#[test]
fn connection_mcp_adapter_read_contract_supports_unannotated_legacy_tools_but_cannot_override_writes(
) {
    let server = json!({"name":"mail"});
    let mut legacy = json!({"name":"read"});
    let mut input = payload();
    input["readTools"] = json!([{"server":"mail","tool":"read"}]);
    assert!(!read_only(&server, &legacy, &payload()));
    assert!(read_only(&server, &legacy, &input));
    legacy["annotations"] = json!({"readOnlyHint":false});
    assert!(!read_only(&server, &legacy, &input));
    legacy["annotations"] = json!({"destructiveHint":true});
    assert!(!read_only(&server, &legacy, &input));
    input["readTools"][0]["server"] = json!("other");
    assert!(!read_only(&server, &json!({"name":"read"}), &input));
    let mut invalid = payload();
    invalid["operation"] = json!("turn/start");
    assert!(validate_request(&invalid).is_err());
    invalid = payload();
    invalid["arguments"] = json!("not an object");
    assert!(validate_request(&invalid).is_err());
}

#[tokio::test(start_paused = true)]
async fn connection_mcp_deadline_releases_the_thread() {
    struct SlowRpc(FakeRpc);
    impl McpRpc for SlowRpc {
        fn request(&self, method: &'static str, params: Value) -> Reply {
            if method == "mcpServerStatus/list" {
                return Box::pin(std::future::pending());
            }
            self.0.request(method, params)
        }
    }
    let mut steps = setup();
    steps.push(cleanup());
    let client = SlowRpc(FakeRpc::new(steps));
    assert_eq!(
        execute(&client, payload()).await.unwrap_err().code,
        "connection_mcp_timeout"
    );
    client.0.complete();
}

#[tokio::test]
async fn connection_mcp_cancelled_ipc_caller_does_not_abandon_thread_cleanup() {
    #[derive(Clone)]
    struct BlockRpc {
        inner: FakeRpc,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }
    impl McpRpc for BlockRpc {
        fn request(&self, method: &'static str, params: Value) -> Reply {
            if method == "mcpServer/tool/call" {
                let this = self.clone();
                return Box::pin(async move {
                    this.entered.notify_one();
                    this.release.notified().await;
                    Ok(json!({"content":[]}))
                });
            }
            self.inner.request(method, params)
        }
    }
    let mut steps = setup();
    steps.extend([
        ("mcpServerStatus/list", Ok(page())),
        ("plugin/installed", Ok(installed())),
        cleanup(),
    ]);
    let client = BlockRpc {
        inner: FakeRpc::new(steps),
        entered: Arc::default(),
        release: Arc::default(),
    };
    let worker = client.clone();
    let caller = tokio::spawn(async move { owned_request(worker, payload()).await });
    client.entered.notified().await;
    caller.abort();
    let _ = caller.await;
    client.release.notify_one();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if client
                .inner
                .calls
                .lock()
                .unwrap()
                .last()
                .is_some_and(|(method, _)| *method == "thread/unsubscribe")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    client.inner.complete();
}
