// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `get_shell_by_name` for the readiness check.
//!
//! Mirrors `app/services/adapters/shell_utils.py::get_shell_by_name`, which
//! resolves a Shell through direct `kinds` / `resource_members` SQL in the
//! source order: the personal Shell, a referenced (shared) Shell, a group
//! Shell for a non-`default` namespace the user belongs to, then the public
//! Shell. Unlike the `kindReader` bot/ghost lookups this path never touches
//! the `kind:v2:*` cache, so it issues no Redis reads or writes.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use crate::v1_resources::repository::{KIND_COLUMNS, OwnedKindRow};

/// `db.query(Kind).filter(Kind.user_id == user_id, Kind.kind == "Shell",
/// Kind.name == shell_name, Kind.namespace == namespace,
/// Kind.is_active == True).first()`.
pub async fn personal_shell<M>(
    mysql: &M,
    name: &str,
    user_id: i64,
    namespace: &str,
) -> MysqlResult<Option<OwnedKindRow>>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.user_id = ? AND kinds.kind = 'Shell' AND kinds.name = ? \
         AND kinds.namespace = ? AND kinds.is_active = true \
         LIMIT 1"
    );
    mysql
        .fetch_optional(sql.as_str(), (user_id, name, namespace))
        .await
}

/// `get_referenced_capability(kind="Shell")`: the approved referenced Shells
/// visible to the caller, filtered to `name` exactly as the source's
/// `source.name == name` test does.
pub async fn referenced_shell<M>(
    mysql: &M,
    name: &str,
    user_id: i64,
    namespace: &str,
) -> MysqlResult<Option<OwnedKindRow>>
where
    M: Mysql,
{
    let (entity_type, entity_id) = if namespace == "default" {
        ("user", user_id.to_string())
    } else {
        let Some(namespace_id) = namespace_id(mysql, namespace).await? else {
            return Ok(None);
        };
        ("namespace", namespace_id.to_string())
    };
    let sql = format!(
        "SELECT resource_members.entity_type AS resource_members_entity_type, \
         resource_members.entity_id AS resource_members_entity_id, {KIND_COLUMNS} \
         FROM resource_members \
         INNER JOIN kinds ON kinds.id = resource_members.resource_id \
         WHERE resource_members.resource_type = 'Shell' \
         AND resource_members.status = 'approved' \
         AND resource_members.entity_type = '{entity_type}' \
         AND resource_members.entity_id IN (?) \
         AND kinds.kind = 'Shell' AND kinds.user_id != 0 AND kinds.is_active IS true \
         ORDER BY kinds.id"
    );
    let rows: Vec<OwnedKindRow> = mysql.fetch_all(sql.as_str(), (entity_id.as_str(),)).await?;
    Ok(rows.into_iter().find(|row| row.name == name))
}

/// `get_shell_by_name`'s group branch for a non-`default` namespace.
pub async fn group_shell<M>(
    mysql: &M,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<OwnedKindRow>>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = 'Shell' AND kinds.name = ? AND kinds.namespace = ? \
         AND kinds.is_active = true \
         LIMIT 1"
    );
    mysql.fetch_optional(sql.as_str(), (name, namespace)).await
}

/// `get_shell_by_name`'s public branch: `user_id = 0` in namespace `default`.
pub async fn public_shell<M>(mysql: &M, name: &str) -> MysqlResult<Option<OwnedKindRow>>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.user_id = 0 AND kinds.kind = 'Shell' AND kinds.name = ? \
         AND kinds.namespace = 'default' AND kinds.is_active = true \
         LIMIT 1"
    );
    mysql.fetch_optional(sql.as_str(), (name,)).await
}

/// `list_referenced_capabilities_by_namespace`'s namespace-name lookup for a
/// non-`default` reference scope.
async fn namespace_id<M>(mysql: &M, namespace: &str) -> MysqlResult<Option<i64>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct NamespaceRow {
        #[mysql(rename = "namespace_id")]
        id: i64,
        #[mysql(rename = "namespace_name")]
        name: String,
    }
    let sql = "SELECT namespace.id AS namespace_id, namespace.name AS namespace_name \
               FROM namespace \
               WHERE namespace.name IN (?) AND namespace.is_active IS true";
    let rows: Vec<NamespaceRow> = mysql.fetch_all(sql, (namespace,)).await?;
    Ok(rows
        .into_iter()
        .find(|row| row.name == namespace)
        .map(|row| row.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    /// `get_shell_by_name`'s personal step is direct SQL binding the integer
    /// owner id; it must not touch the `kind:v2:*` cache.
    #[tokio::test]
    async fn personal_shell_binds_the_owner_id_without_the_cache() {
        let mysql = KindQueryCapture::default();
        let shell = personal_shell(&mysql, "ClaudeCode", 157, "default")
            .await
            .unwrap();
        assert!(shell.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains(
            "WHERE kinds.user_id = ? AND kinds.kind = 'Shell' AND kinds.name = ? \
             AND kinds.namespace = ? AND kinds.is_active = true LIMIT 1"
        ));
        assert_eq!(queries[0].args, 3);
        assert_eq!(queries[0].first_integer, Some(157));
    }

    /// The referenced-Shell step reproduces `list_referenced_capabilities`'s
    /// join for the caller's `user` scope.
    #[tokio::test]
    async fn referenced_shell_reads_the_approved_user_reference() {
        let mysql = KindQueryCapture::default();
        let shell = referenced_shell(&mysql, "Chat", 157, "default")
            .await
            .unwrap();
        assert!(shell.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        let sql = &queries[0].sql;
        assert!(sql.contains("INNER JOIN kinds ON kinds.id = resource_members.resource_id"));
        assert!(sql.contains("resource_members.resource_type = 'Shell'"));
        assert!(sql.contains("resource_members.entity_type = 'user'"));
        assert!(sql.contains("resource_members.entity_id IN (?)"));
        assert!(sql.contains("kinds.user_id != 0 AND kinds.is_active IS true ORDER BY kinds.id"));
        assert_eq!(queries[0].args, 1);
    }

    /// The public step reads `user_id = 0` in namespace `default` directly.
    #[tokio::test]
    async fn public_shell_reads_the_default_namespace() {
        let mysql = KindQueryCapture::default();
        let shell = public_shell(&mysql, "Chat").await.unwrap();
        assert!(shell.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains(
            "WHERE kinds.user_id = 0 AND kinds.kind = 'Shell' AND kinds.name = ? \
             AND kinds.namespace = 'default' AND kinds.is_active = true LIMIT 1"
        ));
    }
}
