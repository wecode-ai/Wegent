// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shell resolution for `GET /api/models/unified`, ported from
//! `app/services/adapters/shell_utils.py` (`find_shell_json`).
use brz_mysql::Mysql;
use serde_json::Value as Json;

use super::aggregation::{get_user_groups, list_referenced_capabilities_by_namespace};
use super::mysql::KindJsonRow;
use crate::erp_provider::ErpProvider;

/// The capability kind whose referenced payloads `find_shell_json` resolves.
const SHELL_KIND: &str = "Shell";

/// `find_shell_json` public-shell lookup: `db.query(Kind.json)` projects the
/// CRD payload alone and `.first()` renders `LIMIT 1`.
const SHELL_JSON_PUBLIC_SQL: &str = "SELECT json FROM kinds \
     WHERE user_id = 0 AND kind = 'Shell' AND name = ? AND is_active = true LIMIT 1";

/// `find_shell_json` personal-shell lookup, with the same single-column
/// projection, `namespace = 'default'` filter and `.first()` pagination.
const SHELL_JSON_PERSONAL_SQL: &str = "SELECT json FROM kinds \
     WHERE user_id = ? AND kind = 'Shell' AND name = ? AND namespace = 'default' \
     AND is_active = true LIMIT 1";

/// `find_shell_json` group-namespace lookup: the same single-column projection
/// and `.first()` pagination, with a `namespace` filter instead of an owner
/// filter (the source matches any owner's Shell in the group namespace).
const SHELL_JSON_GROUP_SQL: &str = "SELECT json FROM kinds \
     WHERE kind = 'Shell' AND name = ? AND namespace = ? AND is_active = true LIMIT 1";

/// `find_shell_json`: resolve a shell payload from the first source that has
/// it — the public shell, the personal-namespace shell, the Shell referenced
/// into the personal namespace, then each of the user's group namespaces
/// (the direct shell followed by its referenced Shell).
pub(super) async fn get_shell_support_model<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &dyn ErpProvider<R>,
    redis: Option<&R>,
    shell_name: &str,
    user_id: i32,
) -> anyhow::Result<(Vec<String>, String)>
where
    M: Mysql + Sync,
{
    if let Some(value) = fetch_shell_json(mysql, SHELL_JSON_PUBLIC_SQL, (shell_name,)).await? {
        return parse_shell_spec(&value, shell_name);
    }
    if let Some(value) =
        fetch_shell_json(mysql, SHELL_JSON_PERSONAL_SQL, (user_id, shell_name)).await?
    {
        return parse_shell_spec(&value, shell_name);
    }
    if let Some(value) = referenced_shell_json(mysql, shell_name, user_id, "default").await? {
        return parse_shell_spec(&value, shell_name);
    }
    for group_name in get_user_groups(mysql, erp, redis, user_id).await? {
        if let Some(value) = fetch_shell_json(
            mysql,
            SHELL_JSON_GROUP_SQL,
            (shell_name, group_name.as_str()),
        )
        .await?
        {
            return parse_shell_spec(&value, shell_name);
        }
        if let Some(value) = referenced_shell_json(mysql, shell_name, user_id, &group_name).await? {
            return parse_shell_spec(&value, shell_name);
        }
    }
    Ok((Vec::new(), shell_name.to_string()))
}

/// Run a single-row `SELECT json FROM kinds ...` lookup and keep only the CRD
/// payload, mirroring `db.query(Kind.json).first()`.
async fn fetch_shell_json<A, M>(mysql: &M, sql: &str, arguments: A) -> anyhow::Result<Option<Json>>
where
    M: Mysql + Sync,
    A: brz_mysql::MysqlArgs + Send,
{
    Ok(mysql
        .fetch_optional::<_, _, KindJsonRow>(sql, arguments)
        .await?
        .map(|row| row.json.0))
}

/// `get_referenced_capability(kind="Shell", ...)`: the first `Shell` Kind
/// referenced into `namespace` whose name matches, in Kind-id order.
async fn referenced_shell_json<M>(
    mysql: &M,
    shell_name: &str,
    user_id: i32,
    namespace: &str,
) -> anyhow::Result<Option<Json>>
where
    M: Mysql + Sync,
{
    let mut by_namespace = list_referenced_capabilities_by_namespace(
        mysql,
        SHELL_KIND,
        user_id,
        &[namespace.to_string()],
    )
    .await?;
    Ok(by_namespace
        .remove(namespace)
        .unwrap_or_default()
        .into_iter()
        .find(|row| row.name.as_str() == shell_name)
        .map(|row| row.json.0))
}

fn parse_shell_spec(shell_json: &Json, shell_name: &str) -> anyhow::Result<(Vec<String>, String)> {
    let Some(spec) = shell_json
        .as_object()
        .and_then(|root| root.get("spec"))
        .and_then(Json::as_object)
    else {
        return Ok((Vec::new(), shell_name.to_string()));
    };
    let shell_type = spec
        .get("shellType")
        .or_else(|| spec.get("runtime"))
        .and_then(Json::as_str)
        .unwrap_or(shell_name)
        .to_string();
    let support_model = spec
        .get("supportModel")
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Json::as_str)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok((support_model, shell_type))
}

#[cfg(test)]
mod shell_lookup_contracts {
    use super::*;

    /// `find_shell_json` reads the CRD payload alone (`db.query(Kind.json)`)
    /// and stops at the first row (`.first()` -> `LIMIT 1`).
    fn assert_shell_statement(sql: &str, bound_parameters: usize) {
        let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            normalized.starts_with("SELECT json FROM kinds WHERE "),
            "single-column projection: {normalized}"
        );
        assert!(
            normalized.ends_with("LIMIT 1"),
            "first-row pagination: {normalized}"
        );
        assert_eq!(
            normalized.matches('?').count(),
            bound_parameters,
            "bound parameters: {normalized}"
        );
    }

    #[test]
    fn public_shell_lookup_matches_find_shell_json() {
        assert_shell_statement(SHELL_JSON_PUBLIC_SQL, 1);
        let normalized = SHELL_JSON_PUBLIC_SQL
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            normalized,
            "SELECT json FROM kinds WHERE user_id = 0 AND kind = 'Shell' AND name = ? \
             AND is_active = true LIMIT 1",
        );
    }

    #[test]
    fn personal_shell_lookup_matches_find_shell_json() {
        assert_shell_statement(SHELL_JSON_PERSONAL_SQL, 2);
        let normalized = SHELL_JSON_PERSONAL_SQL
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            normalized,
            "SELECT json FROM kinds WHERE user_id = ? AND kind = 'Shell' AND name = ? \
             AND namespace = 'default' AND is_active = true LIMIT 1",
        );
    }

    /// `find_shell_json` group branch: the `namespace` filter replaces the
    /// owner filter, and the lookup still stops at the first row.
    #[test]
    fn group_shell_lookup_matches_find_shell_json() {
        assert_shell_statement(SHELL_JSON_GROUP_SQL, 2);
        let normalized = SHELL_JSON_GROUP_SQL
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            normalized,
            "SELECT json FROM kinds WHERE kind = 'Shell' AND name = ? \
             AND namespace = ? AND is_active = true LIMIT 1",
        );
    }
}
