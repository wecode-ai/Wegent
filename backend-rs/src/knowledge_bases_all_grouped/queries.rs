// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Repository queries for `GET /api/knowledge-bases/all-grouped`: the
//! SQLAlchemy-rendered SELECT templates of the source service, plus the
//! direct-access filter predicate built by
//! `apply_direct_access_filter`.
use std::collections::HashMap;

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Deserialize;

use super::py_order::PyStrSetOrder;
use super::{
    APPROVED_STATUSES, CountRow, IdRow, KB_RESOURCE_TYPES, KIND_COLUMNS, KindRow, MEMBER_COLUMNS,
    MemberRow, NAMESPACE_COLUMNS, NamespaceIdRow, NamespaceNameRow, NamespaceRow, UserNameRow,
    has_permission, quote_literal,
};

// ---------------------------------------------------------------------------
// Repository queries
// ---------------------------------------------------------------------------

/// A single entry of the `users.git_info` JSON payload. The response never
/// reads the payload; the typed model only needs to decode every recorded
/// shape (`null` and arrays of git-account objects), and serde ignores the
/// keys this struct does not declare.
#[derive(Debug, Deserialize)]
struct GitAccount {
    #[allow(dead_code)]
    #[serde(default)]
    id: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    git_login: Option<String>,
}

/// The `users.git_info` JSON payload: JSON `null`, or an array of git
/// accounts. The grouped response never reads it.
type UserGitInfo = Option<Vec<GitAccount>>;

/// `_get_user_or_raise` (`db.query(User).filter(User.id == ...)`).
pub(super) async fn user_by_id<M>(mysql: &M, user_id: i64) -> MysqlResult<Option<(i64, String)>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        users_id: i64,
        #[allow(dead_code)]
        users_user_name: String,
        #[allow(dead_code)]
        #[mysql(rename = "users_password_hash")]
        users_password_hash: String,
        #[allow(dead_code)]
        users_email: Option<String>,
        #[allow(dead_code)]
        users_git_info: Json<UserGitInfo>,
        #[allow(dead_code)]
        users_is_active: i64,
        #[mysql(rename = "users_role")]
        users_role: String,
        #[allow(dead_code)]
        users_auth_source: String,
        #[allow(dead_code)]
        users_preferences: String,
        #[allow(dead_code)]
        users_created_at: NaiveDateTime,
        #[allow(dead_code)]
        users_updated_at: NaiveDateTime,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT users.id AS users_id, users.user_name AS users_user_name, \
                 users.password_hash AS users_password_hash, users.email AS users_email, \
                 users.git_info AS users_git_info, users.is_active AS users_is_active, \
                 users.`role` AS users_role, users.auth_source AS users_auth_source, \
                 users.preferences AS users_preferences, users.created_at AS users_created_at, \
                 users.updated_at AS users_updated_at \nFROM users \n\
                 WHERE users.id = {user_id} \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| (row.users_id, row.users_role)))
}

/// `get_user_group_roles` step 1: all active namespace names.
pub(super) async fn active_namespace_names<M>(mysql: &M) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let rows: Vec<NamespaceNameRow> = mysql
        .fetch_all(
            "SELECT namespace.name AS namespace_name \nFROM namespace \n\
             WHERE namespace.is_active IS true",
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.namespace_name).collect())
}

/// `_get_organization_names`.
pub(super) async fn organization_namespace_names<M>(mysql: &M) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let rows: Vec<NamespaceNameRow> = mysql
        .fetch_all(
            "SELECT namespace.name AS namespace_name \nFROM namespace \n\
             WHERE namespace.level = 'organization' AND namespace.is_active IS true",
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.namespace_name).collect())
}

/// `_get_accessible_namespace_ids` — ids of the named active namespaces.
/// The empty-list rendering keeps SQLAlchemy's `(1 != 1)` guard.
pub(super) async fn accessible_namespace_ids<M>(
    mysql: &M,
    names: &[String],
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    let names_filter = if names.is_empty() {
        "namespace.name IN (NULL) AND (1 != 1)".to_string()
    } else {
        format!(
            "namespace.name IN ({})",
            names
                .iter()
                .map(|name| quote_literal(name))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let rows: Vec<NamespaceIdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT namespace.id AS namespace_id \nFROM namespace \n\
                 WHERE {names_filter} AND namespace.is_active IS true"
            ),
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.namespace_id).collect())
}

