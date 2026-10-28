use super::*;
use crate::{
    protocol::ExecutionRequest, runtime_work::RuntimeWorkRpcHandler,
    workbench_control::ControlContext,
};

#[tokio::test]
async fn control_http_binds_every_request_and_delete_to_its_context_and_surface() {
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let old = std::env::var_os("WEGENT_EXECUTOR_HOME");
    std::env::set_var("WEGENT_EXECUTOR_HOME", root.path());
    std::fs::create_dir_all(root.path().join("runtime-work")).unwrap();
    std::fs::write(root.path().join("runtime-work/index.json"), json!({"version":1,"tasks":{"caller":{
        "local_task_id":"caller","workspace_path":"/tmp","title":"caller","runtime":"codex","status":"active",
        "running":false,"continuable":true,"created_at":1,"updated_at":1,"runtime_handle":{},"parent":null
    }},"workspaces":{}}).to_string()).unwrap();
    let _handler = RuntimeWorkRpcHandler::new("http-control-device", "/bin/false");
    let mut request = ExecutionRequest::default();
    request
        .extra
        .insert("runtimeDeviceId".into(), json!("http-control-device"));
    request
        .extra
        .insert("runtimeLocalTaskId".into(), json!("caller"));
    let endpoint = ensure_space_mcp_http_endpoint().await.unwrap();
    let context = SpaceMcpRequestContext::control(ControlContext::from_request(&request).unwrap());
    let first = register_space_mcp_context(context.clone()).unwrap();
    let second = register_space_mcp_context(context).unwrap();
    let client = reqwest::Client::new();
    let url = endpoint.url.replace("/mcp", "/control/mcp");
    let init = client
        .post(&url)
        .bearer_auth(&endpoint.token)
        .header(CONTEXT_HANDLE_HEADER, &first.context_handle)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(init.status(), StatusCode::OK);
    let session = init.headers()[MCP_SESSION_ID_HEADER]
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        init.json::<Value>().await.unwrap()["result"]["serverInfo"]["name"],
        "wework_control"
    );
    let body = json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}});
    for handle in [None, Some(second.context_handle.as_str())] {
        let mut call = client
            .post(&url)
            .bearer_auth(&endpoint.token)
            .header(MCP_SESSION_ID_HEADER, &session)
            .json(&body);
        if let Some(handle) = handle {
            call = call.header(CONTEXT_HANDLE_HEADER, handle);
        }
        assert_eq!(
            call.send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let tools = client
        .post(&url)
        .bearer_auth(&endpoint.token)
        .header(MCP_SESSION_ID_HEADER, &session)
        .header(CONTEXT_HANDLE_HEADER, &first.context_handle)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "continue_conversation"));
    assert!(!tools
        .iter()
        .any(|tool| tool["name"] == "submit_workflow_plan"));
    let called = client.post(&url).bearer_auth(&endpoint.token).header(MCP_SESSION_ID_HEADER, &session)
        .header(CONTEXT_HANDLE_HEADER, &first.context_handle)
        .json(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_current_context","arguments":{}}}))
        .send().await.unwrap().json::<Value>().await.unwrap();
    assert_eq!(
        called["result"]["structuredContent"]["device_id"],
        "http-control-device"
    );
    for path in [
        &endpoint.url,
        &endpoint.url.replace("/mcp", "/notifications/mcp"),
        &endpoint.url.replace("/mcp", "/stand-in/mcp"),
    ] {
        assert_eq!(
            client
                .post(path)
                .bearer_auth(&endpoint.token)
                .header(MCP_SESSION_ID_HEADER, &session)
                .header(CONTEXT_HANDLE_HEADER, &first.context_handle)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .delete(path)
                .bearer_auth(&endpoint.token)
                .header(MCP_SESSION_ID_HEADER, &session)
                .header(CONTEXT_HANDLE_HEADER, &first.context_handle)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        client
            .delete(&url)
            .bearer_auth(&endpoint.token)
            .header(MCP_SESSION_ID_HEADER, &session)
            .header(CONTEXT_HANDLE_HEADER, &second.context_handle)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    request.extra.insert(
        "origin".into(),
        json!({"type":"stand_in_identity","userId":7,"deviceId":"http-control-device","askBeforeAct":true}),
    );
    let stand_in = super::super::mcp::stand_in_mcp_client_config(&request)
        .unwrap()
        .unwrap();
    let stand_in_context = &stand_in.headers["X-Wework-Mcp-Context"];
    let init = client
        .post(&stand_in.url)
        .bearer_auth(&endpoint.token)
        .header(CONTEXT_HANDLE_HEADER, stand_in_context)
        .json(&json!({"jsonrpc":"2.0","id":4,"method":"initialize","params":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(init.status(), StatusCode::OK);
    let stand_in_session = init.headers()[MCP_SESSION_ID_HEADER]
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        init.json::<Value>().await.unwrap()["result"]["serverInfo"]["name"],
        "wework_stand_in"
    );
    assert_eq!(
        client
            .delete(&url)
            .bearer_auth(&endpoint.token)
            .header(MCP_SESSION_ID_HEADER, &stand_in_session)
            .header(CONTEXT_HANDLE_HEADER, stand_in_context)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .delete(&stand_in.url)
            .bearer_auth(&endpoint.token)
            .header(MCP_SESSION_ID_HEADER, &stand_in_session)
            .header(CONTEXT_HANDLE_HEADER, stand_in_context)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    {
        let running = running_endpoint().lock().unwrap();
        running
            .as_ref()
            .unwrap()
            .contexts
            .lock()
            .unwrap()
            .get_mut(&first.context_handle)
            .unwrap()
            .expires_at = Instant::now();
    }
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&endpoint.token)
            .header(MCP_SESSION_ID_HEADER, &session)
            .header(CONTEXT_HANDLE_HEADER, &first.context_handle)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    match old {
        Some(value) => std::env::set_var("WEGENT_EXECUTOR_HOME", value),
        None => std::env::remove_var("WEGENT_EXECUTOR_HOME"),
    }
}
