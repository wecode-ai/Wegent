// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task-candidate rows and projections for
//! `GET /api/tasks/lite/personal` (`TaskQueryMixin.get_user_personal_tasks_lite`,
//! `get_user_personal_tasks_lite_cursor`, `_filter_personal_tasks`,
//! `build_lite_task_list`, and their store queries).
use std::collections::HashMap;

use brz_mysql::{FromMysqlRow, Mysql};
use chrono::NaiveDateTime;
use serde_json::Value as Json;

use crate::crd::{CrdDocument, NumericId};
use crate::task_routing::ByUserId;

/// One `tasks`/`tasks_{:04}` row projection used by the personal list flow.
///
/// `json` keeps the raw task-CRD JSON text and is parsed once per row;
/// the column set mirrors the source `db.query(model)` full-entity select
/// restricted to the fields this endpoint consumes.
#[derive(Debug, FromMysqlRow)]
pub struct TaskCandidateRow {
    pub id: i64,
    #[allow(dead_code)] // `user_id` documents the selected column set
    pub user_id: i64,
    pub json: Json,
    pub created_at: NaiveDateTime,
    #[allow(dead_code)]
    pub updated_at: NaiveDateTime,
    pub client_origin: Option<String>,
    #[allow(dead_code)]
    pub is_group_chat: bool,
}

/// One `kinds` Team row (`_batch_query_teams`).
#[derive(Debug, FromMysqlRow)]
pub struct TeamKindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_user_id")]
    pub user_id: i64,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_namespace")]
    pub namespace: String,
    #[mysql(rename = "kinds_json")]
    pub json: Option<Json>,
}

/// One `tasks_{:04}` Workspace row (`list_api_workspaces_by_refs`). The
/// selected columns are the unqualified projection (the `{table}_*` aliasing
/// was legacy replay-compat no longer needed).
#[derive(Debug)]
pub struct WorkspaceRow {
    #[allow(dead_code)] // `user_id` documents the selected column set
    pub user_id: i64,
    pub name: String,
    #[allow(dead_code)]
    pub namespace: String,
    pub json: Json,
}

impl WorkspaceRow {
    /// Decode one row by its unqualified column names.
    fn from_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            user_id: row.get_required("user_id")?,
            name: row.get_required("name")?,
            namespace: row.get_required("namespace")?,
            json: row.get_required("json")?,
        })
    }
}

/// Team display fields resolved for one task's `teamRef`
/// (`team_id`/`team_name`/`team_namespace`/`team_display_name`/`team_icon`).
#[derive(Debug, Clone)]
pub struct ResolvedTeam {
    pub id: Option<i64>,
    pub name: String,
    pub namespace: String,
    pub display_name: Option<String>,
    pub icon: Option<String>,
}

impl ResolvedTeam {
    /// The source resolution result when the team lookup misses: the
    /// reference's own name and namespace with null id/display/icon
    /// (`build_lite_task_list`: `task_team` is None -> fallback fields).
    pub fn from_ref(name: &str, namespace: &str) -> Self {
        Self {
            id: None,
            name: name.to_string(),
            namespace: namespace.to_string(),
            display_name: None,
            icon: None,
        }
    }
}

/// One page's team references, split the way `_batch_query_teams` splits
/// them: references with an explicit `user_id` (including 0 = public team)
/// form the exact `(name, namespace, user_id) IN` probe, while references
/// whose `user_id` is absent (JSON null / missing key) resolve through the
/// owner-scoped `(name, namespace) IN` probe.
#[derive(Debug, Default)]
pub struct TeamRefs {
    /// `(name, namespace, user_id)` with an explicit owner id.
    pub exact: Vec<(String, String, i64)>,
    /// `(name, namespace)` with an absent owner id.
    pub access_resolved: Vec<(String, String)>,
}

impl TeamRefs {
    /// Collect from the page's `teamRef` values, deduplicating like the
    /// source's Python set.
    pub fn from_page(tasks: &[TaskCandidateRow]) -> Self {
        let mut refs = Self::default();
        for task in tasks {
            let crd = CrdDocument::project(&task.json);
            let Some(team_ref) = crd.spec.as_ref().and_then(|spec| spec.team_ref.as_ref()) else {
                continue;
            };
            let name = team_ref.name();
            if name.is_empty() {
                continue;
            }
            let namespace = team_ref.namespace();
            match team_ref.user_id.as_ref() {
                Some(NumericId::Number(number)) => {
                    let key = (
                        name.to_string(),
                        namespace.to_string(),
                        number.as_i64().unwrap_or(0),
                    );
                    if !refs.exact.contains(&key) {
                        refs.exact.push(key);
                    }
                }
                _ => {
                    let key = (name.to_string(), namespace.to_string());
                    if !refs.access_resolved.contains(&key) {
                        refs.access_resolved.push(key);
                    }
                }
            }
        }
        refs
    }
}