/// `iter_user_groups_with_roles` step 1: direct user memberships
/// (`db.query(ResourceMember)` full projection).
pub(super) async fn direct_namespace_memberships<M>(
    mysql: &M,
    user_id: i64,
) -> MysqlResult<Vec<MemberRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{user_id}' \
                 AND resource_members.status = 'approved'"
            ),
            (),
        )
        .await
}

/// `Namespace.id.in_(ids), is_active` (`namespaces_by_ids`).
pub(super) async fn namespaces_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<NamespaceRow>>
where
    M: Mysql,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let joined = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \n\
                 WHERE namespace.id IN ({joined}) AND namespace.is_active = 1"
            ),
            (),
        )
        .await
}

/// `NamespaceEntityResolver` step 1: direct ns resource ids.
pub(super) async fn direct_namespace_resource_ids<M>(
    mysql: &M,
    user_id: i64,
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    let rows: Vec<IdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{user_id}' \
                 AND resource_members.status = 'approved'"
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// `NamespaceEntityResolver` tail: namespace-entity grants over the
/// combined ns ids.
pub(super) async fn namespace_entity_resource_ids<M>(
    mysql: &M,
    ns_ids: &[i64],
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if ns_ids.is_empty() {
        return Ok(Vec::new());
    }
    let quoted = ns_ids
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let rows: Vec<IdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type IN ('Namespace') \
                 AND resource_members.entity_type = 'namespace' \
                 AND resource_members.entity_id IN ({quoted}) \
                 AND resource_members.status = 'approved'"
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// SQLAlchemy rendering of the `Namespace.is_active` filter: `== True`
/// renders `= true`, `is_(True)` renders `IS true`.
pub(super) enum NamespaceActiveForm {
    IsTrue,
    EqualsTrue,
}

/// `Namespace.name.in_(names), is_active` full rows.
///
/// `active_form` selects the SQLAlchemy rendering: the service's
/// `Namespace.is_active == True` renders `= true`, while the visibility
/// helper's `Namespace.is_active.is_(True)` renders `IS true`. The recorded
/// exchanges carry both forms at different call sites.
pub(super) async fn namespaces_by_names<M>(
    mysql: &M,
    names: &[String],
    active_form: NamespaceActiveForm,
) -> MysqlResult<Vec<NamespaceRow>>
where
    M: Mysql,
{
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let quoted = names
        .iter()
        .map(|value| quote_literal(value))
        .collect::<Vec<_>>()
        .join(", ");
    let is_active = match active_form {
        NamespaceActiveForm::IsTrue => "IS true",
        NamespaceActiveForm::EqualsTrue => "= true",
    };
    mysql
        .fetch_all(
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \n\
                 WHERE namespace.name IN ({quoted}) AND namespace.is_active {is_active}"
            ),
            (),
        )
        .await
}

/// The direct KB member rows of the user
/// (`direct_member_query` in `build_direct_access_permission_context`).
pub(super) async fn direct_kb_members<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<MemberRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{user_id}' \
                 AND resource_members.status IN {APPROVED_STATUSES}"
            ),
            (),
        )
        .await
}

/// `collect_entity_authorized_kbs`: the namespace-entity KB member rows
/// over the user's accessible namespaces.
pub(super) async fn namespace_entity_kb_members<M>(
    mysql: &M,
    ns_ids: &[i64],
) -> MysqlResult<Vec<MemberRow>>
where
    M: Mysql,
{
    if ns_ids.is_empty() {
        return Ok(Vec::new());
    }
    let quoted = ns_ids
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
                 AND resource_members.entity_type = 'namespace' \
                 AND resource_members.entity_id IN ({quoted}) \
                 AND resource_members.status IN {APPROVED_STATUSES}"
            ),
            (),
        )
        .await
}

