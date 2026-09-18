// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL row loads for `GET /api/tasks/{task_id}/skills`, mirroring the
//! source SQLAlchemy renderings token for token: full labeled
//! `{table}_{column}` projections and the direct public tables selected by
//! the open-source readers.
use crate::json_compat::OpaqueJson;
use crate::task_routing::ByTaskId;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use chrono::NaiveDateTime;

/// `kinds` column list rendered by `db.query(Kind)`.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// A `tasks_{:04}` row selected with the full labeled projection.
#[derive(Debug)]
pub struct TaskRow {
    pub user_id: i64,
    pub json: OpaqueJson,
    pub project_id: Option<i64>,
}

/// One `kinds` row for every kind the skills chain loads (Team, Bot, Ghost,
/// Skill, SkillBinding, Subscription).
#[derive(Debug, Clone, FromMysqlRow)]
pub struct KindRow {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    #[allow(dead_code)]
    pub kinds_kind: String,
    #[allow(dead_code)]
    pub kinds_name: String,
    pub kinds_namespace: String,
    pub kinds_json: brz_mysql::Json<OpaqueJson>,
    #[allow(dead_code)]
    pub kinds_is_active: i8,
    #[allow(dead_code)]
    pub kinds_created_at: NaiveDateTime,
    #[allow(dead_code)]
    pub kinds_updated_at: NaiveDateTime,
}

/// `background_executions` row (`db.query(BackgroundExecution).filter(
/// task_id).order_by(created_at.desc()).first()`); only `subscription_id`
/// is consumed.
#[derive(Debug, FromMysqlRow)]
pub struct BackgroundExecutionRow {
    #[allow(dead_code)]
    pub background_executions_id: i64,
    pub background_executions_subscription_id: i64,
}

/// `task_store.get_active_task` on the sharded table (new-format ids route
/// by their embedded uid; the deployment runs 1024 shards).
pub async fn get_active_task<M>(mysql: &M, task_id: i64) -> MysqlResult<Option<TaskRow>>
where
    M: Mysql,
{
    let sql = "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         \nFROM {{tasks}} \nWHERE id = ? \
         AND kind = 'Task' AND is_active IN (1, 2) \n LIMIT 1";
    let row: Option<brz_mysql::MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(sql, (task_id,))
        .await?;
    row.as_ref().map(decode_task_row).transpose()
}

fn decode_task_row(row: &brz_mysql::MysqlRow) -> MysqlResult<TaskRow> {
    Ok(TaskRow {
        user_id: row.get_required("user_id")?,
        json: row.get_required::<brz_mysql::Json<OpaqueJson>>("json")?.0,
        project_id: row.get("project_id")?,
    })
}

/// `KindReader.get_personal`: owned by `user_id` in namespace `default`.
pub async fn kinds_personal<M>(
    mysql: &M,
    user_id: i64,
    kind: &str,
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
             AND kinds.kind = '{kind}' AND kinds.namespace = '{namespace}' \
             AND kinds.name = '{escaped}' AND kinds.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(name)
            ),
            (user_id,),
        )
        .await
}

/// `KindReader.get_personal` for the Team kind (cached personal index
/// fallback): the user's own active Team with the name.
pub async fn team_personal<M>(
    mysql: &M,
    user_id: i64,
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
             AND kinds.kind = 'Team' AND kinds.namespace = '{namespace}' \
             AND kinds.name = '{escaped}' AND kinds.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(name)
            ),
            (user_id,),
        )
        .await
}

/// `KindReader.get_public` for the Team kind.
pub async fn team_public<M>(mysql: &M, namespace: &str, name: &str) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
             AND kinds.kind = 'Team' AND kinds.namespace = '{namespace}' \
             AND kinds.name = '{escaped}' AND kinds.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(name)
            ),
            (),
        )
        .await
}

/// `KindReader.get_group` for the Team kind (non-default namespaces).
pub async fn team_group<M>(mysql: &M, namespace: &str, name: &str) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Team' \
             AND kinds.namespace = '{namespace}' \
             AND kinds.name = '{escaped}' AND kinds.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(name)
            ),
            (),
        )
        .await
}

/// The shared-team id-list hit (`_get_team` step 2): the matching active
/// Team among the shared ids. `ids` keeps the cached list's order.
pub async fn team_by_shared_ids<M>(
    mysql: &M,
    ids: &[i64],
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    let list = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<String>>()
        .join(", ");
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id IN ({list}) \
             AND kinds.kind = 'Team' AND kinds.namespace = '{namespace}' \
             AND kinds.name = '{escaped}' AND kinds.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(name)
            ),
            (),
        )
        .await
}