/// Resolved team rows plus the lookup key the per-task projection uses.
/// The source keys exact matches `name:namespace:user_id` and owner-scoped
/// matches `name:namespace` (`_team_ref_key`).
#[derive(Debug, Default)]
pub struct TeamData {
    exact: HashMap<(String, String, i64), TeamKindRow>,
    access_resolved: HashMap<(String, String), TeamKindRow>,
}

impl TeamData {
    /// Resolve one task's `teamRef`. Owner-scoped references that missed the
    /// owned-team query fall back to the reference's own name/namespace with
    /// null id/display/icon, exactly like a `team_data.get(key)` miss.
    pub fn resolve(&self, name: &str, namespace: &str, user_id: Option<i64>) -> ResolvedTeam {
        match user_id {
            Some(user_id) => self
                .exact
                .get(&(name.to_string(), namespace.to_string(), user_id))
                .map(resolved_team)
                .unwrap_or_else(|| ResolvedTeam::from_ref(name, namespace)),
            None => self
                .access_resolved
                .get(&(name.to_string(), namespace.to_string()))
                .map(resolved_team)
                .unwrap_or_else(|| ResolvedTeam::from_ref(name, namespace)),
        }
    }
}

/// `_batch_query_teams`: exact `(name, namespace, user_id) IN` probe for
/// explicit-owner references, then the owner-scoped
/// `kinds.user_id = {user} AND (name, namespace) IN` probe for references
/// without one.
///
/// The source SQLAlchemy renders the tuple values as inline literals in one
/// text `COM_QUERY` (the recorded exchanges); the replay matcher does not
/// pair a row-constructor prepared statement against those recordings, so
/// the tuples are inlined with the same escaping (mirroring
/// `batch_query_workspaces`).
pub async fn batch_query_teams<M>(
    mysql: &M,
    refs: &TeamRefs,
    user_id: i64,
) -> brz_mysql::MysqlResult<TeamData>
where
    M: Mysql,
{
    let mut data = TeamData::default();
    if !refs.exact.is_empty() {
        let mut conditions = String::new();
        for (index, (name, namespace, owner)) in refs.exact.iter().enumerate() {
            if index > 0 {
                conditions.push_str(", ");
            }
            conditions.push_str(&format!(
                "({}, {}, {})",
                quote_literal(name),
                quote_literal(namespace),
                owner
            ));
        }
        let sql = format!(
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.kind = 'Team' \
             AND (kinds.name, kinds.namespace, kinds.user_id) IN ({conditions}) \
             AND kinds.is_active IS true"
        );
        let rows: Vec<TeamKindRow> = mysql.fetch_all(sql.as_str(), ()).await?;
        for row in rows {
            data.exact
                .insert((row.name.clone(), row.namespace.clone(), row.user_id), row);
        }
    }
    let mut priorities: HashMap<(String, String), i32> = HashMap::new();
    if !refs.access_resolved.is_empty() {
        let mut conditions = String::new();
        for (index, (name, namespace)) in refs.access_resolved.iter().enumerate() {
            if index > 0 {
                conditions.push_str(", ");
            }
            conditions.push_str(&format!(
                "({}, {})",
                quote_literal(name),
                quote_literal(namespace)
            ));
        }
        let sql = format!(
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.kind = 'Team' \
             AND kinds.user_id = {user_id} AND (kinds.name, kinds.namespace) IN ({conditions}) \
             AND kinds.is_active IS true"
        );
        let rows: Vec<TeamKindRow> = mysql.fetch_all(sql.as_str(), ()).await?;
        for row in rows {
            data.access_resolved
                .insert((row.name.clone(), row.namespace.clone()), row);
        }
        // References the owned-team probe did not resolve continue through
        // the shared-team fallback (`_batch_query_teams` steps 2-4).
        let unresolved: Vec<(String, String)> = refs
            .access_resolved
            .iter()
            .filter(|(name, namespace)| {
                !data
                    .access_resolved
                    .contains_key(&(name.clone(), namespace.clone()))
            })
            .cloned()
            .collect();
        if unresolved.is_empty() {
            return Ok(data);
        }
        // `_get_accessible_team_ids`: direct shares plus namespace grants.
        let mut accessible_ids = direct_shared_team_ids(mysql, user_id).await?;
        let namespace_ids = accessible_namespace_ids(mysql, user_id).await?;
        if !namespace_ids.is_empty() {
            accessible_ids.extend(namespace_granted_team_ids(mysql, &namespace_ids).await?);
        }
        let mut conditions = String::new();
        for (index, (name, namespace)) in unresolved.iter().enumerate() {
            if index > 0 {
                conditions.push_str(", ");
            }
            conditions.push_str(&format!(
                "({}, {})",
                quote_literal(name),
                quote_literal(namespace)
            ));
        }
        let sql = accessible_teams_sql(&conditions, user_id, &accessible_ids);
        let rows: Vec<TeamKindRow> = mysql.fetch_all(sql.as_str(), ()).await?;
        for row in rows {
            let key = (row.name.clone(), row.namespace.clone());
            let priority = team_scope_priority(row.user_id, user_id);
            let improves = match data.access_resolved.get(&key) {
                None => true,
                Some(_) => priorities.get(&key).is_some_and(|best| priority < *best),
            };
            if improves {
                data.access_resolved.insert(key.clone(), row);
                priorities.insert(key, priority);
            }
        }
    }
    Ok(data)
}

