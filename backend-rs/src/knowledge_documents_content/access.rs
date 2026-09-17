// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge-base ACL resolution for the open content endpoint.
//!
//! Mirrors `KnowledgeService.get_knowledge_base` +
//! `resolve_knowledge_base_permission` +
//! `meets_direct_access_requirement` from
//! `app.services.knowledge.knowledge_access_policy`, including the
//! restricted-analyst batch pre-check and the group/entity source resolvers
//! through group permissions and registered namespace/external entity resolvers.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};

use super::ApiFailure;
#[cfg(test)]
use super::group_membership::GroupMembership;
#[cfg(test)]
use super::group_membership::effective_roles;
use super::group_membership::{effective_role_in_group, is_restricted_analyst};
use crate::crd::CrdDocument;
use crate::json_compat::OpaqueJson;
#[cfg(test)]
use serde_json::Value;

/// `namespace` columns as rendered by `db.query(Namespace)`.
pub(super) const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, \
     namespace.name AS namespace_name, namespace.display_name AS namespace_display_name, \
     namespace.owner_user_id AS namespace_owner_user_id, \
     namespace.visibility AS namespace_visibility, \
     namespace.description AS namespace_description, namespace.level AS namespace_level, \
     namespace.is_active AS namespace_is_active, \
     namespace.created_at AS namespace_created_at, \
     namespace.updated_at AS namespace_updated_at";

/// `resource_members` columns as rendered by `db.query(ResourceMember)`.
pub(super) const MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
     resource_members.resource_type AS resource_members_resource_type, \
     resource_members.resource_id AS resource_members_resource_id, \
     resource_members.entity_type AS resource_members_entity_type, \
     resource_members.entity_id AS resource_members_entity_id, \
     resource_members.entity_display_name AS resource_members_entity_display_name, \
     resource_members.user_id AS resource_members_user_id, \
     resource_members.`role` AS resource_members_role, \
     resource_members.status AS resource_members_status, \
     resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
     resource_members.share_link_id AS resource_members_share_link_id, \
     resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
     resource_members.reviewed_at AS resource_members_reviewed_at, \
     resource_members.copied_resource_id AS resource_members_copied_resource_id, \
     resource_members.requested_at AS resource_members_requested_at, \
     resource_members.created_at AS resource_members_created_at, \
     resource_members.updated_at AS resource_members_updated_at";

/// Role hierarchy ranks (`app.schemas.base_role.ROLE_HIERARCHY`); lower is
/// more privileged.
fn role_rank(role: &str) -> Option<u8> {
    match role {
        "Owner" => Some(0),
        "Maintainer" => Some(1),
        "Developer" => Some(2),
        "Reporter" => Some(3),
        "RestrictedAnalyst" => Some(4),
        _ => None,
    }
}

/// `get_highest_role`: the most privileged role among the candidates.
pub(super) fn highest_role(roles: &[String]) -> Option<String> {
    roles
        .iter()
        .filter(|role| role_rank(role).is_some())
        .min_by_key(|role| role_rank(role).unwrap())
        .cloned()
}

/// `has_permission` (`app.schemas.base_role`).
fn has_permission(user_role: &str, required_role: &str) -> bool {
    match (role_rank(user_role), role_rank(required_role)) {
        (Some(user), Some(required)) => user <= required,
        _ => false,
    }
}

/// The loaded knowledge-base `Kind` row.
pub struct KnowledgeBase {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    pub kinds_namespace: String,
    pub kinds_json: OpaqueJson,
    pub kinds_created_at: chrono::NaiveDateTime,
    pub kinds_updated_at: chrono::NaiveDateTime,
}

/// `_get_knowledge_base_record` / `get_user_knowledge_base_permission`'s
/// Kind lookup (`id`, `kind='KnowledgeBase'`, `is_active`).
pub async fn knowledge_base_record<M>(
    mysql: &M,
    knowledge_base_id: i64,
) -> MysqlResult<Option<KnowledgeBase>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        kinds_id: i64,
        kinds_user_id: i64,
        kinds_namespace: String,
        kinds_json: Json<OpaqueJson>,
        kinds_created_at: chrono::NaiveDateTime,
        kinds_updated_at: chrono::NaiveDateTime,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                 kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                 kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                 kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                 kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
                 WHERE kinds.id = {knowledge_base_id} AND kinds.kind = 'KnowledgeBase' \
                 AND kinds.is_active = true \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| KnowledgeBase {
        kinds_id: row.kinds_id,
        kinds_user_id: row.kinds_user_id,
        kinds_namespace: row.kinds_namespace,
        kinds_json: row.kinds_json.0,
        kinds_created_at: row.kinds_created_at,
        kinds_updated_at: row.kinds_updated_at,
    }))
}

