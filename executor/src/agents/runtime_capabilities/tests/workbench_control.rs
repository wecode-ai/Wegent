use super::*;
use crate::workbench_control::{ControlContext, ControlService};

struct Service;
impl ControlService for Service {
    fn call<'a>(
        &'a self,
        _: &'a ControlContext,
        _: &'a str,
        _: Value,
    ) -> futures_util::future::BoxFuture<'a, Result<Value, crate::local::app_ipc::AppIpcError>>
    {
        Box::pin(async { Ok(json!({})) })
    }
}

#[test]
fn managed_control_is_injected_for_personal_claude_runs_and_removed_for_delegation() {
    let mut request = ExecutionRequest::default();
    request
        .extra
        .insert("runtimeDeviceId".into(), json!("claude-control-injection"));
    request
        .extra
        .insert("runtimeLocalTaskId".into(), json!("caller"));
    crate::workbench_control::register("claude-control-injection", std::sync::Arc::new(Service));
    let mut servers = BTreeMap::from([(
        "wework_control".to_owned(),
        json!({"command":"untrusted-server"}),
    )]);
    inject_managed_wework_mcps(&request, &mut servers).unwrap();
    let server = &servers["wework_control"];
    assert_eq!(server["type"], "http");
    assert!(server["url"].as_str().unwrap().ends_with("/control/mcp"));
    assert!(server["headers"]["X-Wework-Mcp-Context"].as_str().is_some());
    assert!(!server.to_string().contains("caller"));
    assert!(!server.to_string().contains("untrusted-server"));
    request
        .extra
        .insert("origin".into(), json!({"dispatchRole":"executor"}));
    inject_managed_wework_mcps(&request, &mut servers).unwrap();
    assert!(!servers.contains_key("wework_control"));
}

#[test]
fn stand_in_keeps_its_managed_surface_without_personal_control() {
    for origin_type in ["stand_in_identity", "connection_work", "dingtalk_work"] {
        let request = ExecutionRequest {
            extra: serde_json::Map::from_iter([
                (
                    "runtimeDeviceId".into(),
                    json!("stand-in-control-isolation"),
                ),
                ("runtimeLocalTaskId".into(), json!("caller")),
                (
                    "origin".into(),
                    json!({"type":origin_type,"userId":7,"deviceId":"stand-in-control-isolation","workId":"work","askBeforeAct":true}),
                ),
            ]),
            ..Default::default()
        };
        let mut servers = BTreeMap::from([(
            "wework_control".to_owned(),
            json!({"command":"stale-personal-control"}),
        )]);
        inject_managed_wework_mcps(&request, &mut servers).unwrap();
        assert!(!servers.contains_key("wework_control"));
        assert!(servers.contains_key(crate::task_runtime::mcp::STAND_IN_MCP_SERVER_NAME));
    }
}

#[test]
fn user_mcp_definitions_cannot_override_the_managed_control_server() {
    let request = ExecutionRequest {
        mcp_servers: vec![
            json!({"name":"wework_control","command":"untrusted"}),
            json!({"name":"ordinary","command":"keep"}),
        ],
        ..Default::default()
    };
    let servers = collect_request_mcp_servers(&request);
    assert!(!servers.contains_key("wework_control"));
    assert!(servers.contains_key("ordinary"));
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("config.toml"),
        "[mcp_servers.wework_control]\nurl = 'https://stale.invalid/control'\n",
    )
    .unwrap();
    let mut config = Map::new();
    codex_mcp::prepare(home.path(), &request, &mut config).unwrap();
    assert!(!config.contains_key("mcp_servers.wework_control"));
    assert!(!std::fs::read_to_string(home.path().join("config.toml"))
        .unwrap()
        .contains("wework_control"));
}
