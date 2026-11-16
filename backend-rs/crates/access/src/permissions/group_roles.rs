// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/group_member_helper.py`: the user's group names and roles,
//! including entity-derived memberships, and the shared entity-match resource
//! read (`app/services/external_entity_resolver.py:list_resources_by_entity_match`).
//!
//! `iter_user_groups_with_roles` is reached by the create flow's ACL context
//! builder: the recorded `queued` case's `_build_all_query` carries a
//! `kinds.namespace IN (…)` group term and an organization term of the same
//! shape, both derived from the group-role map this module produces.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult, MysqlService};
use brz_redis::Redis;

use crate::namespace_projection::NAMESPACE_COLUMNS;

use super::{EntityResolvers, ResolutionPurpose};

/// `MemberStatus.APPROVED.value`.
const APPROVED_STATUS: &str = "approved";

/// One `iter_user_groups_with_roles` entry:
/// `(group_name, role, source_entity_type, source_entity_id)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRoleEntry {
    pub group_name: String,
    pub role: String,
    pub source_entity_type: Option<String>,
    pub source_entity_id: Option<String>,
}

#[derive(FromMysqlRow)]
struct DirectMembershipRow {
    resource_id: i64,
    role: String,
}

#[derive(FromMysqlRow)]
struct NamespaceRow {
    namespace_id: i64,
    namespace_name: String,
}

/// One full `ResourceMember` row (`group_member_helper.py:586-594`).
#[derive(FromMysqlRow)]
struct EntityMemberRow {
    #[mysql(rename = "resource_members_resource_id")]
    resource_id: i64,
    #[mysql(rename = "resource_members_entity_id")]
    entity_id: String,
    #[mysql(rename = "resource_members_role")]
    role: String,
}

/// `db.query(ResourceMember)`'s full projection, aliased per column.
const MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
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

#[derive(FromMysqlRow)]
struct ResourceIdRow {
    resource_id: i64,
}

/// `get_highest_role`: the most privileged role, `None` when the list is empty
/// or every role is unknown.
pub fn highest_role(roles: &[String]) -> Option<String> {
    let mut best: Option<&String> = None;
    let mut best_level = 999_u16;
    for role in roles {
        let level = crate::roles::role_level(role).map_or(999, u16::from);
        if level < best_level {
            best = Some(role);
            best_level = level;
        }
    }
    best.cloned()
}

/// The dedup tail of `iter_user_groups_with_roles`: one entry per group, the
/// highest role, and the first source that carried it.
pub fn dedupe_group_roles(entries: Vec<GroupRoleEntry>) -> Vec<GroupRoleEntry> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::BTreeMap<String, Vec<GroupRoleEntry>> =
        std::collections::BTreeMap::new();
    for entry in entries {
        groups
            .entry(entry.group_name.clone())
            .or_insert_with(|| {
                order.push(entry.group_name.clone());
                Vec::new()
            })
            .push(entry);
    }
    let mut result = Vec::with_capacity(order.len());
    for group_name in order {
        let members = groups.remove(&group_name).unwrap_or_default();
        let roles: Vec<String> = members.iter().map(|m| m.role.clone()).collect();
        let Some(highest) = highest_role(&roles) else {
            continue;
        };
        if let Some(winner) = members.into_iter().find(|entry| entry.role == highest) {
            result.push(winner);
        }
    }
    result
}

/// `list_resources_by_entity_match`: the distinct `resource_id`s of
/// `resource_type` whose `entity_type` bindings reference `matched_entity_ids`.
/// An empty `matched_entity_ids` returns before issuing SQL.
pub async fn list_resources_by_entity_match(
    mysql: &MysqlService,
    resource_type: &str,
    entity_type: &str,
    matched_entity_ids: &[String],
) -> MysqlResult<Vec<i64>> {
    if matched_entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; matched_entity_ids.len()].join(", ");
    let sql = format!(
        "SELECT DISTINCT resource_members.resource_id AS resource_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = ? \
         AND resource_members.entity_type = ? \
         AND resource_members.entity_id IN ({placeholders}) \
         AND resource_members.status = '{APPROVED_STATUS}'"
    );
    let mut args: Vec<String> = vec![resource_type.to_string(), entity_type.to_string()];
    args.extend(matched_entity_ids.iter().cloned());
    let rows: Vec<ResourceIdRow> = mysql.fetch_all(&sql, args).await?;
    Ok(rows.into_iter().map(|row| row.resource_id).collect())
}