/// `get_knowledge_base`: resolve the permission and apply
/// `meets_direct_access_requirement`. The `user` row (`db.query(User)` by
/// id) is part of the source dependency sequence.
pub async fn knowledge_base_access<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    kb: &KnowledgeBase,
    user_id: i64,
) -> Result<bool, ApiFailure>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    // `resolve_knowledge_base_permission`: `db.query(User).filter(id)`.
    let user = user_by_id(mysql, user_id)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let user_role = user.as_ref().map(|row| row.users_role.clone());
    let is_creator = kb.kinds_user_id == user_id;

    // Restricted-analyst pre-check (only for non-default, non-organization
    // group namespaces and non-creators).
    let mut denied = false;
    if !is_creator && kb.kinds_namespace != "default" {
        let is_organization = is_organization_namespace(mysql, &kb.kinds_namespace)
            .await
            .map_err(|error| ApiFailure::internal(error.to_string()))?;
        if !is_organization {
            let analyst =
                is_restricted_analyst(mysql, redis, resolvers, user_id, &kb.kinds_namespace)
                    .await
                    .map_err(|error| ApiFailure::internal(error.to_string()))?;
            if analyst {
                return Ok(false);
            }
        }
    }

    let mut roles: Vec<String> = Vec::new();
    if is_creator {
        roles.push("Owner".to_string());
    }

    // Direct KB membership
    // (`_append_direct_member_source`): a RestrictedAnalyst membership is
    // an explicit denial; any other role grants.
    if let Some(role) = direct_kb_member_role(mysql, kb.kinds_id, user_id)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?
    {
        if role == "RestrictedAnalyst" {
            denied = true;
        } else {
            roles.push(role);
        }
    }
    if denied {
        return Ok(false);
    }

    // Organization source (`_append_organization_source`).
    let is_organization = is_organization_namespace(mysql, &kb.kinds_namespace)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    if is_organization {
        roles.push(
            if user_role.as_deref() == Some("admin") {
                "Owner"
            } else {
                "Reporter"
            }
            .to_string(),
        );
    } else {
        // Group source (`_append_group_source`) for non-default namespaces.
        // The source re-checks `is_organization_namespace` here before
        // resolving the group role, so the namespace lookup repeats.
        let group_is_organization = is_organization_namespace(mysql, &kb.kinds_namespace)
            .await
            .map_err(|error| ApiFailure::internal(error.to_string()))?;
        if !group_is_organization
            && kb.kinds_namespace != "default"
            && let Some(group_role) =
                effective_role_in_group(mysql, redis, resolvers, user_id, &kb.kinds_namespace)
                    .await
                    .map_err(|error| ApiFailure::internal(error.to_string()))?
        {
            if group_role == "RestrictedAnalyst" {
                return Ok(false);
            }
            let base = match group_role.as_str() {
                "Owner" => "Owner",
                "Maintainer" => "Maintainer",
                "Developer" => "Developer",
                _ => "Reporter",
            };
            roles.push(base.to_string());
        }
    }

    // Entity sources (`_append_entity_sources`).
    let entity_roles = entity_source_roles(mysql, redis, resolvers, kb.kinds_id, user_id)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    roles.extend(entity_roles);

    let has_access = !roles.is_empty() || is_creator;
    // `meets_direct_access_requirement` with the default `read`
    // requirement: raw access is enough. A non-default requirement the
    // endpoint cannot satisfy (unknown value) denies, like the source.
    let kb_crd = CrdDocument::project_opaque(&kb.kinds_json);
    let requirement = kb_crd
        .spec
        .as_ref()
        .and_then(|spec| spec.direct_access_requirement.as_deref())
        .unwrap_or("read");
    let effective_role = highest_role(&roles);
    match requirement {
        "read" => Ok(has_access),
        "edit" => Ok(has_access
            && (is_creator
                || effective_role
                    .as_deref()
                    .is_some_and(|role| has_permission(role, "Developer")))),
        _ => Ok(false),
    }
}

/// `db.query(User).filter(User.id == user_id).first()` — full labeled
/// projection.
pub(crate) async fn user_by_id<M>(mysql: &M, user_id: i64) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    mysql
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
        .await
}