/// `kinds` KnowledgeBase batch by filter (`ORDER BY kinds.updated_at DESC`).
pub(super) async fn kinds_by_filter<M>(mysql: &M, where_clause: &str) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE {where_clause} \
                 ORDER BY kinds.updated_at DESC"
            ),
            (),
        )
        .await
}

/// `apply_direct_access_filter`: the rendered `kinds.id` predicate.
///
/// `editable_group_names` renders the source's `context.group_roles`
/// insertion order: `get_effective_roles_in_groups` builds its dict by
/// iterating `dict.fromkeys(group_names)` — the sorted non-organization
/// group names — so the `kinds.namespace IN` list preserves that order.
/// `accessible_ns_ids` renders the source's `frozenset(str(...))` of the
/// namespace-id query rows: the CPython `set[str]` iteration order, which
/// `PyStrSetOrder` reproduces (see its documentation).
#[allow(clippy::too_many_arguments)]
pub(super) async fn filter_accessible_kb_ids<M>(
    mysql: &M,
    candidate_ids: &[i64],
    user_id: i64,
    accessible_ns_ids: &[i64],
    group_role_order: &[String],
    group_roles: &HashMap<String, String>,
    organization_names: &[String],
    user_role: &str,
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if candidate_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = candidate_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    // `edit_conditions`: creator, direct editable member, namespace-entity
    // editable member, external editable ids, editable group namespaces,
    // and the admin/organization rule.
    let mut edit_conditions = vec![
        format!("kinds.user_id = {user_id}"),
        format!(
            "(EXISTS (SELECT 1 \nFROM resource_members \n\
             WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
             AND resource_members.resource_id = kinds.id \
             AND resource_members.status IN {APPROVED_STATUSES} \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = '{user_id}' \
             AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer')))"
        ),
    ];
    if !accessible_ns_ids.is_empty() {
        // The source renders `context.accessible_namespace_ids` — a
        // `frozenset[str]` built from the namespace-id query rows — whose
        // iteration order is the CPython `set[str]` slot order.
        let ns_set = PyStrSetOrder::from_row_order(accessible_ns_ids);
        let quoted = ns_set
            .order()
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        edit_conditions.push(format!(
            "(EXISTS (SELECT 1 \nFROM resource_members \n\
             WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
             AND resource_members.resource_id = kinds.id \
             AND resource_members.status IN {APPROVED_STATUSES} \
             AND resource_members.entity_type = 'namespace' \
             AND resource_members.entity_id IN ({quoted}) \
             AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer')))"
        ));
    }
    let editable_group_quoted: Vec<String> = group_role_order
        .iter()
        .filter(|name| {
            group_roles
                .get(*name)
                .is_some_and(|role| has_permission(role, "Developer"))
        })
        .map(|name| quote_literal(name))
        .collect();
    if !editable_group_quoted.is_empty() {
        edit_conditions.push(format!(
            "kinds.namespace IN ({})",
            editable_group_quoted.join(", ")
        ));
    }
    if user_role == "admin" && !organization_names.is_empty() {
        let quoted = organization_names
            .iter()
            .map(|value| quote_literal(value))
            .collect::<Vec<_>>();
        edit_conditions.push(format!("kinds.namespace IN ({})", quoted.join(", ")));
    }
    let edit_or = edit_conditions.join(" OR ");

    let requirement = "coalesce(json_unquote(json_extract(kinds.json, \
         '$.spec.directAccessRequirement')), '')";
    let sql = format!(
        "SELECT kinds.id AS kinds_id \nFROM kinds \n\
         WHERE kinds.id IN ({ids}) AND ({requirement} = '' OR {requirement} = 'read' \
         OR {requirement} = 'edit' AND ({edit_or})) \
         AND NOT (EXISTS (SELECT 1 \nFROM resource_members \n\
         WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
         AND resource_members.resource_id = kinds.id \
         AND resource_members.status IN {APPROVED_STATUSES} \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = '{user_id}' \
         AND resource_members.`role` = 'RestrictedAnalyst'))"
    );

    #[derive(Debug, FromMysqlRow)]
    struct Row {
        kinds_id: i64,
    }
    let rows: Vec<Row> = mysql.fetch_all(&sql, ()).await?;
    Ok(rows.into_iter().map(|row| row.kinds_id).collect())
}

