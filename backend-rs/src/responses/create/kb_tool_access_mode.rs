// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `get_knowledge_base_tool_access_mode_by_ids`
//! (`app/services/knowledge/knowledge_access_policy.py:173`) and its
//! restricted-analyst group fallback (`get_restricted_analyst_groups`,
//! `app/services/group_permission.py:305`).
//!
//! The resolver decides whether the create flow may expose every knowledge
//! base tool action (`full`) or only search
//! (`restricted_search_only`). The source issues, in this order:
//!
//! 1. `db.query(Kind).filter(Kind.id.in_(ids), Kind.kind == 'KnowledgeBase',
//!    Kind.is_active.is_(True)).all()`;
//! 2. `db.query(ResourceMember.resource_id).filter(... role ==
//!    RestrictedAnalyst).first()` over the loaded knowledge bases;
//! 3. the group fallback only for non-`default`, non-organization namespaces:
//!    `is_organization_namespace` per knowledge base, then
//!    `get_restricted_analyst_groups` (`iter_user_groups_with_roles` +
//!    `get_effective_roles_in_groups`).
//!
//! `kinds` and `resource_members` are unsharded: the request-scoped routing
//! layer's `RouteKey::None` is the "unsharded `kinds` / `projects` reads" case
//! (`request_sql.rs`), so these statements run on the shared handle exactly as
//! the create flow's ACL reads do.
use brz_mysql::{MysqlResult, MysqlService};
use brz_redis::Redis;

use super::knowledge::{APPROVED_STATUSES, KB_RESOURCE_TYPES};
use super::resolution::{KIND_COLUMNS, KindRow};
use crate::is_organization_namespace;
use crate::permissions::{
    EntityResolvers, GroupRoleEntry, effective_roles_in_groups, iter_user_groups_with_roles,
};
use crate::teams::teams_repository::{BindingArg, placeholders};

/// `KnowledgeBaseToolAccessMode.FULL`.
pub const FULL: &str = "full";

/// `KnowledgeBaseToolAccessMode.RESTRICTED_SEARCH_ONLY`.
pub const RESTRICTED_SEARCH_ONLY: &str = "restricted_search_only";

/// `RESTRICTED_ANALYST_REASON` (`knowledge_access_policy.py`).
pub const RESTRICTED_ANALYST_REASON: &str = "Restricted Analysts may use knowledge base search only for high-level analysis. Document browsing remains blocked.";

/// `BaseRole.RestrictedAnalyst.value` / `GroupRole.RestrictedAnalyst.value`.
const RESTRICTED_ANALYST_ROLE: &str = "RestrictedAnalyst";

/// The source's `tuple[str, str]`: the tool access mode and, when restricted,
/// the human-readable reason the caller logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbToolAccessMode {
    pub mode: String,
    pub reason: String,
}

impl KbToolAccessMode {
    /// `(KnowledgeBaseToolAccessMode.FULL, "")`.
    pub fn full() -> Self {
        Self {
            mode: FULL.to_string(),
            reason: String::new(),
        }
    }

    /// `(RESTRICTED_SEARCH_ONLY, RESTRICTED_ANALYST_REASON)`.
    pub fn restricted() -> Self {
        Self {
            mode: RESTRICTED_SEARCH_ONLY.to_string(),
            reason: RESTRICTED_ANALYST_REASON.to_string(),
        }
    }
}

/// `db.query(Kind).filter(Kind.id.in_(knowledge_base_ids),
/// Kind.kind == "KnowledgeBase", Kind.is_active.is_(True)).all()`: the active
/// knowledge-base rows among the ids, ordered by the ids' `IN` list.
///
/// The caller never renders this statement for an empty id list.
pub fn knowledge_base_candidates_statement(id_count: usize) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.id IN ({}) AND kinds.kind = 'KnowledgeBase' \
         AND kinds.is_active IS true",
        placeholders(id_count)
    )
}