/// `_get_team_scope_priority`: owned teams win, other users' teams come
/// next, public (user 0) teams last.
fn team_scope_priority(team_user_id: i64, user_id: i64) -> i32 {
    if team_user_id == user_id {
        0
    } else if team_user_id == 0 {
        2
    } else {
        1
    }
}

/// The shared-team probe (`_batch_query_teams` step 4): the still-unresolved
/// `(name, namespace)` references against owner-or-public teams, or against
/// any team when the user holds shared-team grants.
fn accessible_teams_sql(conditions: &str, user_id: i64, accessible_ids: &[i64]) -> String {
    let mut ids: Vec<i64> = Vec::new();
    for id in accessible_ids {
        if !ids.contains(id) {
            ids.push(*id);
        }
    }
    let access_clause = if ids.is_empty() {
        format!("kinds.user_id IN ({user_id}, 0)")
    } else {
        let list = ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        format!("(kinds.user_id IN ({user_id}, 0) OR kinds.id IN ({list}))")
    };
    format!(
        "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
         kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
         kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
         kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
         kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.kind = 'Team' \
         AND (kinds.name, kinds.namespace) IN ({conditions}) \
         AND kinds.is_active IS true AND {access_clause}"
    )
}

/// `_get_direct_shared_team_ids`: Team resource ids directly shared with the
/// user (approved `resource_members` rows).
async fn direct_shared_team_ids<M>(mysql: &M, user_id: i64) -> brz_mysql::MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "resource_members_resource_id")]
        resource_id: i64,
    }
    let sql = format!(
        "SELECT resource_members.resource_id AS resource_members_resource_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type IN ('Team', 'TEAM') \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = {entity} \
         AND resource_members.status IN ('approved', 'APPROVED')",
        entity = quote_literal(&user_id.to_string())
    );
    let rows: Vec<Row> = mysql.fetch_all(sql.as_str(), ()).await?;
    Ok(rows.into_iter().map(|row| row.resource_id).collect())
}

