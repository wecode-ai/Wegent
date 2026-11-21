// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `find_skill_by_name` (`skill_resolution.py:28-110`): the lookup
//! `_get_bot_skills` runs for a Ghost Skill that carries no stored
//! `skill_ref` (`request_builder.py:1694` -> `_find_skill`).

use super::*;

/// A Ghost Skill's name lookup, in the source's order:
///
/// 1. the team owner's Skill in `default`,
/// 2. any owner's Skill in the team namespace,
/// 3. a Skill bound to the team namespace (Reporter access required),
/// 4. the owner's default-namespace bindings,
/// 5. the public (`user_id = 0`) Skill.
///
/// Steps 1, 2 and 5 are plain reads; steps 3 and 4 first resolve the binding
/// ids through the same access helpers the binding flow uses, which is why the
/// caller must supply its `SkillAccess` (every create and late-resolution path
/// does).
pub(super) async fn find_skill_by_name<M: Mysql>(
    mysql: &M,
    skill_name: &str,
    owner_user_id: i64,
    team_namespace: &str,
    access: Option<&SkillAccess<'_>>,
) -> MysqlResult<Option<SkillKindRow>> {
    if let Some(skill) = mysql
        .fetch_optional(
            personal_skill_statement(),
            (owner_user_id, skill_name.to_string(), "default".to_string()),
        )
        .await?
    {
        return Ok(Some(skill));
    }
    if team_namespace != "default" {
        if let Some(skill) = mysql
            .fetch_optional(
                group_skill_statement(),
                (skill_name.to_string(), team_namespace.to_string()),
            )
            .await?
        {
            return Ok(Some(skill));
        }
        if let Some(access) = access
            && access
                .check_group_permission(owner_user_id, team_namespace)
                .await?
        {
            let ids = wegent_capabilities::skills_unified::group_skill_ids_for_namespaces(
                mysql,
                &[team_namespace.to_string()],
            )
            .await?
            .into_iter()
            .map(i64::from)
            .collect::<Vec<_>>();
            if !ids.is_empty()
                && let Some(skill) = mysql
                    .fetch_optional(bound_skill_statement(&ids), (skill_name.to_string(),))
                    .await?
            {
                return Ok(Some(skill));
            }
        }
    }
    if let Some(access) = access {
        let ids = access
            .list_user_default_skill_ids(owner_user_id, &format!("user:{owner_user_id}"))
            .await?
            .into_iter()
            .collect::<Vec<_>>();
        if !ids.is_empty()
            && let Some(skill) = mysql
                .fetch_optional(bound_skill_statement(&ids), (skill_name.to_string(),))
                .await?
        {
            return Ok(Some(skill));
        }
    }
    mysql
        .fetch_optional(public_skill_statement(), (skill_name.to_string(),))
        .await
}

/// `Kind.id.in_(bound_skill_ids)` plus the name filter: the bound-id read steps
/// 3 and 4 issue once the candidate ids are non-empty.
fn bound_skill_statement(ids: &[i64]) -> String {
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    let list = ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id IN ({list}) \
         AND kinds.kind = 'Skill' AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

#[cfg(test)]
#[path = "skills_by_name_tests.rs"]
mod tests;
