// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde_json::{json, Value};
use wegent_executor::{agents::extract_claude_options, protocol::ExecutionRequest};

#[test]
fn bot_mcp_servers_are_passed_through_as_named_dict() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{
            "mcp_servers": [
                {"name": "ghost-server", "type": "http", "url": "http://ghost.example.com/mcp"},
                {"name": "my-skill_skillServer", "type": "http", "url": "http://skill.example.com/mcp"}
            ]
        }]),
        ..ExecutionRequest::default()
    };

    let options = extract_claude_options(&request, &BTreeMap::new());

    assert_eq!(options.mcp_servers["ghost-server"]["type"], "http");
    assert_eq!(options.mcp_servers["my-skill_skillServer"]["type"], "http");
}

#[test]
fn no_mcp_servers_when_absent_or_bot_list_empty() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{"system_prompt": "You are helpful."}]),
        ..ExecutionRequest::default()
    };
    assert!(extract_claude_options(&request, &BTreeMap::new())
        .mcp_servers
        .is_empty());

    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([]),
        ..ExecutionRequest::default()
    };
    assert!(extract_claude_options(&request, &BTreeMap::new())
        .mcp_servers
        .is_empty());
}

#[test]
fn top_level_system_prompt_overrides_bot_prompt_and_pipeline_stage_prompt() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        system_prompt:
            "Current stage prompt.\n\n<wegent_runtime_guidance>Use files.</wegent_runtime_guidance>"
                .to_owned(),
        bot: json!([
            {"id": 2, "system_prompt": "First raw bot prompt."},
            {"id": 3, "system_prompt": "Second raw bot prompt."}
        ]),
        extra: serde_json::Map::from_iter([("collaboration_model".to_owned(), json!("pipeline"))]),
        ..ExecutionRequest::default()
    };

    let options = extract_claude_options(&request, &BTreeMap::new());

    assert_eq!(
        options.system_prompt.as_deref(),
        Some(request.system_prompt.as_str())
    );
}

#[test]
fn bot_system_prompt_is_fallback_when_request_prompt_absent() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{"system_prompt": "You are helpful."}]),
        ..ExecutionRequest::default()
    };

    let options = extract_claude_options(&request, &BTreeMap::new());

    assert_eq!(options.system_prompt.as_deref(), Some("You are helpful."));
}

#[test]
fn task_model_id_is_explicit_and_missing_model_keeps_default() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{"agent_config": {"env": {"model": "claude", "model_id": "deepseek-v4-pro"}}}]),
        ..ExecutionRequest::default()
    };
    assert_eq!(
        extract_claude_options(&request, &BTreeMap::new())
            .model
            .as_deref(),
        Some("deepseek-v4-pro")
    );

    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{"agent_config": {"env": {"model": "claude"}}}]),
        ..ExecutionRequest::default()
    };
    assert!(extract_claude_options(&request, &BTreeMap::new())
        .model
        .is_none());
}

#[test]
fn coordinate_mode_includes_member_bot_mcp_servers() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([
            {
                "name": "leader",
                "mcp_servers": [{"name": "leader-server", "type": "http", "url": "http://leader.example.com/mcp"}]
            },
            {
                "name": "dubhe_bot",
                "mcp_servers": [{"name": "dube-mcp", "type": "http", "url": "http://10.185.16.187:8121/mcp", "headers": {"Mcp-Proxy-User-Name": "wangyu29"}}]
            }
        ]),
        extra: serde_json::Map::from_iter([("mode".to_owned(), json!("coordinate"))]),
        ..ExecutionRequest::default()
    };

    let options = extract_claude_options(&request, &BTreeMap::new());

    assert!(options.mcp_servers.contains_key("leader-server"));
    assert_eq!(
        options.mcp_servers["dube-mcp"]["url"],
        "http://10.185.16.187:8121/mcp"
    );
}

