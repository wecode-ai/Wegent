// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Team / bot / model resolution reads for the create flow
//! (`app/services/readers/kinds.py` + `app/services/openapi/helpers.py`).
//!
//! `create_response` resolves the requested team, its bots, and the requested
//! model before `setup_chat_session` runs. The statements reproduce the
//! SQLAlchemy-rendered `kinds` reads recorded for the create case:
//!
//! * team by id — `WHERE kinds.id = ? AND kinds.kind = 'Team' AND
//!   kinds.is_active IS true LIMIT 1`;
//! * team by owner/name/namespace — `WHERE kinds.user_id = ? AND
//!   kinds.kind = 'Team' AND kinds.namespace = ? AND kinds.name = ? AND
//!   kinds.is_active = true LIMIT 1`;
//! * bot batch by name — `WHERE kinds.kind = 'Bot' AND kinds.namespace IN (?)
//!   AND kinds.name IN (?) AND kinds.is_active = true`;
//! * model by name/namespace — `WHERE kinds.kind = 'Model' AND kinds.name = ?
//!   AND kinds.namespace = ? AND kinds.is_active IS true ORDER BY kinds.id ASC
//!   LIMIT 1`.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlService};
use brz_redis::Redis;
use serde_json::Value;

use crate::permissions::{EntityResolvers, user_groups};
use crate::task_skills::kinds::KindCacheStore;
use crate::teams::teams_repository::placeholders;

/// `kinds` columns as rendered by `db.query(Kind)`.
pub(crate) const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One `kinds` row, decoded from [`KIND_COLUMNS`].
#[derive(Debug, FromMysqlRow)]
pub struct KindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_user_id")]
    pub user_id: i64,
    #[mysql(rename = "kinds_kind")]
    pub kind: String,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_namespace")]
    pub namespace: String,
    #[mysql(rename = "kinds_json")]
    pub json: Json<serde_json::Value>,
    #[mysql(rename = "kinds_is_active")]
    pub is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    pub created_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "kinds_updated_at")]
    pub updated_at: Option<chrono::NaiveDateTime>,
}

/// `KindReader.get_by_id` for a Team (`kinds.id` + `kind = 'Team'`).
pub fn team_by_id_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = ? \
         AND kinds.kind = 'Team' AND kinds.is_active IS true \n LIMIT 1"
    )
}

/// `_get_team_by_share_permission`'s candidate read: one owner's Team by
/// name/namespace (`is_active = true`).
pub fn team_by_owner_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Team' AND kinds.namespace = ? AND kinds.name = ? \
         AND kinds.is_active = true \n LIMIT 1"
    )
}

/// The name-first variant recorded for the group path: one owner's Team by
/// name/namespace with `is_active IS true`.
pub fn team_by_owner_name_first_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Team' AND kinds.name = ? AND kinds.namespace = ? \
         AND kinds.is_active IS true \n LIMIT 1"
    )
}

/// `resolve_model_kind`'s direct read (`shared/db/capability_reference.py`):
/// the requested Model by name/namespace. A non-`default` namespace orders by
/// `id ASC` (oldest duplicate wins); the `default` namespace restricts to the
/// caller's own or the public (`user_id = 0`) Model, newest owner first.
pub fn model_by_name_namespace_statement(namespace: &str) -> String {
    let scope = if namespace == "default" {
        " AND (kinds.user_id = ? OR kinds.user_id = 0) \
         \nORDER BY kinds.user_id DESC, kinds.id ASC"
    } else {
        "\nORDER BY kinds.id ASC"
    };
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Model' \
         AND kinds.name = ? AND kinds.namespace = ? AND kinds.is_active IS true{scope} \
         LIMIT 1"
    )
}

/// `_reference_scope`'s namespace id read (`capability_reference.py`): the
/// scalar `namespace.id` for the referenced-capability scope of a non-default
/// namespace. A missing namespace ends the referenced resolution.
pub fn namespace_id_statement() -> String {
    "SELECT namespace.id \nFROM namespace \nWHERE namespace.name = ? \
     AND namespace.is_active IS true"
        .to_string()
}

