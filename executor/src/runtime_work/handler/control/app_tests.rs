use super::tests::{context, seed, EnvGuard};
use super::*;
use crate::task_runtime::mcp::{handle_request_with_context, SpaceMcpRequestContext};
use crate::task_runtime::{LocalTaskStore, TaskRuntime};

async fn rpc(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    method: &str,
    params: Value,
) -> Value {
    handle_request_with_context(
        runtime,
        &json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}),
        context,
    )
    .await
    .unwrap()
}

async fn tool(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    args: Value,
) -> Value {
    let response = rpc(
        runtime,
        context,
        "tools/call",
        json!({"name":name,"arguments":args}),
    )
    .await;
    assert_eq!(response["result"]["isError"], false, "{response}");
    if name != "present_interaction" && name != "invoke_capability" {
        assert!(
            response["result"].pointer("/_meta/ui").is_none(),
            "Direct tool execution unexpectedly created an interaction: {name}"
        );
    }
    let value = response["result"]["structuredContent"].clone();
    crate::workbench_control::assert_output_contract(name, &value);
    value
}

#[test]
fn every_interaction_capability_shares_discovery_and_business_contracts() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _sidebar_home = EnvGuard::set("CODEX_HOME", root.path().to_str().unwrap());
            let _codex_home = EnvGuard::set("WEGENT_CODEX_HOME", root.path().to_str().unwrap());
            let _claude_home = EnvGuard::set("WEGENT_CLAUDE_HOME", root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            seed(&handler, "caller");
            let mut target = seed(&handler, "candidate");
            target.thread_id = None;
            handler.store.upsert_task(target);
            let runtime =
                TaskRuntime::new(LocalTaskStore::open(root.path().join("contracts.sqlite")).unwrap())
                    .unwrap();
            let context = SpaceMcpRequestContext::control(context("caller"));
            let discovered = tool(&runtime, &context, "list_capabilities", json!({})).await;
            let definitions = discovered["capabilities"].as_array().unwrap();
            let names: Vec<_> = definitions
                .iter()
                .filter(|definition| definition["name"] != "present_interaction")
                .map(|definition| definition["name"].clone())
                .collect();
            let opened = rpc(&runtime, &context, "tools/call", json!({"name":"present_interaction","arguments":{
                "title":"All Wework capabilities","html":"<section>Generated interaction</section>","tools":names
            }})).await;
            let bound = opened["result"]["_meta"]["ui"]["tools"].as_array().unwrap();
            assert_eq!(bound.len(), definitions.len() - 1);
            for definition in definitions {
                let name = definition["name"].as_str().unwrap();
                let described = tool(
                    &runtime,
                    &context,
                    "describe_capability",
                    json!({"name":name}),
                )
                .await;
                assert_eq!(&described, definition);
                assert!(
                    definition["outputSchema"]["properties"].is_object(),
                    "{name} lacks public result fields"
                );
                assert!(
                    !definition["outputSchema"]["required"]
                        .as_array()
                        .unwrap()
                        .is_empty(),
                    "{name} lacks a required result"
                );
                if name != "present_interaction" {
                    assert_eq!(
                        bound.iter().find(|tool| tool["name"] == name).unwrap(),
                        definition
                    );
                }
            }
            let current = tool(&runtime, &context, "get_current_context", json!({})).await;
            assert_eq!(current["device_id"], "control-test-device");
            let address = json!({"conversation_id":crate::workbench_control::conversation_id("control-test-device","candidate")});
            let renamed = tool(
                &runtime,
                &context,
                "rename_conversation",
                json!({"conversation_id":address["conversation_id"],"title":"Selectable candidate"}),
            )
            .await;
            assert_eq!(renamed["accepted"], true);
            let listed = tool(
                &runtime,
                &context,
                "list_conversations",
                json!({"scope":"current_device","include_archived":true}),
            )
            .await;
            assert!(
                listed["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["title"] == "Selectable candidate"),
                "{listed}"
            );
            let fetched = tool(&runtime, &context, "get_conversation", address.clone()).await;
            assert_eq!(fetched["title"], "Selectable candidate");
            let bound_pr = tool(&runtime, &context, "bind_change_request", json!({"conversation_id":address["conversation_id"],"url":"https://github.com/acme/project/pull/42"})).await;
            assert_eq!(bound_pr["conversation_id"], address["conversation_id"]);
            let found = tool(
                &runtime,
                &context,
                "find_conversations_by_change_request",
                json!({"url":"https://github.com/acme/project/pull/42"}),
            )
            .await;
            assert_eq!(found["resolution"], "unique");
            for name in [
                "get_runtime_settings",
                "get_runtime_capacity",
                "list_models",
                "get_conversation_creation_options",
            ] {
                tool(&runtime, &context, name, json!({})).await;
            }
            let supervisor = tool(
                &runtime,
                &context,
                "get_conversation_supervisor",
                address.clone(),
            )
            .await;
            assert!(supervisor["supervisor"].is_null());
            tool(
                &runtime,
                &context,
                "clear_conversation_supervisor",
                address.clone(),
            )
            .await;
            let mut target = handler.store.get_task("candidate").unwrap();
            target.runtime = "claude_code".into();
            handler.store.upsert_task(target);
            let goal = tool(&runtime, &context, "get_conversation_goal", address.clone()).await;
            assert!(goal["goal"].is_null());
            tool(&runtime, &context, "clear_conversation_goal", address).await;
            let reloaded = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            assert_eq!(
                reloaded.store.get_task("candidate").unwrap().title,
                "Selectable candidate"
            );
        });
}

