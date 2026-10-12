// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the `GET /api/teams` response conversion
//! (`team_conversion.rs`).

use std::collections::HashSet;

use serde_json::{Value, json};

use super::*;

fn stored_json(value: Value) -> brz_mysql::Json<OpaqueJson> {
    brz_mysql::Json(value.into())
}

fn team_item(
    team: &TeamRow,
    preloaded: &Preloaded,
    config: &[(&'static str, String, String)],
) -> Value {
    crate::json_contract_tests::serialized(super::team_item(team, preloaded, config)).unwrap()
}
fn bot_summary(bot: &KindRow, user_id: i64, preloaded: &Preloaded) -> Value {
    crate::json_contract_tests::serialized(super::bot_summary(bot, user_id, preloaded)).unwrap()
}

#[test]
fn recommended_mode_matches_source_rules() {
    let mode = |value: Value| {
        let modes = serde_json::from_value::<Vec<Option<String>>>(value).unwrap_or_default();
        recommended_mode(&modes)
    };
    assert_eq!(mode(json!(["chat", "code"])), "both");
    assert_eq!(mode(json!(["code"])), "code");
    assert_eq!(mode(json!(["chat"])), "chat");
    assert_eq!(mode(json!(["task"])), "chat");
    assert_eq!(mode(json!([])), "chat");
    assert_eq!(mode(Value::Null), "chat");
    assert_eq!(mode(json!(["chat", "task", "code"])), "both");
}
#[test]
fn agent_type_mapping() {
    assert_eq!(agent_type_from_shell("ClaudeCode"), "claude");
    assert_eq!(agent_type_from_shell("Agno"), "agno");
    assert_eq!(agent_type_from_shell("Dify"), "dify");
    assert_eq!(agent_type_from_shell("Chat"), "chat");
    assert_eq!(agent_type_from_shell("Custom"), "custom");
}
#[test]
fn context_passing_normalizes_unknown_values() {
    assert_eq!(normalize_context_passing(None), "none");
    assert_eq!(normalize_context_passing(Some("")), "none");
    assert_eq!(normalize_context_passing(Some("bogus")), "none");
    assert_eq!(
        normalize_context_passing(Some("previous_bot")),
        "previous_bot"
    );
}
#[test]
fn datetime_serializes_like_pydantic() {
    let value = NaiveDateTime::parse_from_str("2026-01-19 21:00:58", "%Y-%m-%d %H:%M:%S").unwrap();
    assert_eq!(datetime_value(value), "2026-01-19T21:00:58");
}
#[test]
fn default_for_modes_matches_identity() {
    let default_config = vec![("wework", "wegent-wework".to_string(), "default".to_string())];
    let mut team = TeamRow {
        team_id: 1,
        team_user_id: 0,
        team_name: "wegent-wework".to_string(),
        team_namespace: "default".to_string(),
        team_json: stored_json(serde_json::json!({
            "metadata": { "name": "wegent-wework", "displayName": "W" },
            "spec": {
                "members": [],
                "collaborationModel": "solo",
                "bind_mode": ["task"],
                "displayConfig": {},
            }
        })),
        team_created_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
        team_updated_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
        share_status: 0,
        context_user_id: 0,
        access_source: "native".to_string(),
    };
    let preloaded = Preloaded {
        bots: HashMap::new(),
        group_bots: HashMap::new(),
        shells: HashMap::new(),
        public_shells: HashMap::new(),
        models: HashMap::new(),
        public_models: HashMap::new(),
        users: HashMap::new(),
    };
    let item = team_item(&team, &preloaded, &default_config);
    crate::json_contract_tests::assert_fixture(&format!("team_list_{}", team.share_status), &item);
    assert_eq!(item["default_for_modes"], json!(["wework"]));
    assert_eq!(item["recommended_mode"], "chat");
    assert!(item.get("share_status").is_none());
    assert!(item.get("user").is_none());

    // Shared team reports share_status 2.
    team.share_status = 2;
    let item = team_item(&team, &preloaded, &default_config);
    crate::json_contract_tests::assert_fixture(&format!("team_list_{}", team.share_status), &item);
    assert_eq!(item["share_status"], json!(2));
}
#[test]
fn own_team_share_status_from_labels() {
    let team = TeamRow {
        team_id: 1,
        team_user_id: 5,
        team_name: "t".to_string(),
        team_namespace: "default".to_string(),
        team_json: stored_json(serde_json::json!({
            "metadata": {
                "name": "t",
                "labels": { "share_status": "1" },
            },
            "spec": { "members": [], "collaborationModel": "solo" },
        })),
        team_created_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
        team_updated_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
        share_status: 0,
        context_user_id: 5,
        access_source: "native".to_string(),
    };
    let preloaded = Preloaded {
        bots: HashMap::new(),
        group_bots: HashMap::new(),
        shells: HashMap::new(),
        public_shells: HashMap::new(),
        models: HashMap::new(),
        public_models: HashMap::new(),
        users: HashMap::new(),
    };
    let item = team_item(&team, &preloaded, &[]);
    crate::json_contract_tests::assert_fixture("team_list_own", &item);
    assert_eq!(item["share_status"], json!(1));
}
#[test]
fn bot_summary_uses_public_model_fallback() {
    let bot = KindRow {
        kinds_id: 2,
        kinds_user_id: 0,
        kinds_name: "bot".to_string(),
        kinds_namespace: "default".to_string(),
        kinds_json: stored_json(serde_json::json!({
            "spec": {
                "shellRef": { "name": "Chat", "namespace": "default" },
                "modelRef": { "name": "m1", "namespace": "default" },
            }
        })),
    };
    let mut public_models = HashMap::new();
    public_models.insert(
        "m1".to_string(),
        KindRow {
            kinds_id: 3,
            kinds_user_id: 0,
            kinds_name: "m1".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: stored_json(serde_json::json!({
                "spec": { "isCustomConfig": false }
            })),
        },
    );
    let mut public_shells = HashMap::new();
    public_shells.insert(
        "Chat".to_string(),
        KindRow {
            kinds_id: 4,
            kinds_user_id: 0,
            kinds_name: "Chat".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: stored_json(serde_json::json!({
                "spec": { "shellType": "Chat" }
            })),
        },
    );
    let preloaded = Preloaded {
        bots: HashMap::new(),
        group_bots: HashMap::new(),
        shells: HashMap::new(),
        public_shells,
        models: HashMap::new(),
        public_models,
        users: HashMap::new(),
    };
    let summary = bot_summary(&bot, 229, &preloaded);
    assert_eq!(summary["shell_type"], "Chat");
    assert_eq!(summary["agent_config"]["bind_model"], "m1");
    assert_eq!(summary["agent_config"]["bind_model_type"], "public");
}

#[test]
fn bot_summary_preserves_custom_model_config() {
    let bot = KindRow {
        kinds_id: 2,
        kinds_user_id: 229,
        kinds_name: "bot".to_string(),
        kinds_namespace: "default".to_string(),
        kinds_json: stored_json(serde_json::json!({
            "spec": { "modelRef": { "name": "m1", "namespace": "default" } }
        })),
    };
    let mut models = HashMap::new();
    models.insert(
        (229, "m1".to_string(), "default".to_string()),
        KindRow {
            kinds_id: 3,
            kinds_user_id: 229,
            kinds_name: "m1".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: stored_json(serde_json::json!({
                "spec": {
                    "isCustomConfig": true,
                    "modelConfig": {
                        "base_url": "https://models.example.invalid",
                        "retries": 2,
                        "headers": { "x-client": "wegent" }
                    },
                    "protocol": "openai"
                }
            })),
        },
    );
    let preloaded = Preloaded {
        bots: HashMap::new(),
        group_bots: HashMap::new(),
        shells: HashMap::new(),
        public_shells: HashMap::new(),
        models,
        public_models: HashMap::new(),
        users: HashMap::new(),
    };

    let summary = bot_summary(&bot, 229, &preloaded);
    assert_eq!(
        summary["agent_config"],
        json!({
            "base_url": "https://models.example.invalid",
            "retries": 2,
            "headers": { "x-client": "wegent" },
            "protocol": "openai"
        })
    );
}

#[test]
fn preload_public_shell_names_cover_cache_misses() {
    // Ensures the shell fallback ordering: user shells first, then
    // public shells by name for anything missing.
    let mut shells = HashMap::new();
    shells.insert(
        (229, "ClaudeCode".to_string(), "default".to_string()),
        KindRow {
            kinds_id: 10,
            kinds_user_id: 229,
            kinds_name: "ClaudeCode".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: stored_json(serde_json::json!({ "spec": { "shellType": "ClaudeCode" } })),
        },
    );
    let shell_refs = [
        (229, "ClaudeCode".to_string(), "default".to_string()),
        (0, "Chat".to_string(), "default".to_string()),
    ];
    let names: Vec<String> = shell_refs
        .iter()
        .filter(|(uid, name, ns)| !shells.contains_key(&(*uid, name.clone(), ns.clone())))
        .map(|(_, name, _)| name.clone())
        .collect();
    assert_eq!(names, vec!["Chat".to_string()]);
}
#[test]
fn distinct_shell_types_drive_mix_flag() {
    let types: HashSet<String> = ["Chat", "ClaudeCode"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert!(types.len() > 1);
    let single: HashSet<String> = ["Chat"].iter().map(|s| s.to_string()).collect();
    assert!(single.len() == 1);
}