/// `resolve_referenced_model_kind` (`capability_reference.py`): the
/// smallest-id approved Model shared into the caller-visible scope.
pub fn referenced_model_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id IN \
         (SELECT resource_members.resource_id \nFROM resource_members \
         \nWHERE resource_members.resource_type = 'Model' \
         AND resource_members.entity_type = ? AND resource_members.entity_id = ? \
         AND resource_members.status = 'approved') \
         AND kinds.kind = 'Model' AND kinds.name = ? AND kinds.user_id != 0 \
         AND kinds.is_active IS true \nORDER BY kinds.id ASC LIMIT 1"
    )
}

/// `KindReader.get_by_id(kind=Team)`: one Team row.
pub async fn team_by_id<M: Mysql>(mysql: &M, team_id: i64) -> MysqlResult<Option<KindRow>> {
    mysql
        .fetch_optional(team_by_id_statement(), (team_id,))
        .await
}

/// `_get_team_by_share_permission`: one owner's Team by name/namespace.
pub async fn team_by_owner<M: Mysql>(
    mysql: &M,
    owner_user_id: i64,
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>> {
    mysql
        .fetch_optional(team_by_owner_statement(), (owner_user_id, namespace, name))
        .await
}

/// One team member's `botRef`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotRef {
    pub namespace: String,
    pub name: String,
}

/// The Team CRD's `spec.members[].botRef` list, in member order
/// (`get_bot_ids_from_team` / `prepare_execution_session`).
pub fn bot_refs(team_json: &serde_json::Value) -> Vec<BotRef> {
    let Some(members) = team_json
        .get("spec")
        .and_then(|spec| spec.get("members"))
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    members
        .iter()
        .filter_map(|member| {
            let bot_ref = member.get("botRef")?;
            let name = bot_ref.get("name")?.as_str()?.to_string();
            let namespace = bot_ref.get("namespace")?.as_str()?.to_string();
            Some(BotRef { namespace, name })
        })
        .collect()
}

/// The resolved team bots: their `kinds.id`s in member order plus the first
/// resolved bot's name/namespace (`prepare_execution_session`'s chosen bot).
#[derive(Debug, Default)]
pub struct TeamBots {
    pub bot_ids: Vec<i64>,
    pub first_bot_name: String,
    pub first_bot_namespace: String,
}

/// `get_bot_ids_from_team`: one `kindReader.get_by_name_and_namespace` read
/// per team member through the deployment's cached-reader contract, collecting
/// the resolved ids in member order. An empty team or a team whose bots all
/// miss resolves to no ids, which the caller renders as the source's
/// `400 "No valid bots found in team"`.
pub async fn resolve_team_bots<M: Mysql, R: brz_redis::Redis>(
    cache: &KindCacheStore<'_, M, R>,
    team_owner_user_id: i64,
    team_json: &serde_json::Value,
) -> MysqlResult<TeamBots> {
    let refs = bot_refs(team_json);
    let mut bots = TeamBots::default();
    for reference in &refs {
        let Some(row) = cache
            .get_by_name_and_namespace_row(
                team_owner_user_id,
                "Bot",
                &reference.namespace,
                &reference.name,
            )
            .await?
        else {
            continue;
        };
        if bots.bot_ids.is_empty() {
            bots.first_bot_name = reference.name.clone();
            bots.first_bot_namespace = reference.namespace.clone();
        }
        bots.bot_ids.push(row.kinds_id);
    }
    Ok(bots)
}

