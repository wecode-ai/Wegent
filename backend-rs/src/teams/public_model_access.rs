// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Public-model `allowedUsers` visibility for the `GET /api/teams` preload,
//! mirroring `app/services/adapters/public_model.py`.
//!
//! The source evaluates `is_public_model_allowed_for_user_id` once per public
//! `Model` row returned by the preload statement, and each call loads the
//! request user by id (`db.query(User).filter(User.id == user_id).first()`)
//! before applying the whitelist. The user lookup and the resulting filter
//! are both part of the endpoint's observable dependency behavior, so the
//! target performs one user read per fetched public model exactly like the
//! source, and keeps only the models the user may see.

use serde_json::Value;

use crate::json_compat::OpaqueJson;

use super::teams_repository::{KindRow, user_by_id};

/// The `spec` fields read by `is_public_model_whitelist_enabled` and
/// `get_public_model_allowed_users`.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PublicModelSpecInput {
    #[serde(rename = "allowedUsersEnabled")]
    allowed_users_enabled: Option<bool>,
    #[serde(rename = "allowedUsers")]
    allowed_users: Option<Vec<Value>>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PublicModelDocumentInput {
    spec: Option<PublicModelSpecInput>,
}

fn spec_input(json: &OpaqueJson) -> PublicModelSpecInput {
    json.project::<PublicModelDocumentInput>()
        .and_then(|document| document.spec)
        .unwrap_or_default()
}

/// `is_public_model_whitelist_enabled`: whitelist-only mode is active only
/// for the literal JSON `true`. A missing key, another type, or a document
/// without an object `spec` leaves the model visible to everyone.
pub fn whitelist_enabled(json: &OpaqueJson) -> bool {
    spec_input(json).allowed_users_enabled == Some(true)
}

/// `get_public_model_allowed_users`: the stripped, non-empty string entries
/// of `spec.allowedUsers`. A missing or non-list value yields no entries.
pub fn allowed_user_names(json: &OpaqueJson) -> Vec<String> {
    spec_input(json)
        .allowed_users
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| entry.as_str().map(str::to_owned))
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect()
}

/// `is_public_model_allowed_for_user`.
pub fn allowed_for_user_name(json: &OpaqueJson, user_name: Option<&str>) -> bool {
    if !whitelist_enabled(json) {
        return true;
    }
    // A missing, unknown, or empty user name cannot match a whitelist entry.
    let Some(user_name) = user_name.filter(|name| !name.is_empty()) else {
        return false;
    };
    allowed_user_names(json)
        .iter()
        .any(|allowed| allowed == user_name)
}

/// `is_public_model_allowed_for_user_id` applied to the public models of one
/// preload: load the user by id, then keep the model when the whitelist
/// admits that user. Row order and duplicate rows are preserved.
pub async fn allowed_public_models<M>(
    mysql: &M,
    user_id: i64,
    models: Vec<KindRow>,
) -> Result<Vec<KindRow>, brz_mysql::MysqlError>
where
    M: brz_mysql::Mysql,
{
    let mut allowed = Vec::with_capacity(models.len());
    for model in models {
        let user_name = user_by_id(mysql, user_id)
            .await?
            .map(|user| user.users_user_name);
        if allowed_for_user_name(&model.kinds_json.0, user_name.as_deref()) {
            allowed.push(model);
        }
    }
    Ok(allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(spec: serde_json::Value) -> OpaqueJson {
        OpaqueJson::from(serde_json::json!({ "spec": spec }))
    }

    #[test]
    fn whitelist_is_enabled_only_for_literal_true() {
        assert!(whitelist_enabled(&model(serde_json::json!({
            "allowedUsersEnabled": true
        }))));
        assert!(!whitelist_enabled(&model(serde_json::json!({
            "allowedUsersEnabled": "true"
        }))));
        assert!(!whitelist_enabled(&model(serde_json::json!({}))));
        assert!(!whitelist_enabled(&OpaqueJson::from(serde_json::json!([]))));
    }

    #[test]
    fn allowed_users_keeps_stripped_non_empty_strings() {
        let json = model(serde_json::json!({
            "allowedUsers": [" ziping6 ", "", 7, null, "wuding"]
        }));
        assert_eq!(allowed_user_names(&json), vec!["ziping6", "wuding"]);
        assert!(
            allowed_user_names(&model(serde_json::json!({
                "allowedUsers": "ziping6"
            })))
            .is_empty()
        );
    }

    #[test]
    fn a_model_without_the_whitelist_switch_stays_visible() {
        let json = model(serde_json::json!({ "allowedUsers": ["someone-else"] }));
        assert!(allowed_for_user_name(&json, Some("wuding")));
        assert!(allowed_for_user_name(&json, None));
    }

    #[test]
    fn an_active_whitelist_admits_only_listed_users() {
        let json = model(serde_json::json!({
            "allowedUsersEnabled": true,
            "allowedUsers": [" ziping6 "]
        }));
        assert!(allowed_for_user_name(&json, Some("ziping6")));
        assert!(!allowed_for_user_name(&json, Some("wuding")));
        assert!(!allowed_for_user_name(&json, None));
        assert!(!allowed_for_user_name(&json, Some("")));
    }

    #[test]
    fn an_active_empty_whitelist_denies_every_user() {
        let json = model(serde_json::json!({
            "allowedUsersEnabled": true,
            "allowedUsers": []
        }));
        assert!(!allowed_for_user_name(&json, Some("wuding")));
    }
}