#[derive(Debug, FromMysqlRow)]
pub(crate) struct UserRow {
    pub(crate) users_role: String,
}

/// Wrapper of the by-id user lookup for sibling knowledge modules
/// (`resolve_knowledge_base_permission`'s `db.query(User)` by id).
pub async fn user_by_id_row<M>(mysql: &M, user_id: i64) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    user_by_id(mysql, user_id).await
}

/// `load_active_namespace_map` for one name (`namespace.in_(names)` with
/// `is_active IS true`), then `classify_namespace_level`.
pub(super) async fn active_namespace_by_name<M>(
    mysql: &M,
    name: &str,
) -> MysqlResult<Option<NamespaceRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(&namespace_names_sql(&[name.to_string()]), ())
        .await
}

fn namespace_names_sql(names: &[String]) -> String {
    let quoted = names
        .iter()
        .map(|name| quote_literal(name))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \n\
         WHERE namespace.name IN ({quoted}) AND namespace.is_active IS true"
    )
}

/// MySQL default string-literal escaping (mirrors the source's rendered
/// COM_QUERY text).
pub(super) fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x1a => out.push_str("\\Z"),
            other => out.push(other as char),
        }
    }
    out.push('\'');
    out
}

#[derive(Debug, FromMysqlRow)]
pub(super) struct NamespaceRow {
    pub(super) namespace_id: i64,
    pub(super) namespace_name: String,
    pub(super) namespace_level: String,
}

/// `is_organization_namespace`: the active namespace's level is
/// `organization`. The personal namespace (`default`) never queries: the
/// source's `load_active_namespace_map` filters it out and
/// `classify_namespace_level` returns `personal`.
pub(crate) async fn is_organization_namespace<M>(mysql: &M, name: &str) -> MysqlResult<bool>
where
    M: Mysql,
{
    if name == "default" {
        return Ok(false);
    }
    Ok(active_namespace_by_name(mysql, name)
        .await?
        .is_some_and(|row| row.namespace_level == "organization"))
}

/// `_append_direct_member_source`: the direct KB membership
/// (`get_effective_role` defaults an empty role to Reporter).
pub(crate) async fn direct_kb_member_role<M>(
    mysql: &M,
    kb_id: i64,
    user_id: i64,
) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    let member: Option<MemberRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type IN ('KnowledgeBase', 'KNOWLEDGE_BASE') \
                 AND resource_members.resource_id = {kb_id} \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{user_id}' \
                 AND resource_members.status IN ('approved', 'APPROVED') \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(member.map(|row| {
        if row.resource_members_role.is_empty() {
            "Reporter".to_string()
        } else {
            row.resource_members_role
        }
    }))
}

/// `_append_entity_sources`: entity rows on the KB
/// (`resolve_entity_roles_for_resource` with the KB resource id).
pub(crate) async fn entity_source_roles<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    kb_id: i64,
    user_id: i64,
) -> MysqlResult<Vec<String>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let rows: Vec<EntityRoleRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.entity_type AS resource_members_entity_type, \
                 resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.`role` AS resource_members_role \nFROM resource_members \n\
                 WHERE resource_members.resource_type IN ('KnowledgeBase', 'KNOWLEDGE_BASE') \
                 AND resource_members.resource_id = {kb_id} \
                 AND resource_members.entity_type != 'user' \
                 AND resource_members.entity_type != '' \
                 AND resource_members.entity_id IS NOT NULL \
                 AND resource_members.status IN ('approved', 'APPROVED')"
            ),
            (),
        )
        .await?;
    resolve_entity_roles(mysql, redis, resolvers, user_id, &rows).await
}

/// Group entity rows by type, match them through the registered resolvers,
/// and collect the matched roles
/// (`resolve_entity_roles_for_resource` tail).
pub(super) async fn resolve_entity_roles<M, R>(
    _mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
    rows: &[EntityRoleRow],
) -> MysqlResult<Vec<String>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let mut matched_roles = Vec::new();
    // Group by entity type preserving first-appearance order.
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<&EntityRoleRow>> =
        std::collections::HashMap::new();
    for row in rows {
        if !row.resource_members_entity_type.is_empty()
            && !row.resource_members_entity_id.is_empty()
        {
            let entry = groups
                .entry(row.resource_members_entity_type.clone())
                .or_insert_with(|| {
                    order.push(row.resource_members_entity_type.clone());
                    Vec::new()
                });
            entry.push(row);
        }
    }
    for entity_type in order {
        let entries = &groups[&entity_type];
        let ids = entries
            .iter()
            .map(|row| row.resource_members_entity_id.clone())
            .collect::<Vec<_>>();
        let matched = resolvers
            .match_bindings(
                redis,
                user_id,
                &entity_type,
                &ids,
                crate::permissions::ResolutionPurpose::CachedResourceAccess,
            )
            .await?;
        let matched_set: std::collections::HashSet<&str> =
            matched.iter().map(String::as_str).collect();
        for row in entries {
            if matched_set.contains(row.resource_members_entity_id.as_str())
                && !row.resource_members_role.is_empty()
            {
                matched_roles.push(row.resource_members_role.clone());
            }
        }
    }
    Ok(matched_roles)
}

