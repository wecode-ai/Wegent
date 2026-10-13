// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Team execution readiness (`agent_status`).
//!
//! Mirrors `app/services/workspaces/resource_mapping.py::agent_status` ->
//! `app/services/execution/team_readiness.py::validate_team_execution_readiness`.
use brz_mysql::MysqlService;
use serde::Deserialize;

use crate::auth::UserRow;
use crate::remote_workspace_tree::kinds::KindStore;
use crate::state::AppState;
use crate::teams::group_membership::{ErpContext, effective_roles, user_group_memberships};
use crate::v1_resources::model_resolution;
use crate::v1_resources::repository::OwnedKindRow;
use crate::v1_resources::shell_resolution as shell;
use brz_json::JsonProjection;

/// The Team `spec.members[].botRef` entries consumed by the readiness check.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct TeamMembersInput {
    pub members: Option<Vec<Option<TeamMemberInput>>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct TeamMemberInput {
    #[serde(rename = "botRef")]
    pub bot_ref: Option<BotRefInput>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct BotRefInput {
    pub name: Option<String>,
    pub namespace: Option<String>,
}

/// The Bot `spec` fields consumed by the readiness check.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct BotSpecInput {
    #[serde(rename = "ghostRef")]
    pub ghost_ref: Option<BotRefInput>,
    #[serde(rename = "shellRef")]
    pub shell_ref: Option<BotRefInput>,
    #[serde(rename = "modelRef")]
    pub model_ref: Option<BotRefInput>,
}

/// `agent_status`: a Team is `available` only when it is active and every
/// member's Bot/Ghost/Shell/Model resolve.
pub async fn agent_status(
    state: &AppState,
    kinds: &KindStore<'_, MysqlService, brz_redis::RedisService>,
    team: &OwnedKindRow,
    user: &UserRow,
) -> String {
    if team.is_active == 0 {
        return "unavailable".to_string();
    }
    if validate_team_readiness(state, kinds, team, user)
        .await
        .is_err()
    {
        return "unavailable".to_string();
    }
    "available".to_string()
}

/// `Team.model_validate(team.json).spec.members`: decode the Team CRD
/// document's `spec` object into the member-list input, not the top-level
/// document.
fn team_members_projection(team: &OwnedKindRow) -> JsonProjection<TeamMembersInput> {
    match team.json.0.get("spec") {
        Some(spec) => JsonProjection::<TeamMembersInput>::from_json(spec),
        None => JsonProjection { value: None },
    }
}

/// `validate_team_execution_readiness`.
async fn validate_team_readiness(
    state: &AppState,
    kinds: &KindStore<'_, MysqlService, brz_redis::RedisService>,
    team: &OwnedKindRow,
    user: &UserRow,
) -> Result<(), ()> {
    let members_input = team_members_projection(team);
    let Some(members) = members_input
        .value
        .as_ref()
        .and_then(|input| input.members.as_ref())
    else {
        return Err(());
    };
    // `if not team_crd.spec.members`: an empty member list is also invalid.
    if members.is_empty() {
        return Err(());
    }
    let mut checked: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let team_user_id = team.user_id;
    for member in members.iter().flatten() {
        let Some(bot_ref) = member.bot_ref.as_ref() else {
            continue;
        };
        let name = bot_ref.name.clone().unwrap_or_default();
        let namespace = bot_ref
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        if !checked.insert((namespace.clone(), name.clone())) {
            continue;
        }
        if validate_team_member(state, kinds, team_user_id, &namespace, &name, user)
            .await
            .is_err()
        {
            return Err(());
        }
    }
    Ok(())
}

/// `_validate_team_member`: Bot, Ghost, Shell, Model resolution in the Team
/// owner's scope.
async fn validate_team_member(
    state: &AppState,
    kinds: &KindStore<'_, MysqlService, brz_redis::RedisService>,
    team_user_id: i64,
    bot_namespace: &str,
    bot_name: &str,
    user: &UserRow,
) -> Result<(), ()> {
    // Bot in the team owner's scope.
    let bot = kinds
        .get_by_name_and_namespace(team_user_id, "Bot", bot_namespace, bot_name)
        .await
        .map_err(|_| ())?
        .ok_or(())?;
    let bot_json = &bot.json;
    let bot_spec: BotSpecInput = if let Some(spec) = bot_json
        .0
        .get("spec")
        .and_then(|spec| serde_json::Value::as_object(spec))
    {
        serde_json::from_value(serde_json::Value::Object(spec.clone())).unwrap_or_default()
    } else {
        BotSpecInput::default()
    };
    // Ghost.
    let ghost_ref = bot_spec.ghost_ref.as_ref();
    let ghost_name = ghost_ref.and_then(|r| r.name.clone()).unwrap_or_default();
    let ghost_namespace = ghost_ref
        .and_then(|r| r.namespace.clone())
        .unwrap_or_else(|| "default".to_string());
    let ghost = kinds
        .get_by_name_and_namespace(team_user_id, "Ghost", &ghost_namespace, &ghost_name)
        .await
        .map_err(|_| ())?
        .ok_or(())?;
    if validate_document(&ghost.json.0).is_err() {
        return Err(());
    }
    // Shell.
    let shell_ref = bot_spec.shell_ref.as_ref();
    let shell_name = shell_ref.and_then(|r| r.name.clone()).unwrap_or_default();
    let shell_namespace = shell_ref
        .and_then(|r| r.namespace.clone())
        .unwrap_or_else(|| "default".to_string());
    if validate_shell(state, team_user_id, &shell_namespace, &shell_name)
        .await
        .is_err()
    {
        return Err(());
    }
    // Model (in the execution user's scope).
    let model_ref = bot_spec.model_ref.as_ref();
    let model_name = model_ref.and_then(|r| r.name.clone()).unwrap_or_default();
    if validate_model(state, team_user_id, &model_name, user)
        .await
        .is_err()
    {
        return Err(());
    }
    Ok(())
}