/// `_get_user_accessible_namespace_ids`: namespaces the user holds a
/// Reporter-or-higher approved membership in, plus their active child
/// namespaces (`name LIKE 'parent/%'`).
async fn accessible_namespace_ids<M>(mysql: &M, user_id: i64) -> brz_mysql::MysqlResult<Vec<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct MembershipRow {
        #[mysql(rename = "namespace_id")]
        id: i64,
        #[mysql(rename = "namespace_name")]
        name: String,
    }
    #[derive(Debug, FromMysqlRow)]
    struct ChildRow {
        #[mysql(rename = "namespace_id")]
        id: i64,
    }
    let entity = quote_literal(&user_id.to_string());
    let direct_sql = format!(
        "SELECT namespace.id AS namespace_id, namespace.name AS namespace_name \n\
         FROM namespace INNER JOIN resource_members \
         ON resource_members.resource_type = 'Namespace' \
         AND resource_members.resource_id = namespace.id \n\
         WHERE namespace.is_active IS true AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = {entity} \
         AND resource_members.status IN ('approved', 'APPROVED') \
         AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter')"
    );
    let direct: Vec<MembershipRow> = mysql.fetch_all(direct_sql.as_str(), ()).await?;
    let mut ids: Vec<String> = direct.iter().map(|row| row.id.to_string()).collect();
    if direct.is_empty() {
        return Ok(ids);
    }
    let patterns: Vec<String> = direct
        .iter()
        .map(|row| format!("{}/%", escape_sql_like(&row.name)))
        .collect();
    let like: Vec<String> = patterns
        .iter()
        .map(|pattern| {
            // SQLAlchemy renders the pattern as a quoted string literal
            // (`LIKE 'team-check/%' ESCAPE '\\'`); an unquoted
            // pattern is invalid SQL that fails the statement prepare.
            format!(
                "namespace.name LIKE {} ESCAPE '\\\\'",
                quote_literal(pattern)
            )
        })
        .collect();
    let name_filter = if like.len() == 1 {
        like.into_iter().next().expect("checked single element")
    } else {
        format!("({})", like.join(" OR "))
    };
    let child_sql = format!(
        "SELECT namespace.id AS namespace_id \n\
         FROM namespace \n\
         WHERE namespace.is_active IS true AND {name_filter}"
    );
    let children: Vec<ChildRow> = mysql.fetch_all(child_sql.as_str(), ()).await?;
    ids.extend(children.iter().map(|row| row.id.to_string()));
    Ok(ids)
}

/// `_escape_sql_like`: backslash, percent and underscore are escaped for a
/// `LIKE ... ESCAPE '\\'` pattern.
fn escape_sql_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(character);
            }
            other => out.push(other),
        }
    }
    out
}

/// `_get_namespace_granted_team_ids`: Team resource ids granted to the
/// accessible namespaces.
async fn namespace_granted_team_ids<M>(
    mysql: &M,
    namespace_ids: &[String],
) -> brz_mysql::MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "resource_members_resource_id")]
        resource_id: i64,
    }
    let entities = namespace_ids
        .iter()
        .map(|id| quote_literal(id))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT resource_members.resource_id AS resource_members_resource_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type IN ('Team', 'TEAM') \
         AND resource_members.entity_type = 'namespace' \
         AND resource_members.entity_id IN ({entities}) \
         AND resource_members.status IN ('approved', 'APPROVED')"
    );
    let rows: Vec<Row> = mysql.fetch_all(sql.as_str(), ()).await?;
    Ok(rows.into_iter().map(|row| row.resource_id).collect())
}

/// Team display fields for one resolved `Kind` row
/// (`_get_team_display_name` / `_get_team_icon` read the CRD
/// `metadata.displayName` and `spec.icon`).
pub fn resolved_team(row: &TeamKindRow) -> ResolvedTeam {
    let json = row.json.as_ref();
    let display_name = json
        .and_then(|json| json.get("metadata"))
        .and_then(|metadata| metadata.get("displayName"))
        .and_then(Json::as_str)
        .map(str::to_string);
    let icon = json
        .and_then(|json| json.get("spec"))
        .and_then(|spec| spec.get("icon"))
        .and_then(Json::as_str)
        .map(str::to_string);
    ResolvedTeam {
        id: Some(row.id),
        name: row.name.clone(),
        namespace: row.namespace.clone(),
        display_name,
        icon,
    }
}

