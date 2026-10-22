// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Model resolution for one bot (`get_model_config_for_bot`).
//!
//! Mirrors `app/services/chat/config/model_resolver.py::_find_model_with_namespace`
//! and `get_model_config_for_bot` as consumed by the team readiness check.
//! The readiness check only needs to know whether the bot's model resolves to
//! a usable configuration (raising `ValueError` when it does not), so this
//! module reproduces the resolution dependency stream and returns success or
//! failure rather than the full decoded config.
use brz_mysql::{Mysql, MysqlRow};
use serde_json::Value;

use crate::auth::UserRow;
use crate::teams::group_membership::{ErpContext, effective_roles, user_group_memberships};
use crate::v1_resources::repository::MysqlValue;
use brz_json::OpaqueJson;

/// `_find_model_with_namespace`: resolve a model by name in the user's scope
/// (personal, referenced, group, public) and report whether a usable spec was
/// found.
pub async fn model_resolves<M>(
    mysql: &M,
    erp: &ErpContext<'_, brz_redis::RedisService>,
    _redis: Option<&brz_redis::RedisService>,
    user: &UserRow,
    model_name: &str,
) -> bool
where
    M: Mysql,
{
    let user_id = i64::from(user.id);
    // Step 1: user's private model.
    let user_model = personal_model(mysql, user_id, model_name).await;
    if is_usable_model(user_model) {
        return true;
    }
    // Step 2: referenced model in the personal default namespace.
    let personal_ref = referenced_model(mysql, "user", &user_id.to_string(), model_name).await;
    if is_usable_model(personal_ref) {
        return true;
    }
    // Step 3: the user's accessible group namespaces (`get_user_groups`).
    let resolved = match user_group_memberships(mysql, erp, user_id).await {
        Ok(resolved) => resolved,
        Err(error) => {
            tracing::warn!(%error, "[v1_resources] group membership resolution failed");
            return false;
        }
    };
    let mut group_names: Vec<String> =
        effective_roles(&resolved.memberships, &resolved.active_names)
            .into_keys()
            .collect();
    group_names.sort();
    // Step 4: a group model over the accessible namespaces.
    if !group_names.is_empty() {
        let group_model = group_model(mysql, model_name, &group_names).await;
        if is_usable_model(group_model) {
            return true;
        }
    }
    // Step 5: a referenced model per accessible group namespace.
    for group in &group_names {
        if let Some(spec) = referenced_model_in_namespace(mysql, group, model_name).await
            && is_usable_model(Some(spec))
        {
            return true;
        }
    }
    // Step 6: the public model (`user_id = 0`), with the whitelist check that
    // loads the user by id.
    let public = public_model(mysql, model_name).await;
    if let Some(model) = public {
        // `db.query(User).filter(User.id == user_id).first()`: the source
        // re-reads the whitelisted user rather than reusing the caller row.
        let user_name = load_user_name(mysql, user_id).await;
        let whitelist_ok = crate::teams::public_model_access::allowed_for_user_name(
            &OpaqueJson::from(model.json.0.clone()),
            user_name.as_deref(),
        );
        if whitelist_ok && is_usable_model(Some(model)) {
            return true;
        }
    }
    false
}

/// `db.query(User).filter(User.id == user_id).first()` for the public-model
/// whitelist: the full `users` projection by id.
async fn load_user_name<M>(mysql: &M, user_id: i64) -> Option<String>
where
    M: Mysql,
{
    #[derive(brz_mysql::FromMysqlRow)]
    struct WhitelistUser {
        #[mysql(rename = "users_user_name")]
        user_name: String,
    }
    let user: Option<WhitelistUser> = mysql
        .fetch_optional(crate::user_reader::USER_BY_ID_QUERY, (user_id,))
        .await
        .ok()
        .flatten();
    user.map(|user| user.user_name)
}

/// `_extract_model_config` usable-env check: a resolved Model spec is usable
/// only when its `modelConfig.env` is present (a bind_model pointer wrapper
/// with no `env` is unusable).
fn is_usable_model(model: Option<ModelRow>) -> bool {
    model.is_some_and(|model| {
        model
            .json
            .0
            .get("spec")
            .and_then(|spec| spec.get("modelConfig"))
            .and_then(|config| config.get("env"))
            .is_some()
    })
}

/// Loaded `kinds` Model row.
#[derive(Debug)]
pub struct ModelRow {
    pub json: brz_mysql::Json<Value>,
}

/// Full labeled `kinds` projection used by every model query.
const MODEL_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// Decode a `kinds` row into a `ModelRow`.
fn decode_model_row(row: MysqlRow) -> Option<ModelRow> {
    let json = row
        .get_required::<brz_mysql::Json<Value>>("kinds_json")
        .ok()?;
    Some(ModelRow { json })
}