#[test]
fn generated_interaction_uses_existing_operations_and_real_persistence() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            seed(&handler, "app-caller");
            let runtime =
                TaskRuntime::new(LocalTaskStore::open(root.path().join("app.sqlite")).unwrap()).unwrap();
            let context = SpaceMcpRequestContext::control(context("app-caller"));
            let initialized = rpc(&runtime, &context, "initialize", json!({})).await;
            assert!(initialized["result"]["capabilities"]["resources"].is_object());
            assert_eq!(
                initialized["result"]["instructions"],
                crate::workbench_control::INSTRUCTIONS
            );
            let resources = rpc(&runtime, &context, "resources/list", json!({})).await;
            let uri = resources["result"]["resources"][0]["uri"].as_str().unwrap();
            let resource = rpc(&runtime, &context, "resources/read", json!({"uri":uri})).await;
            assert_eq!(
                resource["result"]["contents"][0]["mimeType"],
                "text/html;profile=mcp-app"
            );
            let tools = rpc(&runtime, &context, "tools/list", json!({})).await;
            let list = tools["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == "present_interaction")
                .unwrap();
            assert_eq!(list["_meta"]["ui"]["resourceUri"], uri);
            assert_eq!(list["annotations"]["readOnlyHint"], true);
            let html = "<section id=generated><button data-testid=create>Create</button><script>const api = window.wework</script></section>";
            let opened = rpc(&runtime, &context, "tools/call", json!({"name":"present_interaction","arguments":{
                "title":"Generated workflow","html":html,"tools":["create_automation","list_conversations"]
            }})).await;
            assert_eq!(opened["result"]["isError"], false);
            assert_eq!(
                opened["result"]["structuredContent"],
                json!({"title":"Generated workflow"})
            );
            assert!(!opened["result"]["content"].to_string().contains("<section"));
            assert_eq!(opened["result"]["_meta"]["ui"]["html"], html);
            let bound = opened["result"]["_meta"]["ui"]["tools"].as_array().unwrap();
            assert_eq!(bound.len(), 2);
            assert!(bound
                .iter()
                .any(|tool| tool["name"] == "list_conversations"));
            let wrapped = rpc(&runtime, &context, "tools/call", json!({"name":"invoke_capability","arguments":{
                "name":"present_interaction","arguments":{"title":"Navigation","html":"<button>Open</button>","tools":[]}
            }})).await;
            assert_eq!(wrapped["result"]["isError"], false);
            assert_eq!(wrapped["result"]["_meta"]["ui"]["resourceUri"], uri);
            assert!(
                tool(&runtime, &context, "list_automations", json!({})).await["items"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            let invalid_binding = rpc(
                &runtime,
                &context,
                "tools/call",
                json!({"name":"present_interaction","arguments":{"title":"Invalid","html":html,"tools":["invented_tool"]}}),
            )
            .await;
            assert_eq!(invalid_binding["result"]["isError"], true);
            let created = tool(&runtime, &context, "create_automation", json!({"name":"App schedule","prompt":"Check my work","schedule":{"type":"interval","value":2,"unit":"hours"},"timezone":"Asia/Shanghai","enabled":false})).await;
            let definitions = tools["result"]["tools"].as_array().unwrap();
            let create_schema = &definitions
                .iter()
                .find(|tool| tool["name"] == "create_automation")
                .unwrap()["outputSchema"];
            assert_eq!(create_schema["required"], json!(["automation"]));
            for field in create_schema["properties"]["automation"]["required"]
                .as_array()
                .unwrap()
            {
                assert!(
                    !created["automation"][field.as_str().unwrap()].is_null(),
                    "Missing declared result field: {field}"
                );
            }
            let id = created["automation"]["id"].as_str().unwrap();
            let persisted = handler.automation_store.get(id).unwrap();
            assert_eq!(persisted.task_request["sourceTaskId"], "app-caller");
            assert!(!created.to_string().contains("private-secret"));
            assert!(created["automation"].get("taskPayload").is_none());
            let listed = tool(&runtime, &context, "list_automations", json!({})).await;
            let list_schema = &definitions
                .iter()
                .find(|tool| tool["name"] == "list_automations")
                .unwrap()["outputSchema"];
            assert_eq!(list_schema["required"], json!(["items"]));
            assert_eq!(
                list_schema["properties"]["items"]["items"],
                create_schema["properties"]["automation"]
            );
            assert_eq!(listed["items"][0]["id"], id);
            let updated = tool(
                &runtime,
                &context,
                "update_automation",
                json!({"automation_id":id,"version":1,"name":"Edited in app"}),
            )
            .await;
            assert_eq!(updated["automation"]["version"], 2);
            let stale = rpc(&runtime, &context, "tools/call", json!({"name":"update_automation","arguments":{"automation_id":id,"version":1,"name":"Stale"}})).await;
            assert_eq!(stale["result"]["isError"], true);
            assert!(stale["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("conflict"));
            let enabled = tool(
                &runtime,
                &context,
                "toggle_automation",
                json!({"automation_id":id,"enabled":true}),
            )
            .await;
            assert_eq!(enabled["automation"]["enabled"], true);
            assert!(enabled["automation"]["nextRunAt"].is_string());
            let reloaded = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            assert_eq!(
                reloaded.automation_store.get(id).unwrap().name,
                "Edited in app"
            );
            let runs = tool(
                &runtime,
                &context,
                "list_automation_runs",
                json!({"automation_id":id}),
            )
            .await;
            assert_eq!(runs["items"], json!([]));
            let deleted = tool(
                &runtime,
                &context,
                "delete_automation",
                json!({"automation_id":id}),
            )
            .await;
            assert_eq!(deleted["deleted"], true);
            assert!(reloaded.automation_store.get(id).is_none());
        });
}

#[tokio::test]
async fn generated_interaction_resources_do_not_cross_mcp_surfaces_or_accept_arbitrary_paths() {
    let root = tempfile::tempdir().unwrap();
    let runtime =
        TaskRuntime::new(LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap()).unwrap();
    let personal = SpaceMcpRequestContext::control(context("source"));
    for uri in [
        "file:///etc/passwd",
        "ui://wework-control/../interaction.html",
        "ui://another/app.html",
    ] {
        let response = rpc(&runtime, &personal, "resources/read", json!({"uri":uri})).await;
        assert_eq!(response["error"]["code"], -32602);
    }
    let project = SpaceMcpRequestContext::default();
    let initialized = rpc(&runtime, &project, "initialize", json!({})).await;
    assert!(initialized["result"]["capabilities"]
        .get("resources")
        .is_none());
    assert!(initialized["result"].get("instructions").is_none());
    assert_eq!(
        rpc(&runtime, &project, "resources/list", json!({})).await["error"]["code"],
        -32601
    );
}

#[cfg(unix)]
#[test]
fn generated_interaction_restore_uses_native_unarchive_and_preserves_failures() {
    use std::os::unix::fs::PermissionsExt;

    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _codex_home = EnvGuard::set("WEGENT_CODEX_HOME", root.path().to_str().unwrap());
            let binary = root.path().join("codex-restore.sh");
            let log = root.path().join("requests.jsonl");
            fs::write(&binary, crate::test_env::with_codex_bundled_catalog(&format!(r#"#!/bin/sh
        while IFS= read -r line; do
          printf '%s\n' "$line" >> '{}'
          id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
          [ -n "$id" ] || continue
          case "$line" in
            *'"method":"thread/unarchive"'*'"threadId":"thread-rejected"'*)
              printf '{{"id":%s,"error":{{"code":-32600,"message":"Native restoration failed"}}}}\n' "$id" ;;
            *) printf '{{"id":%s,"result":{{}}}}\n' "$id" ;;
          esac
        done
        "#, log.display()))).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
            let (event_tx, mut event_rx) = broadcast::channel(8);
            let handler = RuntimeWorkRpcHandler::with_event_sender(
                "control-test-device",
                binary.to_str().unwrap(),
                event_tx,
            );
            seed(&handler, "caller");
            for task in ["archived", "rejected", "restricted"] {
                let mut link = seed(&handler, task);
                link.workspace_path = root.path().display().to_string();
                link.status = "archived".into();
                link.continuable = false;
                if task == "restricted" {
                    link.runtime_handle["origin"] = json!({"dispatchRole":"executor"});
                }
                handler.store.upsert_task(link);
            }
            let context = context("caller");
            let args = |device: &str, task: &str| json!({"conversation_id":crate::workbench_control::conversation_id(device,task)});
            let restored = crate::workbench_control::call(
                &context,
                "unarchive_conversation",
                args("control-test-device", "archived"),
            )
            .await;
            assert_eq!(restored["isError"], false, "{restored}");
            crate::workbench_control::assert_output_contract(
                "unarchive_conversation",
                &restored["structuredContent"],
            );
            assert_eq!(restored["structuredContent"]["accepted"], true);
            let changed = std::iter::from_fn(|| event_rx.try_recv().ok())
                .find(|event| event["event"] == "runtime.work.changed")
                .unwrap();
            assert_eq!(changed["payload"]["taskId"], "archived");
            assert_eq!(changed["payload"]["data"]["archived"], false);
            let reloaded = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let link = reloaded.store.get_task("archived").unwrap();
            assert_eq!(link.status, "active");
            assert!(link.continuable);
            assert_eq!(link.thread_id.as_deref(), Some("thread-archived"));

            let failed = handler
                .control_operation(
                    &context,
                    "unarchive_conversation",
                    args("control-test-device", "rejected"),
                )
                .await
                .unwrap();
            assert_eq!(failed["accepted"], false);
            assert!(failed.to_string().contains("Native restoration failed"));
            assert_eq!(
                handler.store.get_task("rejected").unwrap().status,
                "archived"
            );
            assert!(!std::iter::from_fn(|| event_rx.try_recv().ok())
                .any(|event| event["event"] == "runtime.work.changed"));
            for (device, task, code) in [
                ("control-test-device", "restricted", "permission_denied"),
                ("other-device", "archived", "wrong_device"),
            ] {
                let error = handler
                    .control_operation(&context, "unarchive_conversation", args(device, task))
                    .await
                    .unwrap_err();
                assert_eq!(error.code, code);
            }
            handler.codex_app_server.restart().await;
            let calls: Vec<Value> = fs::read_to_string(log)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let mutations: Vec<_> = calls
                .iter()
                .filter(|call| call["method"] == "thread/unarchive")
                .collect();
            assert_eq!(mutations.len(), 2);
            assert_eq!(mutations[0]["params"]["threadId"], "thread-archived");
            assert_eq!(mutations[1]["params"]["threadId"], "thread-rejected");
            assert!(!calls.iter().any(|call| matches!(
                call["method"].as_str(),
                Some("thread/resume" | "turn/start")
            )));
        });
}
