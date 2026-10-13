// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::{Value, json};

const OWNER_ID: i64 = 229;
const GUEST_ID: i64 = 7;

fn kind(id: i64, name: &str, namespace: &str, document: Value) -> KindRow {
    KindRow {
        kinds_id: id,
        kinds_user_id: OWNER_ID,
        kinds_name: name.to_owned(),
        kinds_namespace: namespace.to_owned(),
        kinds_json: brz_mysql::Json(document.into()),
    }
}

fn sensitive_team() -> (TeamRow, Preloaded) {
    let bot = kind(
        2,
        "bot",
        "group",
        json!({"spec": {
            "shellRef": {"name": "Chat", "namespace": "default"},
            "modelRef": {"name": "model", "namespace": "group"}
        }}),
    );
    let model = kind(
        3,
        "model",
        "group",
        json!({"spec": {
            "isCustomConfig": true,
            "protocol": "openai",
            "modelConfig": {
                "api_key": "test-only-model-key",
                "env": {"API_KEY": "test-only-nested-key"},
                "headers": {"Authorization": "test-only-authorization"},
                "base_url": "https://models.example.invalid",
                "system_prompt": "private model instructions",
                "bind_model": "approved-model",
                "bind_model_type": "user",
                "bind_model_namespace": null,
                "allowed_models": [{"name": "approved-model", "type": "user"}]
            }
        }}),
    );
    let shell = kind(4, "Chat", "default", json!({"spec": {"shellType": "Chat"}}));
    let team = TeamRow {
        team_id: 1,
        team_user_id: OWNER_ID,
        team_name: "agent".to_owned(),
        team_namespace: "group".to_owned(),
        team_json: brz_mysql::Json(
            json!({
                "metadata": {"name": "agent", "displayName": "Agent"},
                "spec": {
                    "members": [
                        {"botRef": {"name": "bot", "namespace": "group"},
                         "prompt": "private leader instructions", "role": "leader"},
                        {"botRef": {"name": "bot", "namespace": "group"},
                         "prompt": "private worker instructions", "role": "worker"}
                    ],
                "collaborationModel": "pipeline",
                    "bind_mode": ["chat"]
                }
            })
            .into(),
        ),
        team_created_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
        team_updated_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
        share_status: 0,
        context_user_id: OWNER_ID,
        restricted_guest_access: 1,
        access_source: "native".to_owned(),
    };
    let preloaded = Preloaded {
        bots: HashMap::from([(
            (OWNER_ID, "bot".to_owned(), "group".to_owned()),
            bot.clone(),
        )]),
        group_bots: HashMap::from([(("bot".to_owned(), "group".to_owned()), bot)]),
        shells: HashMap::new(),
        public_shells: HashMap::from([("Chat".to_owned(), shell)]),
        models: HashMap::from([((OWNER_ID, "model".to_owned(), "group".to_owned()), model)]),
        public_models: HashMap::new(),
        users: HashMap::from([(OWNER_ID, "owner".to_owned())]),
    };
    (team, preloaded)
}

fn response(team: &TeamRow, preloaded: &Preloaded, user_id: i64) -> Value {
    crate::json_contract_tests::serialized(team_item(team, preloaded, &[], user_id)).unwrap()
}

fn assert_usage_summary(actual: &Value) {
    let bots = actual["bots"].as_array().unwrap();
    assert_eq!(bots.len(), 2);
    for member in bots {
        assert_eq!(member["bot_prompt"], "");
        assert_eq!(member["bot"]["name"], "bot");
        assert_eq!(member["bot"]["shell_type"], "Chat");
        assert_eq!(
            member["bot"]["agent_config"],
            json!({
                "bind_model": "approved-model",
                "bind_model_type": "user",
                "bind_model_namespace": null,
                "allowed_models": [{"name": "approved-model", "type": "user"}]
            })
        );
    }
    assert_eq!(actual["workflow"]["mode"], "pipeline");
    assert_eq!(actual["bind_mode"], json!(["chat"]));
    assert_eq!(actual["user"]["id"], OWNER_ID);
}

#[test]
fn restricted_group_access_redacts_nonempty_prompts_and_custom_model_credentials() {
    let (mut team, preloaded) = sensitive_team();
    for access_source in ["native", "namespace_authorization"] {
        team.access_source = access_source.to_owned();
        let before = response(&team, &preloaded, OWNER_ID);
        let actual = response(&team, &preloaded, GUEST_ID);
        assert_usage_summary(&actual);
        let mut expected = before.clone();
        for member in expected["bots"].as_array_mut().unwrap() {
            member["bot_prompt"] = json!("");
            member["bot"]["agent_config"] = actual["bots"][0]["bot"]["agent_config"].clone();
        }
        assert_eq!(actual, expected);
        // Response filtering must not mutate the stored team or preloaded models.
        assert_eq!(response(&team, &preloaded, OWNER_ID), before);
    }
}

#[test]
fn restricted_namespace_grant_redacts_another_owners_personal_team() {
    let (mut team, preloaded) = sensitive_team();
    team.team_namespace = "default".to_owned();
    team.access_source = "namespace_authorization".to_owned();
    assert_usage_summary(&response(&team, &preloaded, GUEST_ID));
}

#[test]
fn team_owner_keeps_prompts_and_custom_model_configuration() {
    let (team, preloaded) = sensitive_team();
    let actual = response(&team, &preloaded, OWNER_ID);
    assert_eq!(
        actual["bots"][0]["bot_prompt"],
        "private leader instructions"
    );
    assert_eq!(
        actual["bots"][1]["bot_prompt"],
        "private worker instructions"
    );
    for member in actual["bots"].as_array().unwrap() {
        assert_eq!(
            member["bot"]["agent_config"]["api_key"],
            "test-only-model-key"
        );
        assert_eq!(
            member["bot"]["agent_config"]["env"]["API_KEY"],
            "test-only-nested-key"
        );
        assert_eq!(member["bot"]["agent_config"]["protocol"], "openai");
    }
}

#[test]
fn unrestricted_group_access_keeps_the_original_configuration() {
    let (mut team, preloaded) = sensitive_team();
    team.restricted_guest_access = 0;
    assert_eq!(
        response(&team, &preloaded, GUEST_ID),
        response(&team, &preloaded, OWNER_ID)
    );
}
