// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared plugin-account connection helpers.
//!
//! Source: `app/services/plugin_account_connections.py` (`_coordinate_owner`,
//! `_query`, `_installed_plugin`, `_plugin`, `_source_identity`) and the
//! SQLAlchemy JSON predicates its `_query` callers rely on.

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use serde_json::{Map, Value, json};

use crate::device_identity::DeviceKindRow;
use crate::json_compat::{python_json_compact, python_truthy};
use crate::plugins_installed::write_coordination::PluginWriteLease;
use crate::plugins_marketplace::db::KIND_COLUMNS;

use super::definition;

/// `CONNECTION_NAMESPACE`: every account-auth Kind lives in this namespace.
pub(crate) const CONNECTION_NAMESPACE: &str = "plugin-auth";

/// One account-auth business refusal (`PluginAccountAuthError`) or an internal
/// failure. The source's per-connector savepoint only continues on the former.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthFailure {
    /// `PluginAccountAuthError(code)`: roll back the connector's savepoint and
    /// keep reconciling.
    Refusal(&'static str),
    /// Any other exception: the whole request fails.
    Internal,
}

impl AuthFailure {
    /// Map a `Result<_, &'static str>` whose codes are `plugin_*` refusals.
    pub(crate) fn from_reason(reason: &'static str) -> Self {
        if reason.starts_with("plugin_") {
            Self::Refusal(reason)
        } else {
            Self::Internal
        }
    }
}

/// Preserve Native authorization without granting or weakening Device access.
pub(super) fn preserve_native_fields(previous: &Value, next: &mut Value) {
    if let Some(observations) = previous.get("nativeAuthSources") {
        next["nativeAuthSources"] = observations.clone();
    }
    if let Some(grants) = previous.get("localGrants") {
        next["localGrants"] = if previous["authDefinition"] == next["authDefinition"] {
            grants.clone()
        } else {
            json!({})
        };
    }
}

/// Keep revocation ownership before dropping access on either transport.
pub(super) fn revoke_native_fields(spec: &mut Value) {
    if let Some(grants) = spec.get("localGrants").cloned() {
        if !grants.as_object().is_none_or(|g| g.is_empty())
            && spec["oauthRevocation"].get("credential").is_some()
        {
            spec["oauthRevocation"]["localPrincipals"] = grants;
        }
        spec["localGrants"] = json!({});
    }
}

/// `_coordinate_owner`'s owner read: `filter(User.id == user_id).first()`.
const OWNER_QUERY: &str = "SELECT users.id AS users_id, users.is_active AS users_is_active \
     FROM users WHERE users.id = ? LIMIT 1";

#[derive(Debug, FromMysqlRow)]
struct OwnerRow {
    #[mysql(rename = "users_is_active")]
    is_active: Option<bool>,
}

/// `_installed_plugin`: one active installed-plugin row the caller owns.
const INSTALLED_PLUGIN_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.id = ? AND kinds.user_id = ? AND kinds.kind = 'InstalledPlugin' \
     AND kinds.namespace = 'default' AND kinds.is_active IS true LIMIT 1";

/// `_coordinate_owner`: the lease is still owned and the owner is active.
pub(crate) async fn coordinate_owner<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
) -> Result<(), AuthFailure> {
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    owner_row(transaction, user_id).await
}

/// The owner half of `_coordinate_owner`: the row must exist and be active.
pub(crate) async fn owner_row<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
) -> Result<(), AuthFailure> {
    let owner: Option<OwnerRow> = transaction
        .fetch_optional(OWNER_QUERY, (user_id,))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    if owner.is_none_or(|owner| owner.is_active != Some(true)) {
        return Err(AuthFailure::Refusal("plugin_auth_owner_unavailable"));
    }
    Ok(())
}

/// `_installed_plugin`.
pub(crate) async fn installed_plugin<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    plugin_id: i64,
) -> Result<DeviceKindRow, AuthFailure> {
    let row: Option<DeviceKindRow> = transaction
        .fetch_optional(INSTALLED_PLUGIN_QUERY, (plugin_id, user_id))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    row.ok_or(AuthFailure::Refusal("plugin_auth_plugin_not_found"))
}