/// `get_shell_by_name`: personal, referenced, group (non-`default`
/// namespace), then public — all direct SQL through the source adapter, so
/// no kind-cache reads or writes.
async fn validate_shell(
    state: &AppState,
    team_user_id: i64,
    namespace: &str,
    name: &str,
) -> Result<(), ()> {
    let mysql = &state.mysql;
    if let Some(shell) = shell::personal_shell(mysql, name, team_user_id, namespace)
        .await
        .map_err(|_| ())?
    {
        return validate_document(&shell.json.0);
    }
    if let Some(shell) = shell::referenced_shell(mysql, name, team_user_id, namespace)
        .await
        .map_err(|_| ())?
    {
        return validate_document(&shell.json.0);
    }
    if namespace != "default"
        && user_in_group(state, team_user_id, namespace).await
        && let Some(shell) = shell::group_shell(mysql, name, namespace)
            .await
            .map_err(|_| ())?
    {
        return validate_document(&shell.json.0);
    }
    if let Some(shell) = shell::public_shell(mysql, name).await.map_err(|_| ())? {
        return validate_document(&shell.json.0);
    }
    Err(())
}

/// `get_shell_by_name`'s `get_user_groups(db, user_id)` membership test for
/// the group branch.
async fn user_in_group(state: &AppState, user_id: i64, namespace: &str) -> bool {
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    match user_group_memberships(&state.mysql, &erp, user_id).await {
        Ok(resolved) => effective_roles(&resolved.memberships, &resolved.active_names)
            .into_keys()
            .any(|group| group == namespace),
        Err(_) => false,
    }
}

/// `get_model_config_for_bot`: the model resolves for the execution user.
async fn validate_model(
    state: &AppState,
    _team_user_id: i64,
    model_name: &str,
    user: &UserRow,
) -> Result<(), ()> {
    if model_name.is_empty() {
        return Err(());
    }
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    if model_resolution::model_resolves(&state.mysql, &erp, state.redis.as_ref(), user, model_name)
        .await
    {
        Ok(())
    } else {
        Err(())
    }
}

/// Decode a kind document; a malformed document is invalid.
fn validate_document(json: &serde_json::Value) -> Result<(), ()> {
    if json.get("spec").is_some() {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    fn timestamp() -> NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 10, 7)
            .unwrap()
            .and_hms_opt(7, 31, 35)
            .unwrap()
    }

    fn team(document: serde_json::Value) -> OwnedKindRow {
        OwnedKindRow {
            id: 18732,
            user_id: 157,
            kind: "Team".to_string(),
            name: "AI助理".to_string(),
            namespace: "default".to_string(),
            json: brz_mysql::Json(document),
            is_active: 1,
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    /// The member list is read from the Team CRD `spec` object, so a normal
    /// Team exposes its `botRef` (the previous top-level read yielded none).
    #[test]
    fn reads_members_from_spec_level() {
        let row = team(serde_json::json!({
            "apiVersion": "wegent.io/v1alpha1",
            "kind": "Team",
            "metadata": {"name": "AI助理"},
            "spec": {"members": [{"botRef": {"name": "AI助理", "namespace": "default"}}]},
        }));
        let projection = team_members_projection(&row);
        let members = projection
            .value
            .as_ref()
            .and_then(|input| input.members.as_ref())
            .expect("members present");
        assert_eq!(members.len(), 1);
        let bot_ref = members[0].as_ref().expect("member").bot_ref.as_ref();
        assert_eq!(bot_ref.and_then(|bot| bot.name.as_deref()), Some("AI助理"));
    }

    /// A Team document without a `spec` object exposes no members, matching
    /// `Team.model_validate` rejecting a document with no `spec.members`.
    #[test]
    fn missing_spec_has_no_members() {
        let row = team(serde_json::json!({"kind": "Team", "metadata": {}}));
        assert!(team_members_projection(&row).value.is_none());
    }

    /// A `spec` without `members` decodes but yields none; the caller treats
    /// that (and an empty list) as invalid.
    #[test]
    fn spec_without_members_yields_none() {
        let row = team(serde_json::json!({"kind": "Team", "spec": {}}));
        let projection = team_members_projection(&row);
        assert!(
            projection
                .value
                .as_ref()
                .and_then(|input| input.members.as_ref())
                .is_none()
        );
    }
}