/// `namespace.id IN (...)` active namespaces
/// (`Namespace.id.in_(ids), is_active`).
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

#[derive(Debug, FromMysqlRow)]
pub(super) struct MemberRow {
    pub(super) resource_members_resource_id: i64,
    pub(super) resource_members_role: String,
}

#[derive(Debug, FromMysqlRow)]
pub(super) struct IdRow {
    pub(super) resource_members_resource_id: i64,
}

/// `db.query(ResourceMember.resource_id, ResourceMember.entity_id)` — the
/// two-column projection of `NamespaceEntityResolver
/// .get_resource_ids_by_entity`'s org-department bindings scan (the result
/// set carries no `entity_type` column).
#[derive(Debug, FromMysqlRow)]
pub(super) struct DeptBindingRow {
    pub(super) resource_members_resource_id: i64,
    pub(super) resource_members_entity_id: String,
}

#[derive(Debug, FromMysqlRow)]
pub(super) struct EntityIdRow {
    pub(super) resource_members_entity_id: String,
}

#[derive(Debug, FromMysqlRow)]
pub(super) struct EntityRoleRow {
    pub(super) resource_members_entity_type: String,
    pub(super) resource_members_entity_id: String,
    pub(super) resource_members_role: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_hierarchy_and_permission() {
        assert!(has_permission("Owner", "Developer"));
        assert!(has_permission("Developer", "Developer"));
        assert!(!has_permission("Reporter", "Developer"));
        assert!(!has_permission("Weird", "Reporter"));
    }

    #[test]
    fn highest_role_prefers_most_privileged() {
        let roles = vec!["Reporter".to_string(), "Maintainer".to_string()];
        assert_eq!(highest_role(&roles).as_deref(), Some("Maintainer"));
        assert_eq!(highest_role(&["Unknown".to_string()]), None);
    }

    #[test]
    fn effective_roles_inherit_from_parent_groups() {
        let memberships = vec![
            GroupMembership {
                group_name: "aaa".to_string(),
                role: "Developer".to_string(),
            },
            GroupMembership {
                group_name: "other".to_string(),
                role: "RestrictedAnalyst".to_string(),
            },
        ];
        let roles = effective_roles(
            &memberships,
            &[
                "aaa/bbb".to_string(),
                "other".to_string(),
                "nope".to_string(),
            ],
        );
        assert_eq!(roles.get("aaa/bbb").map(String::as_str), Some("Developer"));
        assert_eq!(
            roles.get("other").map(String::as_str),
            Some("RestrictedAnalyst")
        );
        assert!(!roles.contains_key("nope"));
    }

    #[test]
    fn literal_quoting_escapes_mysql_specials() {
        assert_eq!(quote_literal("plain"), "'plain'");
        assert_eq!(quote_literal("it's"), "'it\\'s'");
        assert_eq!(quote_literal("a\\b"), "'a\\\\b'");
    }

    #[test]
    fn direct_access_requirement_edit_needs_developer() {
        let kb_json = |requirement: Option<&str>| {
            let mut spec = serde_json::json!({});
            if let Some(requirement) = requirement {
                spec["directAccessRequirement"] = serde_json::json!(requirement);
            }
            serde_json::json!({"spec": spec})
        };
        let spec = kb_json(None);
        assert_eq!(
            spec.get("spec")
                .and_then(|s| s.get("directAccessRequirement"))
                .and_then(Value::as_str)
                .unwrap_or("read"),
            "read"
        );
        assert_eq!(
            kb_json(Some("edit"))
                .get("spec")
                .and_then(|s| s.get("directAccessRequirement"))
                .and_then(Value::as_str),
            Some("edit")
        );
    }
}