/// `_plugin`: the installed plugin plus its validated connector definition.
pub(crate) async fn plugin<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    plugin_id: i64,
    slug: &str,
) -> Result<(DeviceKindRow, Value), AuthFailure> {
    let plugin = installed_plugin(transaction, user_id, plugin_id).await?;
    let spec = plugin
        .json
        .get("spec")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if spec.get("enabled") == Some(&Value::Bool(false)) {
        return Err(AuthFailure::Refusal("plugin_auth_plugin_disabled"));
    }
    let connector = spec
        .get("components")
        .and_then(|components| components.get("connectors"))
        .and_then(Value::as_array)
        .and_then(|connectors| {
            connectors
                .iter()
                .find(|connector| connector.get("slug").and_then(Value::as_str) == Some(slug))
        });
    let account_auth = connector
        .and_then(|connector| connector.get("accountAuth"))
        .filter(|value| python_truthy(value));
    let plugin_key = spec
        .get("source")
        .and_then(|source| source.get("pluginKey"))
        .filter(|value| python_truthy(value));
    let (Some(account_auth), Some(_)) = (account_auth, plugin_key) else {
        return Err(AuthFailure::Refusal("plugin_auth_not_supported"));
    };
    let definition = definition::parse(account_auth).map_err(|()| AuthFailure::Internal)?;
    Ok((plugin, definition))
}

/// Metadata for a native adapter, without a credential or provider secret.
pub(super) fn package_metadata(
    plugin: &DeviceKindRow,
    slug: &str,
    definition: Value,
) -> Result<Value, AuthFailure> {
    let checksum = plugin.json["spec"]["packageRef"]["checksum"]
        .as_str()
        .filter(|checksum| {
            checksum.strip_prefix("sha256:").is_some_and(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        })
        .ok_or(AuthFailure::Refusal("plugin_auth_package_sync_required"))?;
    Ok(serde_json::json!({
        "installed_plugin_id": plugin.id,
        "connector_slug": slug,
        "checksum": checksum,
        "auth_definition": definition,
    }))
}

/// Recheck that a persisted connection still refers to the current source and definition.
pub(super) async fn current_plugin<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    spec: &Value,
) -> Result<(DeviceKindRow, Value), AuthFailure> {
    let id = spec["installedPluginId"]
        .as_i64()
        .ok_or(AuthFailure::Internal)?;
    let slug = spec["connectorSlug"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let (plugin, definition) = plugin(transaction, user_id, id, slug).await?;
    if spec["sourceIdentity"] != source_identity(&plugin.json["spec"]["source"])
        || spec["authDefinition"] != definition
    {
        return Err(AuthFailure::Refusal("plugin_auth_definition_changed"));
    }
    Ok((plugin, definition))
}

/// `_query(db, user_id).filter(sourceIdentity == ..., connectorSlug == ...)`,
/// with the optional account filter `PluginAuthSourceSync.target` adds.
pub(crate) async fn connection_rows<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    source_identity: &str,
    connector_slug: &str,
    account_id: Option<&str>,
) -> MysqlResult<Vec<DeviceKindRow>> {
    let mut sql = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.kind = 'ConnectorConnection' AND \
         kinds.namespace = '{CONNECTION_NAMESPACE}' AND kinds.user_id = ? AND \
         kinds.is_active IS true AND {} AND {}",
        spec_string_equals("sourceIdentity"),
        spec_string_equals("connectorSlug"),
    );
    let mut arguments = vec![
        crate::sql_support::StatementArg::Int(user_id),
        crate::sql_support::StatementArg::Str(source_identity.to_string()),
        crate::sql_support::StatementArg::Str(connector_slug.to_string()),
    ];
    if let Some(account_id) = account_id {
        sql.push_str(" AND ");
        sql.push_str(&spec_string_equals("accountId"));
        arguments.push(crate::sql_support::StatementArg::Str(
            account_id.to_string(),
        ));
    }
    transaction.fetch_all(&sql, arguments).await
}