/// `sharedTeamReader.get_shared_team_ids`: approved Team memberships for a
/// user. The open-source reader performs this query directly; cache-backed
/// implementations belong to the internal crate.
pub async fn shared_team_ids<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    #[derive(FromMysqlRow)]
    struct ResourceIdRow {
        resource_members_resource_id: i64,
    }
    let rows: Vec<ResourceIdRow> = mysql
        .fetch_all(
            "SELECT resource_members.resource_id AS resource_members_resource_id \
             \nFROM resource_members \
             \nWHERE resource_members.resource_type IN ('Team', 'TEAM') \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status IN ('approved', 'APPROVED')",
            (user_id.to_string(),),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// `KindReader.get_public`: `user_id = 0`; the deployed reader drops the
/// namespace predicate (the recorded public-Skill fallback carries no
/// `kinds.namespace` filter).
pub async fn kinds_public<M>(
    mysql: &M,
    kind: &str,
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    let _ = namespace;
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
             AND kinds.kind = '{kind}' \
             AND kinds.name = '{escaped}' AND kinds.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(name)
            ),
            (),
        )
        .await
}

/// `_get_team_by_share_permission` candidate query: every other owner's
/// active Team with the name, newest first.
pub async fn shared_team_candidates<M>(
    mysql: &M,
    user_id: i64,
    namespace: &str,
    name: &str,
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE (kinds.user_id NOT IN (0, ?)) \
             AND kinds.kind = 'Team' AND kinds.namespace = '{namespace}' \
             AND kinds.name = '{escaped}' AND kinds.is_active = true \
             ORDER BY kinds.updated_at DESC, kinds.id DESC",
                escaped = escape_sql_string(name)
            ),
            (user_id,),
        )
        .await
}

/// `UnifiedShareService.check_permission`'s member query
/// (`TeamShareService`, resource type `Team`): the latest approved Team
/// membership row for the user (full `ResourceMember` projection; only the
/// role is consumed).
pub async fn team_share_member_row<M>(
    mysql: &M,
    team_id: i64,
    user_id: i64,
) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    #[derive(FromMysqlRow)]
    struct RoleRow {
        resource_members_role: Option<String>,
    }
    let row: Option<RoleRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {} \nFROM resource_members \n\
                 WHERE resource_members.resource_type IN ('Team') \
                 AND resource_members.resource_id = ? \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = ? \
                 AND resource_members.status IN ('approved', 'APPROVED') \
                 ORDER BY CASE WHEN (resource_members.resource_type = 'Team') THEN 1 ELSE 0 END DESC, \
                 resource_members.updated_at DESC \n LIMIT 1",
                crate::teams::teams_repository::MEMBER_COLUMNS
            ),
            (team_id, user_id.to_string()),
        )
        .await?;
    Ok(row.and_then(|row| row.resource_members_role))
}

/// `UnifiedShareService.check_entity_permission`'s entity query: the
/// approved non-user member bindings of the Team with their stored roles.
pub async fn team_share_entity_rows<M>(
    mysql: &M,
    team_id: i64,
) -> MysqlResult<Vec<(String, String, Option<String>)>>
where
    M: Mysql,
{
    #[derive(FromMysqlRow)]
    struct EntityRow {
        resource_members_entity_type: String,
        resource_members_entity_id: String,
        resource_members_role: Option<String>,
    }
    let rows: Vec<EntityRow> = mysql
        .fetch_all(
            "SELECT resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, \
             resource_members.`role` AS resource_members_role \nFROM resource_members \n\
             WHERE resource_members.resource_type IN ('Team') \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type != 'user' \
             AND resource_members.entity_type != '' \
             AND resource_members.entity_id IS NOT NULL \
             AND resource_members.status IN ('approved', 'APPROVED')",
            (team_id,),
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

/// `TeamShareService._get_active_team`: the active Team row by id
/// (`is_active IS true` rendering); only the namespace is consumed.
pub async fn team_share_active_team<M>(mysql: &M, team_id: i64) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    #[derive(FromMysqlRow)]
    struct NamespaceRow {
        kinds_namespace: String,
    }
    let row: Option<NamespaceRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = ? \
                 AND kinds.kind = 'Team' AND kinds.is_active IS true \n LIMIT 1"
            ),
            (team_id,),
        )
        .await?;
    Ok(row.map(|row| row.kinds_namespace))
}