/// `resolve_model_kind` (`shared/db/capability_reference.py`): the direct
/// Model by name/namespace, then the approved Model referenced into the
/// caller-visible scope. `user_id` scopes the `default` namespace's direct
/// read and the referenced resolution's entity.
pub async fn model_by_name_namespace<M: Mysql>(
    mysql: &M,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<KindRow>> {
    let direct = if namespace == "default" {
        mysql
            .fetch_optional::<_, _, KindRow>(
                model_by_name_namespace_statement(namespace),
                (name, namespace, user_id),
            )
            .await?
    } else {
        mysql
            .fetch_optional::<_, _, KindRow>(
                model_by_name_namespace_statement(namespace),
                (name, namespace),
            )
            .await?
    };
    if direct.is_some() {
        return Ok(direct);
    }
    resolve_referenced_model(mysql, user_id, name, namespace).await
}

/// `resolve_referenced_model_kind`: the smallest-id approved Model shared
/// into the caller-visible scope. The `default` namespace's scope is the
/// caller; another namespace resolves its id first and stops when it is
/// unknown.
async fn resolve_referenced_model<M: Mysql>(
    mysql: &M,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<KindRow>> {
    #[derive(Debug, FromMysqlRow)]
    struct NamespaceIdRow {
        #[mysql(rename = "id")]
        id: i64,
    }
    let (entity_type, entity_id) = if namespace == "default" {
        ("user", user_id.to_string())
    } else {
        let Some(row) = mysql
            .fetch_optional::<_, _, NamespaceIdRow>(namespace_id_statement(), (namespace,))
            .await?
        else {
            return Ok(None);
        };
        ("namespace", row.id.to_string())
    };
    mysql
        .fetch_optional::<_, _, KindRow>(
            referenced_model_statement(),
            (entity_type, entity_id, name),
        )
        .await
}

/// `namespace` columns as rendered by `db.query(Namespace)`.
const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, namespace.name AS namespace_name, \
     namespace.display_name AS namespace_display_name, \
     namespace.owner_user_id AS namespace_owner_user_id, \
     namespace.visibility AS namespace_visibility, \
     namespace.description AS namespace_description, namespace.level AS namespace_level, \
     namespace.is_active AS namespace_is_active, namespace.created_at AS namespace_created_at, \
     namespace.updated_at AS namespace_updated_at";

/// `resource_members` columns as rendered by `db.query(ResourceMember)`.
const RESOURCE_MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
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

/// A `namespace` row, decoded from [`NAMESPACE_COLUMNS`].
#[derive(Debug, FromMysqlRow)]
pub struct NamespaceRow {
    #[mysql(rename = "namespace_id")]
    pub id: i64,
    #[mysql(rename = "namespace_name")]
    pub name: String,
    #[mysql(rename = "namespace_visibility")]
    pub visibility: Option<String>,
    #[mysql(rename = "namespace_is_active")]
    pub is_active: i8,
}

/// `KindReader.get_group`: a Team in a non-default namespace.
pub fn team_group_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Team' \
         AND kinds.namespace = ? AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `GroupReader.get_by_name`: the namespace row (`visibility` drives
/// `is_public`).
pub fn namespace_by_name_statement() -> String {
    format!(
        "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \nWHERE namespace.name = ? \
         AND namespace.is_active = 1 \n LIMIT 1"
    )
}

/// `groupMemberReader.is_member`: the caller's approved `Namespace` membership.
pub fn namespace_member_statement() -> String {
    format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Namespace' \
         AND resource_members.resource_id = ? \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = ? \
         AND resource_members.status = 'approved' \n LIMIT 1"
    )
}

/// `_find_model_with_namespace`'s private read: the caller's own Model by name.
pub fn model_private_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Model' \
         AND kinds.user_id = ? AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `_find_model_with_namespace`'s group read: a Model by name in the caller's
/// groups.
pub fn model_group_statement(group_count: usize) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Model' \
         AND kinds.name = ? AND kinds.namespace IN ({}) \
         AND kinds.is_active = true \n LIMIT 1",
        placeholders(group_count)
    )
}

/// `_find_model_with_namespace`'s public read (`user_id = 0`, `default`).
pub fn model_public_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
         AND kinds.kind = 'Model' AND kinds.name = ? AND kinds.namespace = 'default' \
         AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `_find_model_with_namespace`: the caller's private Model, then a referenced