/// `iter_user_groups_with_roles` step 2's entity-derived member read
/// (`group_member_helper.py:586-594`): every approved `Namespace` member row of
/// one entity type, with the Source's full `ResourceMember` projection.
fn entity_members_statement() -> String {
    format!(
        "SELECT {MEMBER_COLUMNS} \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'Namespace' \
         AND resource_members.entity_type = ? \
         AND resource_members.status = 'approved'"
    )
}

/// `group_member_helper.py:599`'s `list({m.entity_id for m in entity_members})`:
/// the resolver input keeps one copy per entity id, in first-seen order.
fn distinct_entity_ids(members: &[EntityMemberRow]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::new();
    for member in members {
        if seen.insert(member.entity_id.as_str()) {
            ids.push(member.entity_id.clone());
        }
    }
    ids
}

/// The Source filters the member rows by matched entity id without collapsing
/// them (`group_member_helper.py:601-606`), so one entity bound to several
/// Namespaces keeps one row per Namespace and its own role.
fn keep_matched_entity_members(
    members: Vec<EntityMemberRow>,
    matched: &std::collections::HashSet<String>,
) -> Vec<EntityMemberRow> {
    members
        .into_iter()
        .filter(|row| matched.contains(&row.entity_id))
        .collect()
}

/// `iter_user_groups_with_roles`: the user's namespace groups, their highest
/// role, and the winning source, from direct user memberships plus each
/// registered external entity type's bindings.
pub async fn iter_user_groups_with_roles<M, R>(
    mysql: &M,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
) -> MysqlResult<Vec<GroupRoleEntry>>
where
    M: Mysql,
    R: Redis,
{
    let mut entries: Vec<GroupRoleEntry> = Vec::new();

    // 1) Direct user memberships of Namespace resources.
    let direct: Vec<DirectMembershipRow> = mysql
        .fetch_all(
            "SELECT resource_members.resource_id AS resource_id, \
             resource_members.`role` AS role \n\
             FROM resource_members \n\
             WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved'",
            (user_id.to_string(),),
        )
        .await?;
    let direct_ids: Vec<i64> = direct.iter().map(|row| row.resource_id).collect();
    let names = namespace_names(mysql, &direct_ids).await?;
    for row in &direct {
        if let Some(name) = names.get(&row.resource_id) {
            entries.push(GroupRoleEntry {
                group_name: name.clone(),
                role: row.role.clone(),
                source_entity_type: Some("user".to_string()),
                source_entity_id: Some(user_id.to_string()),
            });
        }
    }

    // 2) Entity-derived memberships. `get_all_entity_types` includes the
    // built-in `namespace` resolver first, then each registered external
    // type (`group_member_helper.py:579-583`). Per type the Source reads every
    // approved `Namespace` member row, matches that type's entity bindings,
    // and keeps the rows whose `entity_id` matched.
    for entity_type in resolvers.types() {
        let members: Vec<EntityMemberRow> = mysql
            .fetch_all(&entity_members_statement(), (entity_type.to_string(),))
            .await?;
        if members.is_empty() {
            continue;
        }
        let entity_ids = distinct_entity_ids(&members);
        let matched: std::collections::HashSet<String> = resolvers
            .match_bindings(
                redis,
                user_id,
                entity_type,
                &entity_ids,
                ResolutionPurpose::ResourceAccess,
            )
            .await?
            .into_iter()
            .collect();
        let members = keep_matched_entity_members(members, &matched);
        if members.is_empty() {
            continue;
        }
        let member_ids: Vec<i64> = members.iter().map(|row| row.resource_id).collect();
        let names = namespace_names(mysql, &member_ids).await?;
        for row in &members {
            if let Some(name) = names.get(&row.resource_id) {
                entries.push(GroupRoleEntry {
                    group_name: name.clone(),
                    role: row.role.clone(),
                    source_entity_type: Some(entity_type.to_string()),
                    source_entity_id: Some(row.entity_id.clone()),
                });
            }
        }
    }

    Ok(dedupe_group_roles(entries))
}