/// `skill_binding_service.list_user_default_bindings`: the user's active
/// SkillBinding rows in the `default` namespace, newest first.
pub async fn user_default_bindings<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
             AND kinds.kind = 'SkillBinding' AND kinds.namespace = 'default' \
             AND kinds.is_active = true ORDER BY kinds.created_at DESC"
            ),
            (user_id,),
        )
        .await
}

/// `skill_binding_service.list_group_bindings`: the group namespace's active
/// SkillBinding rows, newest first (`Kind.namespace == group_namespace` and
/// the truthy `Kind.is_active` render as `= '...'` and `= true`).
pub async fn group_bindings<M>(mysql: &M, group_namespace: &str) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'SkillBinding' \
             AND kinds.namespace = '{escaped}' AND kinds.is_active = true \
             ORDER BY kinds.created_at DESC",
                escaped = escape_sql_string(group_namespace)
            ),
            (),
        )
        .await
}

/// `namespace` column list rendered by `db.query(Namespace)`.
const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, \
     namespace.name AS namespace_name, namespace.display_name AS namespace_display_name, \
     namespace.owner_user_id AS namespace_owner_user_id, \
     namespace.visibility AS namespace_visibility, \
     namespace.description AS namespace_description, \
     namespace.level AS namespace_level, namespace.is_active AS namespace_is_active, \
     namespace.created_at AS namespace_created_at, \
     namespace.updated_at AS namespace_updated_at";

/// One `namespace` row (`db.query(Namespace)` full labeled projection).
// Migrated from the Python source; not yet wired into the gateway. The
// unread columns keep the decoded row shape identical to the source query.
#[derive(Debug, FromMysqlRow)]
pub struct NamespaceRow {
    #[allow(dead_code)]
    pub namespace_id: i64,
    #[allow(dead_code)]
    pub namespace_name: String,
    #[allow(dead_code)]
    pub namespace_display_name: Option<String>,
    #[allow(dead_code)]
    pub namespace_owner_user_id: Option<i64>,
    #[allow(dead_code)]
    pub namespace_visibility: String,
    #[allow(dead_code)]
    pub namespace_description: Option<String>,
    #[allow(dead_code)]
    pub namespace_level: Option<String>,
    #[allow(dead_code)]
    pub namespace_is_active: Option<i8>,
    #[allow(dead_code)]
    pub namespace_created_at: Option<NaiveDateTime>,
    #[allow(dead_code)]
    pub namespace_updated_at: Option<NaiveDateTime>,
}

/// `GroupReader.get_by_name` (the base reader behind the cached group
/// reader): the active namespace with this exact name. The source filter
/// `Namespace.is_active == True` renders as `namespace.is_active = true`.
pub async fn namespace_by_name<M>(mysql: &M, name: &str) -> MysqlResult<Option<NamespaceRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \nWHERE namespace.name = '{escaped}' \
             AND namespace.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(name)
            ),
            (),
        )
        .await
}

/// `skill_binding_service._get_active_skill`: an active Skill by id.
pub async fn active_skill_by_id<M>(mysql: &M, skill_id: i64) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = ? \
             AND kinds.kind = 'Skill' AND kinds.is_active = true \n LIMIT 1"
            ),
            (skill_id,),
        )
        .await
}

/// `KindReader.get_group` for non-Team kinds.
pub async fn kinds_group<M>(
    mysql: &M,
    kind: &str,
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = '{kind}' \
             AND kinds.namespace = '{namespace}' \
             AND kinds.name = '{escaped}' AND kinds.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(name)
            ),
            (),
        )
        .await
}

/// `batch_load_kinds_by_refs` personal rows: the user's active kinds with
/// the given names in the `default` namespace. `names` keeps the caller's
/// order.
pub async fn kinds_by_names<M>(
    mysql: &M,
    user_id: i64,
    kind: &str,
    names: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    let list = names
        .iter()
        .map(|(_, name)| format!("'{}'", escape_sql_string(name)))
        .collect::<Vec<String>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
             AND kinds.kind = '{kind}' AND kinds.namespace = 'default' \
             AND kinds.name IN ({list}) AND kinds.is_active = true"
            ),
            (user_id,),
        )
        .await
}

/// `batch_load_kinds_by_refs` public rows (`user_id = 0`).
pub async fn public_kinds_by_names<M>(
    mysql: &M,
    kind: &str,
    names: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    let list = names
        .iter()
        .map(|(_, name)| format!("'{}'", escape_sql_string(name)))
        .collect::<Vec<String>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
             AND kinds.kind = '{kind}' AND kinds.namespace = 'default' \
             AND kinds.name IN ({list}) AND kinds.is_active = true"
            ),
            (),
        )
        .await
}