/// capability shared with the caller, then a group Model, then the public
/// Model.
///
/// The caller's groups are read at the source's own position — only after the
/// private and referenced reads miss — so a privately owned or shared Model
/// never reads `get_user_groups`.
///
/// Documented gaps (no recorded create case reaches them): the per-group
/// referenced read and the `bind_model` pointer chain
/// (`_resolve_bind_model_pointer`).
pub async fn resolve_model_for_bot<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    name: &str,
) -> MysqlResult<Option<KindRow>> {
    if user_id != 0
        && let Some(model) = mysql
            .fetch_optional::<_, _, KindRow>(model_private_statement(), (user_id, name))
            .await?
    {
        return Ok(Some(model));
    }
    // `get_referenced_capability(kind="Model", namespace="default")`: the
    // approved Model shared with the caller.
    if let Some(model) = mysql
        .fetch_optional::<_, _, KindRow>(
            referenced_model_statement(),
            ("user", user_id.to_string(), name),
        )
        .await?
    {
        return Ok(Some(model));
    }
    // `Search group models`: `get_user_groups(db, user_id)`.
    let user_groups = user_groups(mysql, resolvers, redis, user_id).await?;
    if !user_groups.is_empty() {
        let mut args: Vec<String> = vec![name.to_string()];
        args.extend(user_groups.iter().cloned());
        if let Some(model) = mysql
            .fetch_optional::<_, _, KindRow>(model_group_statement(user_groups.len()), args)
            .await?
        {
            return Ok(Some(model));
        }
    }
    mysql
        .fetch_optional::<_, _, KindRow>(model_public_statement(), (name,))
        .await
}