/// `Namespace.name` for the active namespaces among `ids`.
async fn namespace_names<M: Mysql>(
    mysql: &M,
    ids: &[i64],
) -> MysqlResult<std::collections::BTreeMap<i64, String>> {
    if ids.is_empty() {
        return Ok(std::collections::BTreeMap::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    // The source reads the full `Namespace` entity. `Namespace.is_active` is a
    // bare truthy filter (`db.query(Namespace).filter(Namespace.id.in_(...),
    // Namespace.is_active)` in `group_member_helper.iter_user_groups_with_roles`),
    // which SQLAlchemy renders as `= 1` — not the `IS true` form the
    // `.is_(True)` call sites use. The ids are integers, so the rendered
    // literal is unquoted too.
    let sql = format!(
        "SELECT {NAMESPACE_COLUMNS} \n\
         FROM namespace \n\
         WHERE namespace.id IN ({placeholders}) AND namespace.is_active = 1"
    );
    let rows: Vec<NamespaceRow> = mysql.fetch_all(&sql, ids.to_vec()).await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.namespace_id, row.namespace_name))
        .collect())
}

/// `get_effective_roles_in_groups`: for each name the highest role from the
/// user's memberships, with parent-group inheritance (`a/b/c` falls back to
/// `a/b`, then `a`) for groups the user does not hold directly.
pub fn effective_roles_in_groups(
    entries: &[GroupRoleEntry],
    group_names: &[String],
) -> Vec<(String, String)> {
    let map: std::collections::HashMap<&str, &str> = entries
        .iter()
        .map(|entry| (entry.group_name.as_str(), entry.role.as_str()))
        .collect();
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in group_names {
        if !seen.insert(name.as_str()) {
            continue;
        }
        let role = map.get(name.as_str()).copied().or_else(|| {
            if !name.contains('/') {
                return None;
            }
            let parts: Vec<&str> = name.split('/').collect();
            for i in (1..parts.len()).rev() {
                let parent = parts[..i].join("/");
                if let Some(role) = map.get(parent.as_str()) {
                    return Some(*role);
                }
            }
            None
        });
        if let Some(role) = role {
            result.push((name.clone(), role.to_string()));
        }
    }
    result
}

/// `get_user_groups`: the sorted names of every active group the user holds a
/// role in.
pub async fn user_groups<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
) -> MysqlResult<Vec<String>> {
    let names = active_namespace_names(mysql).await?;
    user_groups_for_names(mysql, resolvers, redis, user_id, &names).await
}

/// Apply one user's membership policy to a shared active-namespace snapshot.
pub async fn user_groups_for_names<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    names: &[String],
) -> MysqlResult<Vec<String>> {
    let entries = iter_user_groups_with_roles(mysql, resolvers, redis, user_id).await?;
    let mut groups: Vec<String> = effective_roles_in_groups(&entries, names)
        .into_iter()
        .map(|(name, _role)| name)
        .collect();
    groups.sort();
    Ok(groups)
}

/// `_get_organization_names`: the active organization-level namespace names.
pub async fn organization_names(mysql: &MysqlService) -> MysqlResult<Vec<String>> {
    let rows: Vec<NameRow> = mysql
        .fetch_all(
            "SELECT namespace.name AS namespace_name \nFROM namespace \n\
             WHERE namespace.level = 'organization' AND namespace.is_active IS true",
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.namespace_name).collect())
}