/// `batch_load_kinds_by_refs` group rows (namespace-scoped).
pub async fn group_kinds_by_names<M>(
    mysql: &M,
    kind: &str,
    refs: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    let namespace_list = refs
        .iter()
        .map(|(namespace, _)| format!("'{}'", escape_sql_string(namespace)))
        .collect::<Vec<String>>()
        .join(", ");
    let name_list = refs
        .iter()
        .map(|(_, name)| format!("'{}'", escape_sql_string(name)))
        .collect::<Vec<String>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = '{kind}' \
             AND kinds.namespace IN ({namespace_list}) \
             AND kinds.name IN ({name_list}) AND kinds.is_active = true"
            ),
            (),
        )
        .await
}

/// `_get_subscription_skill_refs_for_task`: the latest background execution
/// for the task (only `subscription_id` is consumed; 0 means no
/// subscription).
pub async fn latest_background_execution<M>(
    mysql: &M,
    task_id: i64,
) -> MysqlResult<Option<BackgroundExecutionRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT background_executions.id AS background_executions_id, \
         background_executions.user_id AS background_executions_user_id, \
         background_executions.subscription_id AS background_executions_subscription_id, \
         background_executions.task_id AS background_executions_task_id, \
         background_executions.inbox_message_id AS background_executions_inbox_message_id, \
         background_executions.trigger_type AS background_executions_trigger_type, \
         background_executions.trigger_reason AS background_executions_trigger_reason, \
         background_executions.prompt AS background_executions_prompt, \
         background_executions.status AS background_executions_status, \
         background_executions.result_summary AS background_executions_result_summary, \
         background_executions.error_message AS background_executions_error_message, \
         background_executions.retry_attempt AS background_executions_retry_attempt, \
         background_executions.version AS background_executions_version, \
         background_executions.started_at AS background_executions_started_at, \
         background_executions.completed_at AS background_executions_completed_at, \
         background_executions.created_at AS background_executions_created_at, \
         background_executions.updated_at AS background_executions_updated_at \n\
         FROM background_executions \nWHERE background_executions.task_id = ? \
         ORDER BY background_executions.created_at DESC \n LIMIT 1",
            (task_id,),
        )
        .await
}

/// The subscription Kind row by id (`_get_subscription_skill_refs_for_task`
/// step 2).
pub async fn subscription_by_id<M>(mysql: &M, subscription_id: i64) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = ? \
             AND kinds.kind = 'Subscription' AND kinds.is_active = true \n LIMIT 1"
            ),
            (subscription_id,),
        )
        .await
}

/// `skill_resolution.find_skill_by_name` binding fallback: an active Skill
/// bound by id, matched by name (`Kind.id.in_(ids)` with the name filter).
pub async fn skill_by_bound_ids<M>(
    mysql: &M,
    ids: &[i64],
    skill_name: &str,
) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    let list = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<String>>()
        .join(", ");
    mysql
        .fetch_optional(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id IN ({list}) \
             AND kinds.kind = 'Skill' AND kinds.name = '{escaped}' \
             AND kinds.is_active = true \n LIMIT 1",
                escaped = escape_sql_string(skill_name)
            ),
            (),
        )
        .await
}

/// Escape one string literal with MySQL's default quoting rules (the same
/// helper the personal-list flow uses for inline COM_QUERY literals).
///
/// Only the escape-worthy characters are rewritten; every other character —
/// including multi-byte UTF-8 — is copied through unchanged, so the rendered
/// literal carries the same bytes the source SQLAlchemy driver emitted for a
/// non-ASCII name.
fn escape_sql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{1a}' => out.push_str("\\Z"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_single_quotes_and_backslashes() {
        assert_eq!(escape_sql_string("a'b"), "a\\'b");
        assert_eq!(escape_sql_string("a\\b"), "a\\\\b");
        assert_eq!(escape_sql_string("wegent-chat"), "wegent-chat");
    }

    #[test]
    fn keeps_multibyte_characters_intact() {
        // Recorded group query `Copy of 示例分组 (3)`: the source literal
        // carries the UTF-8 bytes, so the escaped literal must reproduce the
        // name instead of one Latin-1 character per byte.
        let name = "Copy of 示例分组 (3)";
        assert_eq!(escape_sql_string(name), name);
        assert_eq!(escape_sql_string("WB-9898示例数据"), "WB-9898示例数据");
        assert_eq!(escape_sql_string("emoji \u{1f600}"), "emoji \u{1f600}");
    }
}
