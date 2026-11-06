// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The group-member reads behind `group_permission.get_effective_role_in_group`
//! (`get_namespace_id_by_name` and `get_group_member`), on the pooled service
//! and on a caller-owned request handle.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use super::quote_literal;

/// `namespace` full projection constant (`db.query(Namespace)`).
const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, \
     namespace.name AS namespace_name, namespace.display_name AS namespace_display_name, \
     namespace.owner_user_id AS namespace_owner_user_id, \
     namespace.visibility AS namespace_visibility, \
     namespace.description AS namespace_description, \
     namespace.level AS namespace_level, namespace.is_active AS namespace_is_active, \
     namespace.created_at AS namespace_created_at, \
     namespace.updated_at AS namespace_updated_at";

/// `get_namespace_id_by_name` (full `Namespace` projection, `LIMIT 1`).
pub(super) async fn namespace_id_by_name<M>(mysql: &M, group_name: &str) -> MysqlResult<Option<i64>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        namespace_id: i64,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \
                 FROM namespace \
                 WHERE namespace.name = {} AND namespace.is_active = 1 \
                 LIMIT 1",
                quote_literal(group_name)
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| row.namespace_id))
}

/// `get_group_member` (full `ResourceMember` projection, `LIMIT 1`). Shared
/// with the task-skills group-member cache fallback.
pub(crate) async fn direct_member_role<M>(
    mysql: &M,
    user_id: i32,
    group_name: &str,
) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    let Some(namespace_id) = namespace_id_by_name(mysql, group_name).await? else {
        return Ok(None);
    };
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "resource_members_role")]
        role: Option<String>,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT {} \
                 FROM resource_members \
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id = {namespace_id} \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{}' \
                 AND resource_members.status = 'approved' \
                 LIMIT 1",
                crate::teams::teams_repository::MEMBER_COLUMNS,
                user_id
            ),
            (),
        )
        .await?;
    Ok(row.and_then(|row| row.role))
}

/// [`direct_member_role`] on the caller's request SQL handle: the namespace id
/// and the member row both run on `sql`, so the group membership read keeps
/// the source's transaction membership.
pub(crate) async fn direct_member_role_on(
    sql: &mut dyn crate::request_sql::RequestSql,
    user_id: i32,
    group_name: &str,
) -> MysqlResult<Option<String>> {
    let Some(namespace_id) = namespace_id_by_name_on(sql, group_name).await? else {
        return Ok(None);
    };
    let row = sql
        .fetch_optional_row(
            crate::request_sql::RouteKey::None,
            &format!(
                "SELECT {} \
                 FROM resource_members \
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id = {namespace_id} \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{}' \
                 AND resource_members.status = 'approved' \
                 LIMIT 1",
                crate::teams::teams_repository::MEMBER_COLUMNS,
                user_id
            ),
            Vec::new(),
        )
        .await?;
    match row {
        Some(row) => Ok(row.get::<String>("resource_members_role")?),
        None => Ok(None),
    }
}

/// [`namespace_id_by_name`] on the caller's request SQL handle.
pub(super) async fn namespace_id_by_name_on(
    sql: &mut dyn crate::request_sql::RequestSql,
    group_name: &str,
) -> MysqlResult<Option<i64>> {
    let row = sql
        .fetch_optional_row(
            crate::request_sql::RouteKey::None,
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \
                 FROM namespace \
                 WHERE namespace.name = {} AND namespace.is_active = 1 \
                 LIMIT 1",
                quote_literal(group_name)
            ),
            Vec::new(),
        )
        .await?;
    match row {
        Some(row) => Ok(Some(row.get_required::<i64>("namespace_id")?)),
        None => Ok(None),
    }
}