/// `get_document_counts` (`GROUP BY` with `count(...) AS count`).
pub(super) async fn document_counts<M>(mysql: &M, kb_ids: &[i64]) -> MysqlResult<HashMap<i64, i64>>
where
    M: Mysql,
{
    if kb_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let joined = kb_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let rows: Vec<CountRow> = mysql
        .fetch_all(
            &format!(
                "SELECT knowledge_documents.kind_id AS knowledge_documents_kind_id, \
                 count(knowledge_documents.id) AS count \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.kind_id IN ({joined}) \
                 GROUP BY knowledge_documents.kind_id"
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.knowledge_documents_kind_id, row.count))
        .collect())
}

/// `db.query(User.id, User.user_name).filter(id.in_(...))`.
pub(super) async fn user_names_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<UserNameRow>>
where
    M: Mysql,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let joined = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT users.id AS users_id, users.user_name AS users_user_name \n\
                 FROM users \nWHERE users.id IN ({joined})"
            ),
            (),
        )
        .await
}

/// Organization namespaces ordered by id
/// (`db.query(Namespace).filter(level, is_active).order_by(id)`).
pub(super) async fn organization_namespaces<M>(mysql: &M) -> MysqlResult<Vec<NamespaceRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \n\
                 WHERE namespace.level = 'organization' AND namespace.is_active = true \
                 ORDER BY namespace.id ASC"
            ),
            (),
        )
        .await
}

/// `get_namespace_id_by_name` (`name = ? AND is_active = 1 LIMIT 1`).
pub(super) async fn namespace_by_name_exact<M>(
    mysql: &M,
    name: &str,
) -> MysqlResult<Option<NamespaceRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \n\
                 WHERE namespace.name = {} AND namespace.is_active = 1 \n LIMIT 1",
                quote_literal(name)
            ),
            (),
        )
        .await
}

/// `get_group_member`: the direct approved user membership of one namespace.
pub(super) async fn group_member<M>(
    mysql: &M,
    namespace_id: i64,
    user_id: i64,
) -> MysqlResult<Option<MemberRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id = {namespace_id} \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{user_id}' \
                 AND resource_members.status = 'approved' \n LIMIT 1"
            ),
            (),
        )
        .await
}

/// `_resolve_entity_roles_in_namespace` ->
/// `resolve_entity_roles_for_resource`: non-user/non-namespace entity rows
/// of the namespace.
pub(super) async fn namespace_entity_roles<M>(
    mysql: &M,
    namespace_id: i64,
) -> MysqlResult<Vec<(String, String, String)>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_entity_type: String,
        resource_members_entity_id: String,
        resource_members_role: String,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.entity_type AS resource_members_entity_type, \
                 resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.`role` AS resource_members_role \nFROM resource_members \n\
                 WHERE resource_members.resource_type IN ('Namespace') \
                 AND resource_members.resource_id = {namespace_id} \
                 AND (resource_members.entity_type NOT IN ('', 'user', 'namespace')) \
                 AND resource_members.entity_id IS NOT NULL \
                 AND resource_members.status IN ('approved')"
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.resource_members_entity_type,
                row.resource_members_entity_id,
                row.resource_members_role,
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_git_info_decodes_recorded_shapes() {
        // Some users store JSON null in `users.git_info`.
        let null_payload: UserGitInfo = serde_json::from_str("null").expect("null decodes");
        assert!(null_payload.is_none());

        // Other users store an array of git-account objects.
        let accounts: UserGitInfo = serde_json::from_str(
            r#"[{"id": "10000001", "type": "gitlab", "git_id": "1001", "auth_type": null, "git_email": "e", "git_login": "zhangsan", "git_token": "***", "user_id": 1002}]"#,
        )
        .expect("account array decodes");
        let accounts = accounts.expect("array is Some");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id.as_deref(), Some("10000001"));
        assert_eq!(accounts[0].git_login.as_deref(), Some("zhangsan"));
    }
}
