// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The create flow's Team use-permission port: `TeamShareService._get_resource`
//! with `for_use=True` (`app/services/share/team_share_service.py`), the gate
//! `_resolve_task_default_knowledge_bases` applies before it reads a task's
//! Team-member default knowledge bases.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult, MysqlRow};
use brz_redis::Redis;

use crate::teams::group_membership::{TEAM_USE_ROLE, has_permission};

use super::knowledge::AclContextSource;
use super::resolution::{KindRow, team_entity_check_statement, team_member_check_statement};

/// `MemberRole.Reporter` (`app/schemas/base_role.py`).
const REPORTER_ROLE: &str = "Reporter";

/// `team_share_service.get_resource_for_use` (`_get_resource(for_use=True)`):
/// the owner or a public Team is admitted directly; otherwise
/// `TeamShareService.check_permission(Reporter)` — the direct member row, then
/// the entity bindings, then the native group role of a non-`default`
/// namespace — or `can_use_group_teams` (`TEAM_USE_ROLE` in the Team's own
/// namespace) must admit the caller.
pub async fn team_shared_for_use<R: Redis>(
    acl: &AclContextSource<'_, R>,
    team: &KindRow,
    user_id: i64,
) -> MysqlResult<bool> {
    if team.user_id == user_id || team.user_id == 0 {
        return Ok(true);
    }
    // `UnifiedShareService.check_permission`: the direct member row decides on
    // its own; the entity bindings run only when no member row matched.
    if team_share_member_or_entity(acl.mysql(), team.id, user_id).await? {
        return Ok(true);
    }
    if team.namespace == "default" {
        return Ok(false);
    }
    // `TeamShareService.check_permission`'s group branch, then
    // `can_use_group_teams`: both read the same effective role, and
    // `TEAM_USE_ROLE` is the lowest known role, so the second read decides
    // whether a non-`default` Team is usable through its group.
    let group_role = acl.group_role(user_id, &team.namespace).await?;
    if group_role
        .as_deref()
        .is_some_and(|role| has_permission(role, REPORTER_ROLE))
    {
        return Ok(true);
    }
    let use_role = acl.group_role(user_id, &team.namespace).await?;
    Ok(use_role
        .as_deref()
        .is_some_and(|role| has_permission(role, TEAM_USE_ROLE)))
}

/// `UnifiedShareService.check_permission`'s Team reads: the caller's approved
/// member row, else the Team's approved entity bindings.
async fn team_share_member_or_entity<M: Mysql>(
    mysql: &M,
    team_id: i64,
    user_id: i64,
) -> MysqlResult<bool> {
    let member = mysql
        .fetch_optional::<_, _, MemberExistsRow>(
            team_member_check_statement(),
            (team_id, user_id.to_string()),
        )
        .await?;
    if member.is_some() {
        return Ok(true);
    }
    let entities = mysql
        .fetch_all::<_, _, MysqlRow>(team_entity_check_statement(), (team_id,))
        .await?;
    Ok(!entities.is_empty())
}

/// The `resource_members_id` presence probe.
#[derive(Debug, FromMysqlRow)]
struct MemberExistsRow {
    #[mysql(rename = "resource_members_id")]
    id: i64,
}