/// `db.query(ResourceMember.resource_id).filter(...).first()`: the caller's
/// explicit `RestrictedAnalyst` membership on any of `kbs`.
///
/// The projected column keeps SQLAlchemy's unlabeled `resource_id` (a scalar
/// row), the id list binds as integers, and `entity_id` binds as the source's
/// `str(user_id)` text parameter.
pub fn explicit_restricted_member_statement(kb_count: usize) -> String {
    format!(
        "SELECT resource_members.resource_id \nFROM resource_members \n\
         WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
         AND resource_members.resource_id IN ({}) \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = ? \
         AND resource_members.status IN {APPROVED_STATUSES} \
         AND resource_members.`role` = '{RESTRICTED_ANALYST_ROLE}' \n LIMIT 1",
        placeholders(kb_count)
    )
}

/// The statement's parameters in placeholder order: the knowledge-base ids as
/// integers, then the caller id as the source's `str(user_id)` text value.
pub fn explicit_restricted_member_args(kb_ids: &[i64], user_id: i64) -> Vec<BindingArg> {
    let mut args: Vec<BindingArg> = kb_ids.iter().copied().map(BindingArg::Int).collect();
    args.push(BindingArg::Str(user_id.to_string()));
    args
}

/// `get_knowledge_base_tool_access_mode_by_ids`'s decision tail: an explicit
/// `RestrictedAnalyst` membership or any restricted group downgrades tool
/// exposure to search-only.
pub fn decide(
    has_explicit_restricted_member: bool,
    restricted_groups: &[String],
) -> KbToolAccessMode {
    if has_explicit_restricted_member || !restricted_groups.is_empty() {
        KbToolAccessMode::restricted()
    } else {
        KbToolAccessMode::full()
    }
}

/// `get_restricted_analyst_groups(db, user_id, group_names)`:
/// `get_effective_roles_in_groups` only fetches the membership batch when the
/// name list is non-empty, and the result keeps the requested names whose
/// effective role is `RestrictedAnalyst`.
pub async fn get_restricted_analyst_groups<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    group_names: &[String],
) -> MysqlResult<Vec<String>> {
    if group_names.is_empty() {
        return Ok(Vec::new());
    }
    let entries = iter_user_groups_with_roles(mysql, resolvers, redis, user_id).await?;
    Ok(restricted_group_names(&entries, group_names))
}

/// `{group_name for group_name, role in effective_roles.items() if role ==
/// GroupRole.RestrictedAnalyst}`: the requested names whose effective role is
/// the restricted analyst role, in first-requested order.
fn restricted_group_names(entries: &[GroupRoleEntry], group_names: &[String]) -> Vec<String> {
    effective_roles_in_groups(entries, group_names)
        .into_iter()
        .filter(|(_, role)| role == RESTRICTED_ANALYST_ROLE)
        .map(|(name, _)| name)
        .collect()
}