/// `_resolve_model_for_bot`'s name selection (priorities 1-4).
///
/// `force_override` + `override_model_name`, else the bot's
/// `agent_config.bind_model`, else `spec.modelRef.name`, else the fallback
/// override. The `allowed_models` whitelist and the `bind_model` pointer chain
/// are not modeled (no recorded create case reaches them).
pub fn resolve_model_name(
    bot_spec: &Value,
    force_override: bool,
    override_model_name: Option<&str>,
) -> Option<String> {
    let override_model_name = override_model_name.filter(|value| !value.is_empty());
    if force_override && let Some(name) = override_model_name {
        return Some(name.to_string());
    }
    if let Some(bind) = bot_spec
        .get("agent_config")
        .and_then(|config| config.get("bind_model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(bind.to_string());
    }
    if let Some(name) = bot_spec
        .get("modelRef")
        .and_then(|reference| reference.get("name"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Some(name.to_string());
    }
    override_model_name.map(str::to_string)
}

/// `resolve_task_ref_team`: the task's `spec.teamRef` Team. A ref carrying
/// `user_id` (the team owner) reads by that owner; otherwise the viewer's team
/// resolution runs. The recorded create case carries `teamRef.user_id`, so its
/// read is the owner-scoped one.
pub async fn resolve_task_ref_team<M: Mysql>(
    mysql: &M,
    team_ref_user_id: Option<i64>,
    namespace: &str,
    name: &str,
    viewer_user_id: i64,
) -> MysqlResult<Option<KindRow>> {
    if let Some(owner) = team_ref_user_id {
        return mysql
            .fetch_optional::<_, _, KindRow>(team_by_owner_statement(), (owner, namespace, name))
            .await;
    }
    // A ref without `user_id` resolves through the cached-reader team branch;
    // the store shares the caller's MySQL client.
    let cache = KindCacheStore::<M, brz_redis::RedisService> {
        mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    resolve_team(&cache, viewer_user_id, namespace, name).await
}

/// `kindReader.get_by_name_and_namespace(BOT)` for a non-default namespace.
pub fn bot_group_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Bot' \
         AND kinds.namespace = ? AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `kindReader.get_by_name_and_namespace(BOT)`: the group Bot for a non-default
/// namespace, else the owner's personal Bot then the public one.
pub async fn resolve_bot<M: Mysql>(
    mysql: &M,
    owner_user_id: i64,
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>> {
    if namespace != "default" {
        return mysql
            .fetch_optional::<_, _, KindRow>(bot_group_statement(), (namespace, name))
            .await;
    }
    if owner_user_id != 0
        && let Some(bot) = mysql
            .fetch_optional::<_, _, KindRow>(bot_personal_statement(), (owner_user_id, name))
            .await?
    {
        return Ok(Some(bot));
    }
    mysql
        .fetch_optional::<_, _, KindRow>(bot_public_statement(), (name,))
        .await
}

/// `get_personal(BOT)` in the `default` namespace.
pub fn bot_personal_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Bot' AND kinds.namespace = 'default' \
         AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `get_public(BOT)`: the `user_id = 0` Bot in `default`.
pub fn bot_public_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
         AND kinds.kind = 'Bot' AND kinds.namespace = 'default' \
         AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `KindReader.get_personal`: the caller's own Team in the `default` namespace.
pub fn team_personal_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Team' AND kinds.namespace = ? AND kinds.name = ? \
         AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `KindReader.get_public`: a `user_id = 0` Team in the `default` namespace.
pub fn team_public_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
         AND kinds.kind = 'Team' AND kinds.namespace = ? AND kinds.name = ? \
         AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `team_share_service.get_resource_for_use` / `check_permission`'s caller
/// membership read: the caller's approved membership on the Team. The recorded
/// create cases issue this for the resolved Team and it returns nothing (the
/// team is not shared through the member table), so the read is modelled for
/// dependency fidelity and never changes resolution.
pub(crate) fn team_member_check_statement() -> String {
    format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \nFROM resource_members \n\
         WHERE resource_members.resource_type IN ('Team') \
         AND resource_members.resource_id = ? \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = ? \
         AND resource_members.status IN ('approved', 'APPROVED') \n\
         ORDER BY CASE WHEN (resource_members.resource_type = 'Team') THEN 1 ELSE 0 END DESC, \
         resource_members.updated_at DESC LIMIT 1"
    )
}

/// `team_share_service.check_permission`'s entity-grant read for a Team: the
/// Team's non-user approved grants (empty for the recorded cases).
pub(crate) fn team_entity_check_statement() -> String {
    "SELECT resource_members.entity_type AS resource_members_entity_type, \
     resource_members.entity_id AS resource_members_entity_id, \
     resource_members.`role` AS resource_members_role \nFROM resource_members \n\
     WHERE resource_members.resource_type IN ('Team') \
     AND resource_members.resource_id = ? \
     AND resource_members.entity_type != 'user' \
     AND resource_members.entity_type != '' \
     AND resource_members.entity_id IS NOT NULL \
     AND resource_members.status IN ('approved', 'APPROVED')"
        .to_string()
}

/// `check_permission`'s entity-grant read for a Namespace: the Namespace's
/// non-user, non-namespace approved grants (empty for the recorded cases).
pub fn namespace_entity_check_statement() -> String {
    "SELECT resource_members.entity_type AS resource_members_entity_type, \
     resource_members.entity_id AS resource_members_entity_id, \
     resource_members.`role` AS resource_members_role \nFROM resource_members \n\
     WHERE resource_members.resource_type IN ('Namespace') \
     AND resource_members.resource_id = ? \
     AND (resource_members.entity_type NOT IN ('', 'user', 'namespace')) \
     AND resource_members.entity_id IS NOT NULL \
     AND resource_members.status IN ('approved')"
        .to_string()
}

/// `KindReader._get_team`: the Team the caller may use, through the
/// deployment's cached-reader contract (`KindCacheStore::resolve_team`):
/// the `kind:v2` index/data documents decide the personal/group reads and
/// only a miss reaches the SQL statements above, matching the recorded
/// create exchanges.
pub async fn resolve_team<M: Mysql, R: brz_redis::Redis>(
    cache: &KindCacheStore<'_, M, R>,
    user_id: i64,
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>> {
    cache
        .resolve_team(user_id, namespace, name)
        .await
        .map(|team| team.map(kinds_row))
}

/// Project a cached-reader row onto the create flow's `KindRow` shape: the
/// same `kinds` projection, so a `kind:v2:data` hit and a driver row are
/// interchangeable downstream.
pub fn kinds_row(row: crate::task_skills::repository::KindRow) -> KindRow {
    KindRow {
        id: row.kinds_id,
        user_id: row.kinds_user_id,
        kind: row.kinds_kind,
        name: row.kinds_name,
        namespace: row.kinds_namespace,
        json: Json(row.kinds_json.0.to_value()),
        is_active: row.kinds_is_active,
        created_at: Some(row.kinds_created_at),
        updated_at: Some(row.kinds_updated_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn team_by_id_matches_the_recorded_read() {
        // Recorded: SELECT kinds.id AS kinds_id, ... FROM kinds WHERE
        // kinds.id = 568317 AND kinds.kind = 'Team' AND kinds.is_active IS true
        // LIMIT 1
        assert_eq!(
            normalize(&team_by_id_statement()),
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, \
             kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at FROM kinds \
             WHERE kinds.id = ? AND kinds.kind = 'Team' AND kinds.is_active IS true \
             LIMIT 1"
        );
    }

    #[test]
    fn team_by_owner_matches_the_recorded_candidate_read() {
        let sql = normalize(&team_by_owner_statement());
        assert!(sql.contains("WHERE kinds.user_id = ? AND kinds.kind = 'Team'"));
        assert!(sql.contains("AND kinds.namespace = ? AND kinds.name = ?"));
        assert!(sql.contains("AND kinds.is_active = true LIMIT 1"));
    }

    #[test]
    fn team_by_owner_name_first_keeps_the_recorded_filter_order() {
        let sql = normalize(&team_by_owner_name_first_statement());
        assert!(sql.contains("AND kinds.name = ? AND kinds.namespace = ?"));
        assert!(sql.contains("AND kinds.is_active IS true LIMIT 1"));
    }

    #[test]
    fn model_read_matches_the_recorded_statement() {
        // Recorded (group namespace): WHERE kinds.kind = 'Model' AND
        // kinds.name = ? AND kinds.namespace = ? AND kinds.is_active IS true
        // ORDER BY kinds.id ASC LIMIT 1.
        let group = normalize(&model_by_name_namespace_statement("example-team"));
        assert!(
            group.contains("WHERE kinds.kind = 'Model' AND kinds.name = ? AND kinds.namespace = ?")
        );
        assert!(group.contains("AND kinds.is_active IS true"));
        assert!(group.contains("ORDER BY kinds.id ASC LIMIT 1"));
        // The group-namespace WHERE clause carries no owner filter.
        let group_where = group.split(" WHERE ").nth(1).unwrap_or_default();
        assert!(!group_where.contains("kinds.user_id"));

        // Recorded (default namespace): the caller's own or the public Model,
        // newest owner first.
        let default_ns = normalize(&model_by_name_namespace_statement("default"));
        assert!(default_ns.contains("(kinds.user_id = ? OR kinds.user_id = 0)"));
        assert!(default_ns.contains("ORDER BY kinds.user_id DESC, kinds.id ASC LIMIT 1"));
    }

    #[test]
    fn referenced_model_reads_match_the_recorded_statements() {
        // Recorded: SELECT namespace.id FROM namespace WHERE namespace.name =
        // 'example-team' AND namespace.is_active IS true.
        let ns = normalize(&namespace_id_statement());
        assert!(ns.contains("SELECT namespace.id FROM namespace"));
        assert!(ns.contains("WHERE namespace.name = ? AND namespace.is_active IS true"));

        // Recorded: the approved Model shared into the scope, smallest id
        // first, never the public row.
        let referenced = normalize(&referenced_model_statement());
        assert!(referenced.contains("resource_members.resource_type = 'Model'"));
        assert!(referenced.contains("resource_members.entity_type = ?"));
        assert!(referenced.contains("resource_members.entity_id = ?"));
        assert!(referenced.contains("resource_members.status = 'approved'"));
        assert!(referenced.contains("AND kinds.user_id != 0"));
        assert!(referenced.contains("ORDER BY kinds.id ASC LIMIT 1"));
    }

    #[test]
    fn model_selection_follows_the_source_priorities() {
        let bot = json!({"modelRef": {"name": "ref-model"}, "agent_config": {"bind_model": "bound-model"}});
        assert_eq!(
            resolve_model_name(&bot, true, Some("task-model")).as_deref(),
            Some("task-model")
        );
        assert_eq!(
            resolve_model_name(&bot, false, Some("task-model")).as_deref(),
            Some("bound-model")
        );
        let ref_only = json!({"modelRef": {"name": "ref-model"}});
        assert_eq!(
            resolve_model_name(&ref_only, false, None).as_deref(),
            Some("ref-model")
        );
        assert_eq!(
            resolve_model_name(&json!({}), false, Some("task-model")).as_deref(),
            Some("task-model")
        );
        assert_eq!(resolve_model_name(&json!({}), false, None), None);
    }

    #[test]
    fn model_reads_match_the_source_filters() {
        let private = normalize(&model_private_statement());
        assert!(
            private.contains("WHERE kinds.kind = 'Model' AND kinds.user_id = ? AND kinds.name = ?")
        );
        let group = normalize(&model_group_statement(2));
        assert!(group.contains("AND kinds.namespace IN (?, ?)"));
        let public = normalize(&model_public_statement());
        assert!(public.contains("WHERE kinds.user_id = 0 AND kinds.kind = 'Model'"));
    }

    #[test]
    fn bot_reads_match_the_recorded_projection() {
        let bot = normalize(&bot_group_statement());
        assert!(
            bot.contains("WHERE kinds.kind = 'Bot' AND kinds.namespace = ? AND kinds.name = ?")
        );
        assert!(bot.contains("AND kinds.is_active = true LIMIT 1"));
        let personal = normalize(&bot_personal_statement());
        assert!(personal.contains("WHERE kinds.user_id = ? AND kinds.kind = 'Bot'"));
        let public = normalize(&bot_public_statement());
        assert!(public.contains("WHERE kinds.user_id = 0 AND kinds.kind = 'Bot'"));
    }

    #[test]
    fn bot_refs_follow_member_order() {
        let team = serde_json::json!({
            "spec": {"members": [
                {"botRef": {"name": "Copy of team-beta-bot", "namespace": "ns-b"}},
                {"botRef": {"name": "second", "namespace": "ns-b"}},
            ]}
        });
        assert_eq!(
            bot_refs(&team),
            vec![
                BotRef {
                    namespace: "ns-b".to_string(),
                    name: "Copy of team-beta-bot".to_string(),
                },
                BotRef {
                    namespace: "ns-b".to_string(),
                    name: "second".to_string(),
                },
            ]
        );
    }

    #[test]
    fn bot_refs_skip_malformed_members() {
        let team = serde_json::json!({
            "spec": {"members": [{"name": "x"}, {"botRef": {"name": "y"}}]}
        });
        assert!(bot_refs(&team).is_empty());
        assert!(bot_refs(&serde_json::json!({})).is_empty());
    }

    #[tokio::test]
    async fn resolve_team_bots_reads_one_cached_bot_per_member() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let store: KindCacheStore<'_, _> = KindCacheStore {
            mysql: &mysql,
            redis: None,
            erp: None,
            resolvers: None,
        };
        let team = serde_json::json!({
            "spec": {"members": [{"botRef": {"name": "bot", "namespace": "ns-b"}}]}
        });
        let bots = resolve_team_bots(&store, 6527, &team)
            .await
            .expect("resolve");
        // The capture fake returns no rows.
        assert!(bots.bot_ids.is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        // The cached reader's group predicate: kind/namespace/name params
        // (`get_group`'s filter, no owner id).
        assert!(queries[0].sql.contains("kinds.kind = ?"));
        assert!(queries[0].sql.contains("kinds.namespace = ?"));
        assert!(queries[0].sql.contains("kinds.name = ?"));
        assert_eq!(queries[0].args, 3);
    }

    #[tokio::test]
    async fn task_ref_team_with_a_user_id_reads_by_owner() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let team = resolve_task_ref_team(&mysql, Some(1809), "ns-b", "team-beta", 6527)
            .await
            .expect("team");
        assert!(team.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        // The owner-scoped read (`kinds.user_id = ?`), not the viewer chain.
        assert!(queries[0].sql.contains("WHERE kinds.user_id = ?"));
    }

    #[tokio::test]
    async fn task_ref_team_without_a_user_id_uses_the_viewer_chain() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let _ = resolve_task_ref_team(&mysql, None, "ns-b", "team", 6527)
            .await
            .expect("team");
        // The group branch of the cached team resolution runs first.
        assert!(
            mysql.queries()[0]
                .sql
                .contains("kinds.kind = ? AND kinds.namespace = ?")
        );
    }

    #[test]
    fn group_and_namespace_reads_match_the_recorded_statements() {
        let group = normalize(&team_group_statement());
        assert!(
            group.contains("WHERE kinds.kind = 'Team' AND kinds.namespace = ? AND kinds.name = ?")
        );
        assert!(group.contains("AND kinds.is_active = true LIMIT 1"));
        // `get_group` carries no `user_id` filter (unlike `get_personal`).
        assert!(!group.contains("kinds.user_id = ?"));

        let namespace = normalize(&namespace_by_name_statement());
        assert!(namespace.contains("FROM namespace WHERE namespace.name = ?"));
        assert!(namespace.contains("AND namespace.is_active = 1 LIMIT 1"));

        let member = normalize(&namespace_member_statement());
        assert!(member.contains("resource_members.resource_type = 'Namespace'"));
        assert!(member.contains("resource_members.resource_id = ?"));
        assert!(member.contains("resource_members.entity_type = 'user'"));
        assert!(member.contains("resource_members.entity_id = ?"));
        assert!(member.contains("resource_members.status = 'approved' LIMIT 1"));

        let personal = normalize(&team_personal_statement());
        assert!(personal.contains("WHERE kinds.user_id = ?"));
        let public = normalize(&team_public_statement());
        assert!(public.contains("WHERE kinds.user_id = 0"));
    }

    #[test]
    fn share_check_reads_match_the_recorded_statements() {
        let member = normalize(&team_member_check_statement());
        assert!(member.contains("resource_members.resource_type IN ('Team')"));
        assert!(member.contains("resource_members.entity_type = 'user'"));
        assert!(member.contains("resource_members.entity_id = ?"));
        assert!(member.contains("resource_members.status IN ('approved', 'APPROVED')"));
        assert!(member.contains(
            "CASE WHEN (resource_members.resource_type = 'Team') THEN 1 ELSE 0 END DESC"
        ));

        let team_entity = normalize(&team_entity_check_statement());
        assert!(team_entity.contains("resource_members.resource_type IN ('Team')"));
        assert!(team_entity.contains("resource_members.entity_type != 'user'"));
        assert!(team_entity.contains("resource_members.entity_id IS NOT NULL"));

        let namespace_entity = normalize(&namespace_entity_check_statement());
        assert!(namespace_entity.contains("resource_members.resource_type IN ('Namespace')"));
        assert!(
            namespace_entity
                .contains("resource_members.entity_type NOT IN ('', 'user', 'namespace')")
        );
    }

    #[tokio::test]
    async fn resolve_team_group_branch_returns_none_when_the_group_is_absent() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let store: KindCacheStore<'_, _> = KindCacheStore {
            mysql: &mysql,
            redis: None,
            erp: None,
            resolvers: None,
        };
        let team = resolve_team(&store, 6527, "ns-b", "team-beta")
            .await
            .expect("resolve");
        // The capture fake returns no rows, so the group read misses and the
        // chain stops before the namespace read.
        assert!(team.is_none());
        assert_eq!(mysql.queries().len(), 1);
        assert!(mysql.queries()[0].sql.contains("kinds.kind = ?"));
        assert!(!mysql.queries()[0].sql.contains("kinds.user_id = ?"));
    }
}