pub(super) async fn find_connection<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    name: &str,
) -> Result<Option<DeviceKindRow>, AuthFailure> {
    transaction
        .fetch_optional(
            format!(
                "SELECT {KIND_COLUMNS} FROM kinds WHERE kind='ConnectorConnection' \
                     AND namespace='{CONNECTION_NAMESPACE}' AND user_id=? AND is_active IS true \
                     AND name=? LIMIT 1"
            ),
            (user_id, name),
        )
        .await
        .map_err(|_| AuthFailure::Internal)
}

pub(super) fn credential_context(user_id: i64, spec: &Value) -> String {
    let mut context = json!([
        user_id,
        spec["sourceIdentity"],
        spec["connectorSlug"],
        spec["accountId"],
        spec["credentialType"],
        spec["authDefinition"]
    ]);
    context.sort_all_objects();
    python_json_compact(&context)
}

pub(super) async fn advance_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    row_id: i64,
    document: &mut Value,
) -> Result<(), AuthFailure> {
    let revision = document["spec"]["revision"]
        .as_i64()
        .ok_or(AuthFailure::Internal)?;
    document["spec"]["revision"] = json!(revision.checked_add(1).ok_or(AuthFailure::Internal)?);
    let document = crate::json_compat::python_json_value(document);
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    let changed = transaction
        .execute(
            format!(
                "UPDATE kinds SET json=?,updated_at=now() WHERE id=? AND is_active IS true AND {}",
                spec_integer_equals("revision")
            ),
            (document.as_str(), row_id, revision),
        )
        .await
        .map_err(|_| AuthFailure::Internal)?;
    if changed.rows_affected != 1 {
        return Err(AuthFailure::Refusal("plugin_auth_revision_conflict"));
    }
    Ok(())
}

/// `_source_identity`: the account-level source identity a connection or
/// migration is scoped by.
///
/// The source renders the five identity fields with `sort_keys=True` and
/// `separators=(",", ":")`, so absent fields serialize as `null` and the keys
/// keep their alphabetical order.
pub(crate) fn source_identity(source: &Value) -> String {
    let object = source.as_object();
    let mut identity = Map::new();
    for key in [
        "catalogItemId",
        "marketplace",
        "pluginKey",
        "providerKey",
        "type",
    ] {
        let value = object
            .and_then(|object| object.get(key))
            .cloned()
            .unwrap_or(Value::Null);
        identity.insert(key.to_string(), value);
    }
    python_json_compact(&Value::Object(identity))
}

/// `Kind.json["spec"][key]` as SQLAlchemy renders the nested JSON path.
pub(crate) fn spec_json(key: &str) -> String {
    format!("JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), '$.\"{key}\"')")
}

/// `Kind.json["spec"][key].as_string() == ?`.
pub(crate) fn spec_string_equals(key: &str) -> String {
    let path = spec_json(key);
    format!("CASE {path} WHEN 'null' THEN NULL ELSE JSON_UNQUOTE({path}) END = ?")
}

/// `Kind.json["spec"][key].as_integer() == ?`.
#[allow(
    dead_code,
    reason = "used by the plugin auth migration create/resume port in the next stage"
)]
pub(crate) fn spec_integer_equals(key: &str) -> String {
    let path = spec_json(key);
    format!("CASE {path} WHEN 'null' THEN NULL ELSE CAST({path} AS SIGNED INTEGER) END = ?")
}