/// `get_knowledge_base_tool_access_mode_by_ids(db, user_id,
/// knowledge_base_ids)`: resolve agent-tool exposure after applying explicit
/// ACL denials.
///
/// An empty id list and a candidate list with no active knowledge base both
/// return `full` before reading `resource_members` or any group membership.
pub async fn get_knowledge_base_tool_access_mode_by_ids<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    knowledge_base_ids: &[i64],
) -> MysqlResult<KbToolAccessMode> {
    if knowledge_base_ids.is_empty() {
        return Ok(KbToolAccessMode::full());
    }

    let kbs: Vec<KindRow> = mysql
        .fetch_all(
            knowledge_base_candidates_statement(knowledge_base_ids.len()),
            knowledge_base_ids.to_vec(),
        )
        .await?;
    if kbs.is_empty() {
        return Ok(KbToolAccessMode::full());
    }

    // The member read uses the loaded rows' ids (the source's
    // `[kb.id for kb in kbs]`), in the same order as the candidate read.
    let kb_ids: Vec<i64> = kbs.iter().map(|kb| kb.id).collect();
    let explicit: Option<i64> = mysql
        .fetch_optional(
            explicit_restricted_member_statement(kb_ids.len()),
            explicit_restricted_member_args(&kb_ids, user_id),
        )
        .await?;
    if explicit.is_some() {
        return Ok(KbToolAccessMode::restricted());
    }

    let mut group_names: Vec<String> = Vec::new();
    for kb in &kbs {
        if kb.namespace == "default" || is_organization_namespace(mysql, &kb.namespace).await? {
            continue;
        }
        if !group_names.contains(&kb.namespace) {
            group_names.push(kb.namespace.clone());
        }
    }
    let restricted_groups =
        get_restricted_analyst_groups(mysql, resolvers, redis, user_id, &group_names).await?;
    Ok(decide(false, &restricted_groups))
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_mysql::MysqlService;

    fn lazy_mysql() -> MysqlService {
        MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").expect("lazy client")
    }

    #[test]
    fn full_when_no_restricted_analyst_membership_or_group() {
        assert_eq!(decide(false, &[]), KbToolAccessMode::full());
    }

    #[test]
    fn an_explicit_restricted_member_downgrades_to_search_only() {
        let mode = decide(true, &[]);
        assert_eq!(mode.mode, RESTRICTED_SEARCH_ONLY);
        assert_eq!(mode.reason, RESTRICTED_ANALYST_REASON);
    }

    #[test]
    fn a_restricted_group_downgrades_to_search_only() {
        let mode = decide(false, &["team-a".to_string()]);
        assert_eq!(mode.mode, RESTRICTED_SEARCH_ONLY);
        assert_eq!(mode.reason, RESTRICTED_ANALYST_REASON);
    }

    #[test]
    fn restricted_group_detection_keeps_only_restricted_analyst_effective_roles() {
        let entry = |group: &str, role: &str| GroupRoleEntry {
            group_name: group.to_string(),
            role: role.to_string(),
            source_entity_type: Some("user".to_string()),
            source_entity_id: Some("1".to_string()),
        };
        let entries = vec![
            entry("team-a", "RestrictedAnalyst"),
            entry("team-b", "Reporter"),
            entry("parent", "RestrictedAnalyst"),
        ];
        let names = ["team-a", "team-b", "parent/child"]
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            restricted_group_names(&entries, &names),
            vec!["team-a".to_string(), "parent/child".to_string()]
        );
    }

    #[tokio::test]
    async fn an_empty_id_list_returns_full_without_reading() {
        let mysql = lazy_mysql();
        let resolvers = EntityResolvers::public(mysql.clone());
        let mode = get_knowledge_base_tool_access_mode_by_ids(
            &mysql,
            &resolvers,
            None::<&brz_redis::RedisService>,
            5831,
            &[],
        )
        .await
        .expect("the empty id list short-circuits before any query");
        assert_eq!(mode, KbToolAccessMode::full());
    }

    #[test]
    fn candidate_statement_matches_the_source_shape() {
        let sql = knowledge_base_candidates_statement(1);
        let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(normalized.contains("FROM kinds"));
        assert!(normalized.contains("WHERE kinds.id IN (?)"));
        assert!(normalized.contains("kinds.kind = 'KnowledgeBase'"));
        assert!(normalized.contains("kinds.is_active IS true"));
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id"));
    }

    #[test]
    fn explicit_member_statement_matches_the_source_shape() {
        let sql = explicit_restricted_member_statement(1);
        let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            normalized.starts_with("SELECT resource_members.resource_id FROM resource_members")
        );
        assert!(
            normalized
                .contains("resource_members.resource_type IN ('KnowledgeBase', 'KNOWLEDGE_BASE')")
        );
        assert!(normalized.contains("resource_members.resource_id IN (?)"));
        assert!(normalized.contains("resource_members.entity_type = 'user'"));
        assert!(normalized.contains("resource_members.entity_id = ?"));
        assert!(normalized.contains("resource_members.status IN ('approved', 'APPROVED')"));
        assert!(normalized.contains("resource_members.`role` = 'RestrictedAnalyst'"));
        assert!(normalized.ends_with("LIMIT 1"));
    }

    #[test]
    fn explicit_member_args_bind_ids_as_integers_and_the_user_as_text() {
        assert_eq!(
            explicit_restricted_member_args(&[263078, 263079], 5831),
            vec![
                BindingArg::Int(263078),
                BindingArg::Int(263079),
                BindingArg::Str("5831".to_string()),
            ]
        );
    }
}
