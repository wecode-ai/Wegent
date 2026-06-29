// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;
use wegent_executor::{agents::build_agno_options, protocol::ExecutionRequest};

#[test]
fn agno_options_inject_task_identity_env_without_mutating_request() {
    let request = ExecutionRequest {
        bot: json!([{
            "name": "member-1",
            "agent_config": {"env": {"EXISTING_VAR": "value"}}
        }]),
        user_name: Some("alice".to_owned()),
        skill_identity_token: Some("skill-jwt".to_owned()),
        ..ExecutionRequest::default()
    };

    let options = build_agno_options(&request);

    let member_env = &options["team_members"][0]["agent_config"]["env"];
    assert_eq!(member_env["EXISTING_VAR"], "value");
    assert_eq!(member_env["WEGENT_SKILL_IDENTITY_TOKEN"], "skill-jwt");
    assert_eq!(member_env["WEGENT_SKILL_USER_NAME"], "alice");
    assert!(request.bot[0]["agent_config"]["env"]
        .get("WEGENT_SKILL_IDENTITY_TOKEN")
        .is_none());
}

#[test]
fn agno_options_copy_first_bot_options_for_team_requests() {
    let request = ExecutionRequest {
        bot: json!([
            {
                "name": "leader",
                "model": "claude",
                "model_id": "claude-sonnet-4",
                "team_description": "write code"
            },
            {"name": "reviewer"}
        ]),
        ..ExecutionRequest::default()
    };

    let options = build_agno_options(&request);

    assert_eq!(options["model"], "claude");
    assert_eq!(options["model_id"], "claude-sonnet-4");
    assert_eq!(options["team_description"], "write code");
    assert_eq!(options["team_members"].as_array().unwrap().len(), 2);
}