/// `_get_accessible_namespace_ids`: the ids (as strings) of the active
/// namespaces named in `groups`.
pub async fn accessible_namespace_ids(
    mysql: &MysqlService,
    groups: &[String],
) -> MysqlResult<Vec<String>> {
    if groups.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; groups.len()].join(", ");
    let rows: Vec<NamespaceIdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT namespace.id AS namespace_id \nFROM namespace \n\
                 WHERE namespace.name IN ({placeholders}) AND namespace.is_active IS true"
            ),
            groups.to_vec(),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.namespace_id.to_string())
        .collect())
}

#[derive(FromMysqlRow)]
struct NameRow {
    namespace_name: String,
}

#[derive(FromMysqlRow)]
struct NamespaceIdRow {
    namespace_id: i64,
}

/// `get_user_group_roles`'s group-name list: every active namespace name.
pub async fn active_namespace_names(mysql: &MysqlService) -> MysqlResult<Vec<String>> {
    let rows: Vec<NameRow> = mysql
        .fetch_all(
            "SELECT namespace.name AS namespace_name \nFROM namespace \n\
             WHERE namespace.is_active IS true",
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.namespace_name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(group: &str, role: &str, src: &str) -> GroupRoleEntry {
        GroupRoleEntry {
            group_name: group.to_string(),
            role: role.to_string(),
            source_entity_type: Some("user".to_string()),
            source_entity_id: Some(src.to_string()),
        }
    }

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn member(resource_id: i64, entity_id: &str, role: &str) -> EntityMemberRow {
        EntityMemberRow {
            resource_id,
            entity_id: entity_id.to_string(),
            role: role.to_string(),
        }
    }

    #[test]
    fn effective_roles_inherit_from_the_nearest_parent() {
        let entries = vec![entry("a", "Developer", "1")];
        let roles =
            effective_roles_in_groups(&entries, &names(&["a", "a/b", "a/b/c", "a/x/y", "other"]));
        assert_eq!(
            roles,
            vec![
                ("a".to_string(), "Developer".to_string()),
                ("a/b".to_string(), "Developer".to_string()),
                ("a/b/c".to_string(), "Developer".to_string()),
                ("a/x/y".to_string(), "Developer".to_string()),
            ]
        );
    }

    #[test]
    fn a_direct_role_beats_an_inherited_one() {
        let entries = vec![entry("a/b", "Reporter", "1"), entry("a", "Owner", "2")];
        let roles = effective_roles_in_groups(&entries, &names(&["a/b"]));
        assert_eq!(roles, vec![("a/b".to_string(), "Reporter".to_string())]);
    }

    #[test]
    fn highest_role_picks_the_most_privileged_known_role() {
        assert_eq!(
            highest_role(&["Reporter".to_string(), "Owner".to_string()]),
            Some("Owner".to_string())
        );
        assert_eq!(
            highest_role(&["Reporter".to_string()]),
            Some("Reporter".to_string())
        );
        assert_eq!(highest_role(&[]), None);
        // An unknown role never wins over a known one, and alone yields `None`.
        assert_eq!(
            highest_role(&["nonsense".to_string(), "Viewer".to_string()]),
            Some("Viewer".to_string())
        );
        assert_eq!(highest_role(&["nonsense".to_string()]), None);
    }

    #[test]
    fn dedupe_keeps_one_entry_per_group_with_the_highest_role() {
        let deduped = dedupe_group_roles(vec![
            entry("group-a", "Reporter", "1"),
            entry("group-b", "Developer", "2"),
            entry("group-a", "Owner", "3"),
        ]);
        assert_eq!(
            deduped,
            vec![
                entry("group-a", "Owner", "3"),
                entry("group-b", "Developer", "2"),
            ]
        );
    }

    #[test]
    fn an_all_unknown_group_is_dropped() {
        assert!(dedupe_group_roles(vec![entry("g", "nonsense", "1")]).is_empty());
    }

    /// Recorded a60e1b08 seq 16/17: per entity type the Source reads every
    /// approved `Namespace` member row with the full `ResourceMember`
    /// projection, bound only by `entity_type`; the replay projection derives
    /// column names from the `resource_members_*` aliases.
    #[test]
    fn entity_members_statement_matches_the_source_full_row_read() {
        let normalized = entity_members_statement()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(normalized.starts_with(
            "SELECT resource_members.id AS resource_members_id, \
             resource_members.resource_type AS resource_members_resource_type"
        ));
        assert!(
            normalized.contains("resource_members.resource_id AS resource_members_resource_id")
        );
        assert!(normalized.contains("resource_members.\u{60}role\u{60} AS resource_members_role"));
        assert!(normalized.contains("resource_members.updated_at AS resource_members_updated_at"));
        assert!(normalized.contains(
            "WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.entity_type = ? \
             AND resource_members.status = 'approved'"
        ));
        assert!(
            !normalized.contains("resource_members.resource_id IN"),
            "{normalized}"
        );
    }

    /// `group_member_helper.py:599` hands the resolver `list({...})`: one id
    /// per entity even when the same entity grants several Namespaces, while
    /// the member rows themselves stay intact so every Namespace and role
    /// survives the match filter.
    #[test]
    fn the_resolver_input_is_deduped_but_every_member_row_is_kept() {
        let members = vec![
            member(760, "100152", "Developer"),
            member(632, "100153", "Reporter"),
            member(798, "100152", "Maintainer"),
        ];
        // Arrange: the same department id appears on two Namespace rows.
        assert_eq!(distinct_entity_ids(&members), vec!["100152", "100153"]);

        // Act: only the department the user belongs to matched.
        let matched = std::collections::HashSet::from(["100152".to_string()]);
        let kept = keep_matched_entity_members(members, &matched);

        // Assert: both Namespace rows and their own roles are preserved.
        assert_eq!(
            kept.iter().map(|row| row.resource_id).collect::<Vec<_>>(),
            vec![760, 798]
        );
        assert_eq!(
            kept.iter().map(|row| row.role.as_str()).collect::<Vec<_>>(),
            vec!["Developer", "Maintainer"]
        );
    }

    /// `iter_user_groups_with_roles` iterates `get_all_entity_types`, which
    /// includes the built-in `namespace` resolver registered by
    /// `app/services/share/__init__.py:29`. The namespace pass delegates to
    /// every external type again, so dropping it loses one ERP resolution per
    /// call (`group_member_helper.py:580`).
    #[tokio::test]
    async fn entity_iteration_includes_the_builtin_namespace_resolver() {
        struct Stub;
        #[async_trait::async_trait]
        impl crate::permissions::EntityResolver<brz_redis::RedisService> for Stub {
            async fn match_bindings(
                &self,
                _: &EntityResolvers<brz_redis::RedisService>,
                _: Option<&brz_redis::RedisService>,
                _: i64,
                _: &[String],
                _: crate::permissions::ResolutionPurpose,
            ) -> MysqlResult<Vec<String>> {
                Ok(Vec::new())
            }
            async fn get_resource_ids_by_entity(
                &self,
                _: &EntityResolvers<brz_redis::RedisService>,
                _: &MysqlService,
                _: Option<&brz_redis::RedisService>,
                _: i64,
                _: &str,
                _: &str,
            ) -> MysqlResult<Vec<i64>> {
                Ok(Vec::new())
            }
        }
        let mysql =
            MysqlService::connect_lazy("mysql://unused@127.0.0.1/unused").expect("lazy client");
        let mut registry = EntityResolvers::public(mysql);
        registry.register("org_department", Stub);
        assert_eq!(
            registry.types().collect::<Vec<_>>(),
            vec!["namespace", "org_department"]
        );
        assert_eq!(
            registry.external_types().collect::<Vec<_>>(),
            vec!["org_department"]
        );
    }
}