/// STEP 1 personal model query (`Kind.user_id == user_id`). The owner id
/// binds as an integer so the prepared statement renders `kinds.user_id =
/// 157`, matching the source ORM statement (`Kind.user_id == user_id`).
async fn personal_model<M>(mysql: &M, user_id: i64, model_name: &str) -> Option<ModelRow>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {MODEL_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = 'Model' AND kinds.user_id = ? AND kinds.name = ? \
         AND kinds.is_active = true \
         LIMIT 1"
    );
    mysql
        .fetch_optional(sql.as_str(), (user_id, model_name))
        .await
        .ok()
        .flatten()
        .and_then(decode_model_row)
}

/// `resolve_referenced_model_kind`: the smallest-id approved referenced Model.
async fn referenced_model<M>(
    mysql: &M,
    entity_type: &str,
    entity_id: &str,
    model_name: &str,
) -> Option<ModelRow>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {MODEL_COLUMNS} \
         FROM kinds \
         WHERE kinds.id IN (\
            SELECT resource_members.resource_id \
            FROM resource_members \
            WHERE resource_members.resource_type = 'Model' \
            AND resource_members.entity_type = ? \
            AND resource_members.entity_id = ? \
            AND resource_members.status = 'approved') \
         AND kinds.kind = 'Model' AND kinds.name = ? \
         AND kinds.user_id != 0 AND kinds.is_active IS true \
         ORDER BY kinds.id ASC \
         LIMIT 1"
    );
    mysql
        .fetch_optional(sql.as_str(), (entity_type, entity_id, model_name))
        .await
        .ok()
        .flatten()
        .and_then(decode_model_row)
}

/// STEP 4 group model over the accessible namespaces (the recorded `IN (...)`
/// list).
async fn group_model<M>(mysql: &M, model_name: &str, namespaces: &[String]) -> Option<ModelRow>
where
    M: Mysql,
{
    let placeholders = crate::teams::teams_repository::placeholders(namespaces.len());
    let sql = format!(
        "SELECT {MODEL_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = 'Model' AND kinds.name = ? \
         AND kinds.namespace IN ({placeholders}) AND kinds.is_active = true \
         LIMIT 1"
    );
    let mut args: Vec<MysqlValue> = Vec::with_capacity(namespaces.len() + 1);
    args.push(MysqlValue::Str(model_name.to_string()));
    for namespace in namespaces {
        args.push(MysqlValue::Str(namespace.clone()));
    }
    mysql
        .fetch_optional(sql.as_str(), args)
        .await
        .ok()
        .flatten()
        .and_then(decode_model_row)
}

/// STEP 5 referenced model in one group namespace: first the namespace id by
/// name, then the smallest-id referenced Model in that scope.
async fn referenced_model_in_namespace<M>(
    mysql: &M,
    namespace: &str,
    model_name: &str,
) -> Option<ModelRow>
where
    M: Mysql,
{
    #[derive(Debug, brz_mysql::FromMysqlRow)]
    struct NsRow {
        #[allow(dead_code, reason = "selected to match the recorded projection")]
        namespace_id: i64,
    }
    let ns_id: Option<NsRow> = mysql
        .fetch_optional(
            "SELECT namespace.id AS namespace_id \
             FROM namespace \
             WHERE namespace.name = ? AND namespace.is_active IS true",
            (namespace,),
        )
        .await
        .ok()
        .flatten();
    let ns_id = ns_id?.namespace_id.to_string();
    referenced_model(mysql, "namespace", &ns_id, model_name).await
}

/// STEP 6 public model by name in the default namespace (`user_id = 0`).
async fn public_model<M>(mysql: &M, model_name: &str) -> Option<ModelRow>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {MODEL_COLUMNS} \
         FROM kinds \
         WHERE kinds.user_id = 0 AND kinds.kind = 'Model' AND kinds.name = ? \
         AND kinds.namespace = 'default' AND kinds.is_active = true \
         LIMIT 1"
    );
    mysql
        .fetch_optional(sql.as_str(), (model_name,))
        .await
        .ok()
        .flatten()
        .and_then(decode_model_row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    /// The personal step binds the integer owner id so the statement renders
    /// `kinds.user_id = 157` like the source ORM query.
    #[tokio::test]
    async fn personal_model_binds_the_integer_owner_id() {
        let mysql = KindQueryCapture::default();
        let model = personal_model(&mysql, 157, "openai-gpt-5.1(海外)").await;
        assert!(model.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains(
            "WHERE kinds.kind = 'Model' AND kinds.user_id = ? AND kinds.name = ? \
             AND kinds.is_active = true LIMIT 1"
        ));
        assert_eq!(queries[0].args, 2);
        assert_eq!(queries[0].first_integer, Some(157));
    }

    /// The group step uses `kinds.is_active = true` (the source
    /// `Kind.is_active == True`), not the `IS true` form.
    #[tokio::test]
    async fn group_model_uses_the_equality_truth_test() {
        let mysql = KindQueryCapture::default();
        let namespaces = vec!["if-group".to_string(), "wework-exp".to_string()];
        let model = group_model(&mysql, "openai-gpt-5.1(海外)", &namespaces).await;
        assert!(model.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(
            queries[0]
                .sql
                .contains("kinds.namespace IN (?, ?) AND kinds.is_active = true LIMIT 1")
        );
        assert!(!queries[0].sql.contains("IS true"));
    }
}