/// `Kind.json["spec"][key].as_boolean().is_(True)`.
pub(crate) fn spec_boolean_is_true(key: &str) -> String {
    let path = spec_json(key);
    format!("CASE {path} WHEN 'null' THEN NULL WHEN true THEN true ELSE false END IS true")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn legacy_replacement_preserves_only_valid_native_authorization() {
        let old = json!({"authDefinition":{"adapter":"auth.py"},"localGrants":{"key":true},"nativeAuthSources":{"key":{"digest":"observed"}}});
        let mut next = json!({"authDefinition":old["authDefinition"]});
        preserve_native_fields(&old, &mut next);
        assert_eq!(next["localGrants"], old["localGrants"]);
        assert_eq!(next["nativeAuthSources"], old["nativeAuthSources"]);
        next["authDefinition"] = json!({"adapter":"changed.py"});
        preserve_native_fields(&old, &mut next);
        assert_eq!(next["localGrants"], json!({}));
        let mut legacy = json!({"authDefinition":{}});
        preserve_native_fields(&json!({"authDefinition":{}}), &mut legacy);
        revoke_native_fields(&mut legacy);
        assert_eq!(
            legacy,
            json!({"authDefinition":{}}),
            "legacy-only records gain no new fields"
        );
    }

    #[test]
    fn legacy_logout_revokes_native_grants_and_preserves_revoke_ownership() {
        let mut spec = json!({"localGrants":{"key":true},"deviceGrants":{"device":{}},"oauthRevocation":{"state":"pending","credential":{"version":1}}});
        revoke_native_fields(&mut spec);
        assert_eq!(spec["localGrants"], json!({}));
        assert_eq!(
            spec["oauthRevocation"]["localPrincipals"],
            json!({"key":true})
        );
        assert_eq!(spec["deviceGrants"], json!({"device":{}}));
    }

    #[test]
    fn source_identity_sorts_and_compacts_the_five_fields() {
        let source = json!({
            "type": "marketplace",
            "providerKey": "wegent-market",
            "pluginKey": "dingtalk",
            "catalogItemId": "2",
            "marketplace": "wework",
            "unrelated": "ignored",
        });
        assert_eq!(
            source_identity(&source),
            "{\"catalogItemId\":\"2\",\"marketplace\":\"wework\",\"pluginKey\":\"dingtalk\",\
             \"providerKey\":\"wegent-market\",\"type\":\"marketplace\"}"
        );
    }

    #[test]
    fn source_identity_keeps_absent_fields_as_null() {
        assert_eq!(
            source_identity(&json!({"pluginKey": "dingtalk"})),
            "{\"catalogItemId\":null,\"marketplace\":null,\"pluginKey\":\"dingtalk\",\
             \"providerKey\":null,\"type\":null}"
        );
    }

    #[test]
    fn the_json_predicates_match_the_recorded_sqlalchemy_rendering() {
        let source_identity_path = "JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
                                    '$.\"sourceIdentity\"')";
        assert_eq!(
            spec_json("sourceIdentity"),
            source_identity_path,
            "the nested path keeps both JSON_EXTRACT calls"
        );
        assert_eq!(
            spec_string_equals("sourceIdentity"),
            format!(
                "CASE {source_identity_path} WHEN 'null' THEN NULL ELSE \
                 JSON_UNQUOTE({source_identity_path}) END = ?"
            )
        );
        let installed_path = "JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
                              '$.\"installed_plugin_id\"')";
        assert_eq!(
            spec_integer_equals("installed_plugin_id"),
            format!(
                "CASE {installed_path} WHEN 'null' THEN NULL ELSE \
                 CAST({installed_path} AS SIGNED INTEGER) END = ?"
            )
        );
        let automatic_path = "JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
                              '$.\"automatic\"')";
        assert_eq!(
            spec_boolean_is_true("automatic"),
            format!(
                "CASE {automatic_path} WHEN 'null' THEN NULL WHEN true THEN true ELSE false \
                 END IS true"
            )
        );
    }

    #[test]
    fn the_recorded_connector_connection_predicate_matches() {
        // Recording 20261105200002 (case d7eae0ca), ledger 40719.
        let recorded = "CASE JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
                        '$.\"sourceIdentity\"') WHEN 'null' THEN NULL ELSE \
                        JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
                        '$.\"sourceIdentity\"')) END = ?";
        assert_eq!(spec_string_equals("sourceIdentity"), recorded);
    }
}