#[test]
fn global_streamable_http_mcp_is_normalized_for_claude() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{"system_prompt": "You are helpful."}]),
        ..ExecutionRequest::default()
    };
    let global_mcps = BTreeMap::from([(
        "docs".to_owned(),
        json!({
            "server": {
                "type": "streamable-http",
                "url": "https://mcp.example.com/docs",
                "base_url": "https://mcp.example.com/docs",
                "headers": {"Authorization": "Bearer test"}
            }
        }),
    )]);

    let options = extract_claude_options(&request, &global_mcps);

    assert_eq!(
        options.mcp_servers["docs"],
        json!({
            "type": "http",
            "url": "https://mcp.example.com/docs",
            "headers": {"Authorization": "Bearer test"}
        })
    );
}

#[test]
fn mcp_variables_are_replaced_using_execution_context() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        auth_token: Some("task-token".to_owned()),
        bot: json!([{
            "mcp_servers": [
                {"name": "backend", "type": "http", "url": "${{backend_url}}/mcp", "headers": {"Authorization": "Bearer ${{task_token}}"}}
            ]
        }]),
        backend_url: Some("https://backend.example.com".to_owned()),
        ..ExecutionRequest::default()
    };

    let options = extract_claude_options(&request, &BTreeMap::new());

    assert_eq!(
        options.mcp_servers["backend"]["url"],
        Value::String("https://backend.example.com/mcp".to_owned())
    );
    assert_eq!(
        options.mcp_servers["backend"]["headers"]["Authorization"],
        "Bearer task-token"
    );
}

#[test]
fn http_mcp_timeout_is_preserved_for_claude_and_deferred_proxy() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{
            "mcp_servers": [
                {
                    "name": "subscription-manager",
                    "type": "http",
                    "url": "https://backend.example.com/mcp/subscription/sse",
                    "headers": {"Authorization": "Bearer task-token"},
                    "timeout_seconds": 60
                }
            ]
        }]),
        ..ExecutionRequest::default()
    };

    let options = extract_claude_options(&request, &BTreeMap::new());

    assert_eq!(
        options.mcp_servers["subscription-manager"]["timeout"],
        60000
    );
}

#[test]
fn http_mcp_timeout_accepts_seconds_or_milliseconds() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{
            "mcp_servers": [
                {
                    "name": "legacy-seconds",
                    "type": "http",
                    "url": "https://backend.example.com/mcp/legacy",
                    "timeout": 12
                },
                {
                    "name": "official-milliseconds",
                    "type": "http",
                    "url": "https://backend.example.com/mcp/official",
                    "timeout": 12000
                }
            ]
        }]),
        ..ExecutionRequest::default()
    };

    let options = extract_claude_options(&request, &BTreeMap::new());

    assert_eq!(options.mcp_servers["legacy-seconds"]["timeout"], 12000);
    assert_eq!(
        options.mcp_servers["official-milliseconds"]["timeout"],
        12000
    );
}

#[test]
fn duplicate_request_mcp_preserves_bot_headers_when_incoming_has_none() {
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        bot: json!([{
            "mcp_servers": [
                {
                    "name": "StatusExtend",
                    "type": "http",
                    "url": "http://mcp.com/2/mcp/internal/server/status-extend",
                    "headers": {"Authorization": "Bearer bot-token"},
                    "timeout": 60
                }
            ]
        }]),
        mcp_servers: vec![json!({
            "name": "StatusExtend",
            "type": "http",
            "url": "http://mcp/internal/server/status-extend"
        })],
        ..ExecutionRequest::default()
    };

    let options = extract_claude_options(&request, &BTreeMap::new());

    assert_eq!(
        options.mcp_servers["StatusExtend"]["url"],
        "http://mcp/internal/server/status-extend"
    );
    assert_eq!(
        options.mcp_servers["StatusExtend"]["headers"]["Authorization"],
        "Bearer bot-token"
    );
    assert_eq!(options.mcp_servers["StatusExtend"]["timeout"], 60000);
}
