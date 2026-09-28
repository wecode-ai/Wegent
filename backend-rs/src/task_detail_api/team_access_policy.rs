// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.services.team_access_policy.team_usage_summary` for
//! `GET /api/tasks/{task_id}`: the team payload a user whose effective role in
//! the team's namespace is `RestrictedAnalyst` may receive. Chat capabilities
//! are kept; the member prompt and every agent-config field other than the
//! model references are dropped.
//!
//! The authorization decision (`should_redact_team_for_user`) is shared with
//! the other team-rendering APIs, but this transformation is bound to the
//! task-detail response model, the only response that keeps the redacted team.
use std::collections::BTreeMap;

use serde_json::value::RawValue;

use super::models::TeamResponse;
use crate::json_compat::OpaqueJson;

/// `team_usage_summary`'s `model_reference_fields`: the only `agent_config`
/// keys a redacted team keeps.
const MODEL_REFERENCE_FIELDS: [&str; 4] = [
    "bind_model",
    "bind_model_type",
    "bind_model_namespace",
    "allowed_models",
];

/// Rebuild one bot's `agent_config` with only the model-reference keys.
///
/// Values are re-emitted verbatim, so an allowed key that is explicitly null
/// stays null while an absent key stays absent, like the source's dict
/// comprehension. The source reads `member.get("agent_config") or {}` and then
/// filters its items, so a missing or non-object value yields the empty object.
fn filtered_agent_config(config: &RawValue) -> Box<RawValue> {
    let projected: BTreeMap<String, Box<RawValue>> =
        serde_json::from_str(config.get()).unwrap_or_default();
    let kept = projected
        .into_iter()
        .filter(|(key, _)| MODEL_REFERENCE_FIELDS.contains(&key.as_str()))
        .collect::<BTreeMap<String, Box<RawValue>>>();
    OpaqueJson::from_serializable(kept).to_raw_value()
}

/// Apply `team_usage_summary` in place.
pub(crate) fn team_usage_summary(team: &mut TeamResponse) {
    for member in &mut team.bots {
        member.bot_prompt = String::new();
        member.bot.agent_config = filtered_agent_config(&member.bot.agent_config);
    }
}

#[cfg(test)]
mod tests {
    use super::super::models::{
        BotSummaryResponse, TeamBotResponse, TeamDisplayConfig, TeamWorkflowResponse,
    };
    use super::*;
    use crate::json_compat::raw_null;

    fn raw(source: &str) -> Box<RawValue> {
        serde_json::from_str(source).expect("test fixture is valid JSON")
    }

    fn team_with(members: Vec<(String, &str)>) -> TeamResponse {
        let bots = members
            .into_iter()
            .map(|(bot_prompt, agent_config)| TeamBotResponse {
                bot_id: 1,
                bot_prompt,
                role: "worker".to_owned(),
                require_confirmation: false,
                context_passing: "none".to_owned(),
                bot: BotSummaryResponse {
                    agent_config: raw(agent_config),
                    agent_name: None,
                    shell_type: "ClaudeCode".to_owned(),
                },
            })
            .collect();
        TeamResponse {
            quick_phrases: Vec::new(),
            name: "team".to_owned(),
            display_name: raw_null(),
            description: raw_null(),
            bots,
            workflow: TeamWorkflowResponse { mode: raw_null() },
            bind_mode: raw_null(),
            mode_spec: raw_null(),
            is_active: true,
            icon: raw_null(),
            display_config: TeamDisplayConfig::default(),
            input_placeholder: None,
            requires_workspace: raw_null(),
            id: 7,
            user_id: 9,
            namespace: "group".to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
            user: raw_null(),
            share_status: 0,
            agent_type: raw_null(),
            recommended_mode: "chat".to_owned(),
            publication_status: raw_null(),
        }
    }

    #[test]
    fn blanks_every_member_prompt_and_keeps_only_model_references() {
        let mut team = team_with(vec![
            (
                "private prompt".to_owned(),
                r#"{"bind_model":"m","system_prompt":"secret"}"#,
            ),
            ("second prompt".to_owned(), "null"),
        ]);
        team_usage_summary(&mut team);
        assert_eq!(team.bots[0].bot_prompt, "");
        assert_eq!(team.bots[0].bot.agent_config.get(), r#"{"bind_model":"m"}"#);
        assert_eq!(team.bots[1].bot_prompt, "");
        assert_eq!(team.bots[1].bot.agent_config.get(), "{}");
    }

    #[test]
    fn keeps_only_model_reference_fields() {
        let kept = filtered_agent_config(&raw(concat!(
            r#"{"bind_model":"gpt-4o","bind_model_type":"public","#,
            r#""bind_model_namespace":"default","allowed_models":["a","b"],"#,
            r#""temperature":0.7,"system_prompt":"private"}"#
        )));
        assert_eq!(
            kept.get(),
            concat!(
                r#"{"allowed_models":["a","b"],"bind_model":"gpt-4o","#,
                r#""bind_model_namespace":"default","bind_model_type":"public"}"#
            )
        );
    }

    #[test]
    fn absent_and_non_object_configs_become_empty_objects() {
        for source in ["null", "{}", "\"text\"", "[]", "7"] {
            assert_eq!(filtered_agent_config(&raw(source)).get(), "{}", "{source}");
        }
    }

    /// `Option<Box<RawValue>>` would collapse a present null into an absent
    /// key; the source's dict comprehension keeps it.
    #[test]
    fn explicit_null_kept_field_stays_null() {
        let kept = filtered_agent_config(&raw(r#"{"bind_model":null,"extra":1}"#));
        assert_eq!(kept.get(), r#"{"bind_model":null}"#);
    }

    #[test]
    fn a_null_only_object_is_not_empty() {
        let kept = filtered_agent_config(&raw(r#"{"bind_model_type":null}"#));
        assert_eq!(kept.get(), r#"{"bind_model_type":null}"#);
    }
}