/// Escape one string literal with MySQL's default quoting rules.
fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for character in value.chars() {
        match character {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            // Ctrl-Z never appears in these identifiers; every other
            // character (including all non-ASCII) is copied verbatim so
            // UTF-8 names stay byte-identical.
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

/// Workspace git-repository data by `(name, namespace)` reference
/// (`_batch_query_workspaces` through the configured workspace repository).
///
/// The source SQLAlchemy renders the `(user_id, namespace, name)` tuples as
/// inline literals in one text `COM_QUERY` (the recorded exchange), not as a
/// 3x-refs prepared-statement parameter list; a large prepared parameter
/// count also stalls some MySQL client transports. The tuple values are
/// inlined with the same escaping to keep the recorded call topology.
pub async fn batch_query_workspaces<M>(
    mysql: &M,
    user_id: i64,
    refs: &[(String, String)],
) -> brz_mysql::MysqlResult<HashMap<(String, String), String>>
where
    M: Mysql,
{
    if refs.is_empty() {
        return Ok(HashMap::new());
    }
    let mut conditions = String::new();
    for (index, (name, namespace)) in refs.iter().enumerate() {
        if index > 0 {
            conditions.push_str(", ");
        }
        conditions.push_str(&format!(
            "({}, {}, {})",
            user_id,
            quote_literal(namespace),
            quote_literal(name)
        ));
    }
    let mut sql = String::from(
        "SELECT id, user_id, kind, name, namespace, json, is_active,
                created_at, updated_at, project_id, client_origin, is_group_chat
         FROM {{tasks}}
         WHERE kind = 'Workspace' AND is_active = 1
         AND (user_id, namespace, name) IN (",
    );
    sql.push_str(&conditions);
    sql.push(')');
    let rows: Vec<brz_mysql::MysqlRow> = mysql
        .route(ByUserId(user_id as u64))
        .fetch_all(sql.as_str(), ())
        .await?;
    let rows: Vec<WorkspaceRow> = rows
        .iter()
        .map(WorkspaceRow::from_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let git_repo = row
                .json
                .get("spec")
                .and_then(|spec| spec.get("repository"))
                .and_then(|repository| repository.get("gitRepo"))
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string();
            ((row.name, row.namespace), git_repo)
        })
        .collect())
}

/// `list_personal_task_candidates_after`
/// (the configured store): the owner's routed task table,
/// ordered `created_at DESC, id DESC`, with the keyset cursor filter.
/// `batch_size = max(limit + 1, 100)` mirrors the source.
pub async fn list_personal_task_candidates_after<M>(
    mysql: &M,
    user_id: i64,
    limit: i64,
    cursor: Option<(NaiveDateTime, i64)>,
    client_origin: Option<&str>,
) -> brz_mysql::MysqlResult<Vec<TaskCandidateRow>>
where
    M: Mysql,
{
    // Keep predicate and binding order aligned with the source keyset query.
    let mut sql = String::from(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at,
                updated_at, project_id, client_origin, is_group_chat
         FROM {{tasks}}
         WHERE user_id = ? AND kind = 'Task' AND is_active = 1
         AND namespace != 'system' AND is_group_chat = false",
    );
    if client_origin.is_some() {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" AND project_id = 0");
    if cursor.is_some() {
        sql.push_str(" AND (created_at < ? OR (created_at = ? AND id < ?))");
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");

    // Argument order: `user_id` (int literal), optional `client_origin`
    // (string), optional keyset cursor (`created_at` datetime twice, `id`
    // int), then `limit` (int). `serde_json::Value` binding would serialize
    // every value as a JSON string and miss the recorded literals.
    let mut args: Vec<UnionArg> = vec![UnionArg::Int(user_id)];
    if let Some(origin) = client_origin {
        args.push(UnionArg::Str(origin.to_string()));
    }
    if let Some((cursor_created_at, cursor_id)) = cursor {
        args.push(UnionArg::DateTime(cursor_created_at));
        args.push(UnionArg::DateTime(cursor_created_at));
        args.push(UnionArg::Int(cursor_id));
    }
    args.push(UnionArg::Int(limit));
    mysql
        .route(ByUserId(user_id as u64))
        .fetch_all(sql.as_str(), args)
        .await
}

impl TaskCandidateRow {
    /// The keyset cursor key (`(created_at, id)` of the row).
    pub fn clone_dyn(&self) -> (NaiveDateTime, i64) {
        (self.created_at, self.id)
    }
}

/// `_filter_personal_tasks`: keep tasks matching the requested `types`
/// (online/offline/subscription|flow) and exclude `DELETE` status.
pub fn filter_personal_tasks(
    tasks: Vec<TaskCandidateRow>,
    types: &[String],
) -> Vec<TaskCandidateRow> {
    let include_online = types.iter().any(|t| t == "online");
    let include_offline = types.iter().any(|t| t == "offline");
    let include_subscription = types.iter().any(|t| t == "subscription" || t == "flow");
    tasks
        .into_iter()
        .filter(|task| {
            let status = task
                .json
                .get("status")
                .and_then(|status| status.get("status"))
                .and_then(Json::as_str)
                .unwrap_or("PENDING");
            if status == "DELETE" {
                return false;
            }
            let labels = task
                .json
                .get("metadata")
                .and_then(|metadata| metadata.get("labels"))
                .cloned()
                .unwrap_or_default();
            let label = |key: &str| {
                labels
                    .get(key)
                    .and_then(Json::as_str)
                    .map(str::to_string)
                    .unwrap_or_default()
            };
            let is_subscription = label("type") == "subscription";
            let is_code = label("taskType") == "code";
            if is_subscription {
                include_subscription
            } else if is_code {
                include_offline
            } else {
                include_online
            }
        })
        .collect()
}

/// One bound argument preserving the recorded literal's token kind: owner
/// user ids render as integer literals, names/namespaces/origins as quoted
/// strings, and keyset cursors as datetimes.
#[derive(Debug, Clone)]
pub enum UnionArg {
    Int(i64),
    Str(String),
    DateTime(NaiveDateTime),
}

impl brz_mysql::MysqlValue for UnionArg {
    fn write(self, writer: &mut brz_mysql::MysqlValueWriter) -> brz_mysql::MysqlResult<()> {
        match self {
            Self::Int(value) => value.write(writer),
            Self::Str(value) => value.write(writer),
            Self::DateTime(value) => value.write(writer),
        }
    }
    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Int(value) => value.encoded_size_hint(),
            Self::Str(value) => value.encoded_size_hint(),
            Self::DateTime(value) => value.encoded_size_hint(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(labels: serde_json::Value, status: &str) -> TaskCandidateRow {
        let epoch = chrono::DateTime::from_timestamp(0, 0)
            .expect("valid epoch")
            .naive_utc();
        TaskCandidateRow {
            id: 1,
            user_id: 1,
            json: serde_json::json!({
                "metadata": labels,
                "status": {"status": status},
            }),
            created_at: epoch,
            updated_at: epoch,
            client_origin: None,
            is_group_chat: false,
        }
    }

    fn with_id(mut task: TaskCandidateRow, id: i64) -> TaskCandidateRow {
        task.id = id;
        task
    }

    fn test_tasks() -> Vec<TaskCandidateRow> {
        vec![
            with_id(
                candidate(
                    serde_json::json!({"labels": {"taskType": "chat"}}),
                    "COMPLETED",
                ),
                1,
            ),
            with_id(
                candidate(
                    serde_json::json!({"labels": {"taskType": "code"}}),
                    "COMPLETED",
                ),
                2,
            ),
            with_id(
                candidate(
                    serde_json::json!({"labels": {"type": "subscription"}}),
                    "COMPLETED",
                ),
                3,
            ),
            with_id(
                candidate(serde_json::json!({"labels": {"type": "flow"}}), "COMPLETED"),
                4,
            ),
            with_id(candidate(serde_json::json!({"labels": {}}), "DELETE"), 5),
        ]
    }

    #[test]
    fn online_offline_and_flow_filters_match_source_rules() {
        let online =
            filter_personal_tasks(test_tasks(), &["online".to_string(), "offline".to_string()]);
        // chat + code + knowledge types survive (non-subscription,
        // non-DELETE); the subscription row and the DELETE row drop out.
        assert_eq!(online.len(), 3);
        let flow = filter_personal_tasks(test_tasks(), &["flow".to_string()]);
        // The subscription row survives the flow selector (the `flow` alias
        // includes `subscription`); the plain `flow`-label row is a
        // non-subscription online task, so it drops out without `online`.
        assert_eq!(flow.len(), 1);
    }

    #[test]
    fn accessible_teams_sql_matches_the_recorded_owner_filter() {
        // Recorded exchange seq 2351: no shared grants, so the fallback
        // filters to owner-or-public teams with the literal IN list.
        let sql = accessible_teams_sql("('wegent-chat', 'default')", 2826, &[]);
        assert!(sql.contains("kinds.user_id IN (2826, 0)"), "{sql}");
        assert!(sql.contains("(kinds.name, kinds.namespace) IN (('wegent-chat', 'default'))"));
        assert!(!sql.contains("OR kinds.id IN"));
    }

    #[test]
    fn accessible_teams_sql_includes_shared_ids_when_granted() {
        let sql = accessible_teams_sql("('team', 'default')", 7, &[5, 5, 9]);
        assert!(
            sql.contains("(kinds.user_id IN (7, 0) OR kinds.id IN (5, 9))"),
            "{sql}"
        );
    }

    #[test]
    fn like_patterns_escape_wildcards_like_the_source() {
        assert_eq!(escape_sql_like("a\\b%c_d"), "a\\\\b\\%c\\_d");
        // The child-namespace pattern appends the literal `/%` suffix.
        let pattern = format!("{}/%", escape_sql_like("team%1"));
        assert_eq!(pattern, "team\\%1/%");
    }

    #[test]
    fn child_namespace_like_renders_a_quoted_literal() {
        // Recorded exchange (case d62e625c seq 1208):
        // `namespace.name LIKE 'team-check/%' ESCAPE '\\'` — the
        // pattern is a quoted string literal, never a bare token.
        let name = "team-check";
        let pattern = format!("{}/%", escape_sql_like(name));
        let rendered = format!(
            "namespace.name LIKE {} ESCAPE '\\\\'",
            quote_literal(&pattern)
        );
        assert_eq!(rendered, "namespace.name LIKE 'team-check/%' ESCAPE '\\\\'");
        // Wildcards stay escaped inside the quotes; the literal rendering
        // doubles the escaped backslash (`a\%b/%` value -> `'a\\%b/%'`).
        let tricky = format!("{}/%", escape_sql_like("a%b"));
        assert_eq!(
            format!(
                "namespace.name LIKE {} ESCAPE '\\\\'",
                quote_literal(&tricky)
            ),
            "namespace.name LIKE 'a\\\\%b/%' ESCAPE '\\\\'"
        );
    }

    #[test]
    fn team_scope_priority_prefers_owned_then_shared_then_public() {
        assert_eq!(team_scope_priority(7, 7), 0);
        assert_eq!(team_scope_priority(9, 7), 1);
        assert_eq!(team_scope_priority(0, 7), 2);
    }
}

#[cfg(test)]
mod sql_tests {
    use super::*;
    use crate::sql_test_support::{QueryCapture, Route};

    #[tokio::test]
    async fn personal_task_query_keeps_cursor_and_origin_binding_order() {
        let timestamp = chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc();
        for cursor in [None, Some((timestamp, 41))] {
            for origin in [None, Some(""), Some("client'\\name")] {
                let mysql = QueryCapture::default();
                list_personal_task_candidates_after(&mysql, 7, 100, cursor, origin)
                    .await
                    .unwrap();
                let queries = mysql.queries();
                let query = &queries[0];
                assert_eq!(query.route, Route::User(7));
                assert_eq!(
                    query.args,
                    2 + usize::from(origin.is_some()) + 3 * usize::from(cursor.is_some())
                );
                assert_eq!(
                    query.sql.contains("AND client_origin = ?"),
                    origin.is_some()
                );
                assert_eq!(query.sql.contains("created_at < ?"), cursor.is_some());
                if origin.is_some() {
                    assert!(
                        query
                            .sql
                            .contains("AND client_origin = ? AND project_id = 0")
                    );
                }
                if cursor.is_some() {
                    assert!(query.sql.contains("AND project_id = 0 AND (created_at < ?"));
                }
                assert!(
                    query
                        .sql
                        .ends_with("ORDER BY created_at DESC, id DESC LIMIT ?")
                );
                assert!(!query.sql.contains("client'"));
            }
        }
    }

    #[tokio::test]
    async fn workspace_batch_keeps_text_query_escaping_and_empty_fast_path() {
        let mysql = QueryCapture::default();
        assert!(
            batch_query_workspaces(&mysql, 7, &[])
                .await
                .unwrap()
                .is_empty()
        );
        assert!(mysql.queries().is_empty());
        batch_query_workspaces(
            &mysql,
            7,
            &[
                ("a'b".into(), "ns\\x".into()),
                ("second".into(), "default".into()),
            ],
        )
        .await
        .unwrap();
        let queries = mysql.queries();
        assert_eq!(queries[0].route, Route::User(7));
        assert_eq!(queries[0].args, 0);
        assert!(
            queries[0]
                .sql
                .ends_with(r"IN ((7, 'ns\\x', 'a\'b'), (7, 'default', 'second'))")
        );
    }
}
