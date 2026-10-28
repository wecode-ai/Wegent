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
use crate::request_sql::{RequestSql, RouteKey, fetch_optional_as};
use crate::task_skills::kinds::KindCacheStore;
use crate::task_store_statements::StatementArg;
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

/// [`resolve_team_bots`] on the caller's request SQL handle: a Bot cache miss
/// reads on `sql`, and a cache hit issues no statement.
pub async fn resolve_team_bots_on<M: Mysql, R: brz_redis::Redis>(
    sql: &mut dyn RequestSql,
    cache: &KindCacheStore<'_, M, R>,
    team_owner_user_id: i64,
    team_json: &serde_json::Value,
) -> MysqlResult<TeamBots> {
    let refs = bot_refs(team_json);
    let mut bots = TeamBots::default();
    for reference in &refs {
        let Some(row) = cache
            .get_by_name_and_namespace_row_on(
                sql,
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

/// [`model_by_name_namespace`] on the caller's request SQL handle (qs17: the
/// Model read the source issues on its request session).
pub async fn model_by_name_namespace_on(
    sql: &mut dyn RequestSql,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<KindRow>> {
    let route = RouteKey::None;
    let statement = model_by_name_namespace_statement(namespace);
    let direct: Option<KindRow> = if namespace == "default" {
        fetch_optional_as(
            sql,
            route,
            &statement,
            vec![
                StatementArg::Str(name.to_string()),
                StatementArg::Str(namespace.to_string()),
                StatementArg::Int(user_id),
            ],
        )
        .await?
    } else {
        fetch_optional_as(
            sql,
            route,
            &statement,
            vec![
                StatementArg::Str(name.to_string()),
                StatementArg::Str(namespace.to_string()),
            ],
        )
        .await?
    };
    if direct.is_some() {
        return Ok(direct);
    }
    resolve_referenced_model_on(sql, user_id, name, namespace).await
}

/// One `namespace.id` row.
#[derive(Debug, FromMysqlRow)]
struct NamespaceIdLookup {
    #[mysql(rename = "id")]
    id: i64,
}

/// [`resolve_referenced_model`] on the caller's request SQL handle.
async fn resolve_referenced_model_on(
    sql: &mut dyn RequestSql,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<KindRow>> {
    let route = RouteKey::None;
    let (entity_type, entity_id) = if namespace == "default" {
        ("user", user_id.to_string())
    } else {
        let Some(row): Option<NamespaceIdLookup> = fetch_optional_as(
            sql,
            route,
            &namespace_id_statement(),
            vec![StatementArg::Str(namespace.to_string())],
        )
        .await?
        else {
            return Ok(None);
        };
        ("namespace", row.id.to_string())
    };
    fetch_optional_as(
        sql,
        route,
        &referenced_model_statement(),
        vec![
            StatementArg::Str(entity_type.to_string()),
            StatementArg::Str(entity_id),
            StatementArg::Str(name.to_string()),
        ],
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
/// capability shared with the caller, then a group Model, then each group's
/// referenced Model, then the public Model behind the `allowedUsers` gate.
///
/// The caller's groups are read at the source's own position — only after the
/// private and referenced reads miss — so a privately owned or shared Model
/// never reads `get_user_groups`.
///
/// `enforce_public_whitelist` mirrors the source argument of the same name:
/// `_resolve_allowed_model_names` inspects a bound Model's metadata and passes
/// `False`, while the executing resolution enforces the public-user whitelist.
/// The caller row is read in both cases, as the source reads it unconditionally
/// after the public Model resolves.
///
/// Documented gap: the `bind_model` pointer chain
/// (`_resolve_bind_model_pointer`).
async fn find_model_with_namespace<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    name: &str,
    enforce_public_whitelist: bool,
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
        // `for group_name in user_groups: get_referenced_capability(namespace=
        // group_name)` (model_resolver.py:901-906): the namespace-id scope,
        // then the referenced-Model read for that scope.
        for group in &user_groups {
            if let Some(model) = resolve_referenced_model(mysql, user_id, name, group).await? {
                return Ok(Some(model));
            }
        }
    }
    let public: Option<KindRow> = mysql
        .fetch_optional(model_public_statement(), (name,))
        .await?;
    let Some(model) = public else {
        return Ok(None);
    };
    // `is_public_model_allowed_for_user`: the caller's row, then the
    // `allowedUsers` whitelist. A denied public Model is reported as not found
    // (`_resolve_model_for_bot` treats `PublicModelAccessDeniedError` that way
    // for a Bot-bound Model).
    let user_name = crate::teams::team_union_lookups::user_by_id(mysql, user_id)
        .await?
        .map(|user| user.users_user_name);
    if !enforce_public_whitelist {
        return Ok(Some(model));
    }
    let model_json = brz_json::OpaqueJson::from(model.json.0.clone());
    if crate::teams::public_model_access::allowed_for_user_name(&model_json, user_name.as_deref()) {
        Ok(Some(model))
    } else {
        Ok(None)
    }
}

/// `_resolve_model_for_bot`'s failure modes. A dependency read failure is the
/// create flow's `500`; the task-override whitelist rejection is the source
/// `ValueError` that the endpoint renders as `400`.
#[derive(Debug)]
pub enum ModelResolutionError {
    Mysql(brz_mysql::MysqlError),
    Disallowed(String),
}

impl From<brz_mysql::MysqlError> for ModelResolutionError {
    fn from(error: brz_mysql::MysqlError) -> Self {
        Self::Mysql(error)
    }
}

/// `get_model_config_for_bot`'s two `ValueError` raises
/// (`app/services/chat/config/model_resolver.py:785-787`), which the endpoint
/// renders as `400 {"detail": ...}`:
///
/// * no resolved model name → `Bot {bot.name} has no model configured`;
/// * a resolved name with no Model → `Model {model_name} not found`.
///
/// `build_agent_config_for_bot` deliberately does not raise; only the flat
/// `get_model_config_for_bot` path reaches this error.
pub(super) fn flat_model_config_error(
    model_name: Option<&str>,
    bot_name: &str,
) -> crate::http_compat::FastApiError {
    let message = match model_name {
        Some(name) => format!("Model {name} not found"),
        None => format!("Bot {bot_name} has no model configured"),
    };
    crate::http_compat::FastApiError::detail(brz_http_server::StatusCode::BAD_REQUEST, message)
}

/// `_resolve_model_for_bot` for the callers that carry no task-level override.
pub async fn resolve_model_for_bot<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    name: &str,
) -> MysqlResult<Option<KindRow>> {
    find_model_with_namespace(mysql, resolvers, redis, user_id, name, true).await
}

/// `_resolve_model_for_bot` with a task-level `override_model_name`
/// (`model_resolver.py:461-566`).
///
/// Before the executing resolution, an override runs
/// `_resolve_allowed_model_names` (`model_resolver.py:534-545`): it reads each
/// bound Model's metadata through `_find_model_with_namespace` to discover a
/// `modelConfig.allowed_models` whitelist, and rejects an override the bot does
/// not allow. The probe is a full resolution chain, so an override request
/// issues twice as many Model reads as a plain one.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_model_for_bot_with_override<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    name: &str,
    bot_spec: &Value,
    bot_name: &str,
    override_model_name: Option<&str>,
) -> Result<Option<KindRow>, ModelResolutionError> {
    if let Some(override_name) = override_model_name.filter(|value| !value.is_empty())
        && let Some(allowed) =
            resolve_allowed_model_names(mysql, resolvers, redis, user_id, bot_spec).await?
        && !allowed.contains(override_name)
    {
        return Err(ModelResolutionError::Disallowed(format!(
            "Model '{override_name}' is not in the allowed models list for bot '{bot_name}'"
        )));
    }
    find_model_with_namespace(mysql, resolvers, redis, user_id, name, true)
        .await
        .map_err(ModelResolutionError::Mysql)
}

/// `_resolve_allowed_model_names` (`model_resolver.py:569-614`): the bot's
/// `allowed_models` whitelist, either on `agent_config` or on a bound Model's
/// `modelConfig`. `None` means the bot does not restrict models.
async fn resolve_allowed_model_names<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    bot_spec: &Value,
) -> MysqlResult<Option<std::collections::HashSet<String>>> {
    let agent_config = bot_spec.get("agent_config").cloned().unwrap_or(Value::Null);
    let mut allowed_models = agent_config
        .get("allowed_models")
        .filter(|value| brz_json::adapters::python_truthy(value))
        .cloned();
    if allowed_models.is_none() {
        for bound_model_name in bound_model_names(bot_spec, &agent_config) {
            // Only inspect the bound Model's metadata here; the user is not
            // executing with it, so the public-user whitelist must not apply.
            let Some(bound) = find_model_with_namespace(
                mysql,
                resolvers,
                redis,
                user_id,
                &bound_model_name,
                false,
            )
            .await?
            else {
                continue;
            };
            let bound_allowed_models = bound
                .json
                .0
                .get("spec")
                .and_then(|spec| spec.get("modelConfig"))
                .and_then(|config| config.get("allowed_models"))
                .filter(|value| brz_json::adapters::python_truthy(value));
            if let Some(value) = bound_allowed_models {
                allowed_models = Some(value.clone());
                break;
            }
        }
    }
    Ok(allowed_model_names(allowed_models.as_ref()))
}

/// `_bound_model_names` (`model_resolver.py:617-629`): `agent_config.bind_model`
/// then the legacy `spec.modelRef.name`, deduped in that order.
fn bound_model_names(bot_spec: &Value, agent_config: &Value) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    if let Some(bind_model) = agent_config
        .get("bind_model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        names.push(bind_model.to_string());
    }
    if let Some(model_ref_name) = bot_spec
        .get("modelRef")
        .and_then(|reference| reference.get("name"))
        .and_then(Value::as_str)
        && !names.iter().any(|name| name == model_ref_name)
    {
        names.push(model_ref_name.to_string());
    }
    names
}

/// The source's `isinstance(allowed_models, list) and allowed_models` guard plus
/// `{m.get("name") for m in allowed_models if isinstance(m, dict) and m.get("name")}`.
fn allowed_model_names(
    allowed_models: Option<&Value>,
) -> Option<std::collections::HashSet<String>> {
    let items = allowed_models?.as_array()?;
    if items.is_empty() {
        return None;
    }
    Some(
        items
            .iter()
            .filter_map(|item| item.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect(),
    )
}

/// `_resolve_model_for_bot`'s name selection (priorities 1-4).
///
/// `force_override` + `override_model_name`, else the bot's
/// `agent_config.bind_model`, else `spec.modelRef.name`, else the fallback
/// override. The `bind_model` pointer chain is not modeled (no recorded create
/// case reaches it); the `allowed_models` whitelist is applied by
/// [`resolve_model_for_bot`].
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
mod resolution_tests;
