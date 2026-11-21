// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Revalidation uses the shared project role query and the current revocable
//! workspace resource grants. Definition ownership never grants project use.

use super::store::{COLUMNS, LIVE, Node};
use crate::{
    responses::create::resolution::{self, KindRow},
    state::AppState,
};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Mysql, MysqlRow};
use tokio::sync::OnceCell;
use wegent_backend_persistence::mysql_query::MysqlQuery;

#[derive(FromMysqlRow)]
struct Parent {
    workspace_id: i64,
}
#[derive(FromMysqlRow)]
struct Grant {
    status: String,
    role: String,
}

/// The project row the second permission check loads
/// (`require_cloud_project_role`'s `db.get(CloudProject, ...)`); only the
/// fields `_execution_permission` reads are kept.
#[derive(FromMysqlRow)]
struct ProjectRow {
    id: String,
    /// `loop_items.project_key`: the prefix `issues::load` parses external
    /// provider issue ids with, so the loaded project must keep it. The
    /// column is nullable (local projects store NULL); an absent key keeps
    /// the previous empty-string behaviour.
    project_key: Option<String>,
    /// `loop_items.metadata` is nullable too (the previous store rendered it
    /// as `JSON_OBJECT()`); an absent document becomes `{}`.
    metadata: Option<brz_mysql::Json<serde_json::Value>>,
}

/// Project data for one project during candidate selection. Permission checks
/// and device grants are read separately for each candidate.
#[derive(Default)]
pub(crate) struct ProjectReads {
    node: OnceCell<Node>,
    record: OnceCell<ProjectRecord>,
}

/// One project's current execution authority.
pub(crate) struct ProjectAccess {
    pub project: Node,
    pub workspace_id: i64,
    pub priority: i64,
}

#[derive(FromMysqlRow)]
struct Aggregate {
    workspace_id: Option<i64>,
    priority: Option<i64>,
}

#[derive(FromMysqlRow)]
struct WorkspaceState {
    kind: String,
    is_active: i8,
}

/// The point query checks active users, the unique active workspace, and
/// current grants. Execution authorization only needs its effective priority
/// and workspace ID.
async fn permission_check_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    user_id: i64,
) -> Result<Option<(i64, Option<i64>)>> {
    let statement = crate::cloud_projects::project_permission_statement(
        i32::try_from(user_id)?,
        project_id.parse()?,
    );
    let aggregate: Option<Aggregate> = query.fetch_optional(statement, ()).await?;
    Ok(aggregate.and_then(|row| row.priority.map(|priority| (priority, row.workspace_id))))
}

/// `require_cloud_project_role`'s `db.get(CloudProject, str(project_id))`
/// (`cloud_projects/access.py:144`).
async fn load_project_on(query: &mut impl MysqlQuery, project_id: &str) -> Result<Node> {
    let row: Option<ProjectRow> = query
        .fetch_optional(project_load_statement(project_id), ())
        .await?;
    Ok(project_node(row.context("Cloud project not found")?))
}

fn project_load_statement(project_id: &str) -> String {
    format!(
        "SELECT id, project_key, metadata FROM loop_items \
         WHERE id = '{project_id}' AND resource_type = 'project'"
    )
}

/// The loaded project row as the `Node` the issue/group/agent checks read.
fn project_node(row: ProjectRow) -> Node {
    Node {
        id: row.id,
        project_key: row.project_key.unwrap_or_default(),
        metadata: brz_mysql::Json(
            row.metadata
                .map(|metadata| metadata.0)
                .unwrap_or_else(|| serde_json::json!({})),
        ),
        resource_type: "project".into(),
        cloud_project_id: String::new(),
        parent_id: String::new(),
        loop_item_id: String::new(),
        name: String::new(),
        next_item_number: 1,
        local_project_id: 0,
        assignee_user_id: 0,
        assignee_team_id: 0,
        priority: String::new(),
        title: String::new(),
        description: String::new(),
        status: String::new(),
        source: String::new(),
        created_by_user_id: 0,
        user_id: 0,
        task_user_id: 0,
        task_id: String::new(),
        task_title: String::new(),
        device_id: String::new(),
        backend_task_id: 0,
        assignee_agent_id: String::new(),
        due_at: None,
        version: 1,
    }
}

/// The Agent fields needed for execution authorization.
#[derive(FromMysqlRow)]
struct RawNodeRow {
    pub id: String,
    pub cloud_project_id: String,
    pub created_by_user_id: Option<i64>,
    pub assignee_user_id: Option<i64>,
    pub metadata: Option<brz_mysql::Json<serde_json::Value>>,
}

#[derive(FromMysqlRow)]
struct LegacyAgentRow {
    created_by_user_id: Option<i64>,
    metadata: Option<brz_mysql::Json<serde_json::Value>>,
}

/// `require_project_team` (`collaboration_permissions.py:305-374`) for the
/// execution path: the parent workspace Kind, the team grant, the team Kind
/// and the legacy-binding probe, using the project's already-known workspace
/// instead of a fresh parent aggregate.
pub(crate) async fn team_execution_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    workspace_id: i64,
    team_id: i64,
) -> Result<KindRow> {
    let workspace: Option<WorkspaceState> = query
        .fetch_optional(
            "SELECT kind, is_active FROM kinds WHERE id = ?",
            (workspace_id,),
        )
        .await?;
    let workspace = workspace.context("Project not found")?;
    if workspace.kind != "CollaborationWorkspace" || workspace.is_active == 0 {
        bail!("Project not found");
    }
    let grant: Option<Grant> = query
        .fetch_optional(team_grant_statement(workspace_id, team_id), ())
        .await?;
    // `db.get(Kind, team_id)`: the plain labeled by-id read; the kind and
    // active checks stay in code, never in the predicate.
    let team: Option<KindRow> = query
        .fetch_optional(resolution::kind_by_id_statement(), (team_id,))
        .await?;
    let team = team.context("Agent resource authorization is revoked or unavailable")?;
    if team.kind != "Team" || team.is_active == 0 {
        bail!("Agent resource authorization is revoked or unavailable");
    }
    if grant.is_none() {
        let bindings: Vec<LegacyAgentRow> = query
            .fetch_all(legacy_bindings_statement(project_id, team_id), ())
            .await?;
        let legacy_ok = bindings.iter().any(|binding| {
            let metadata = binding
                .metadata
                .as_ref()
                .map(|metadata| metadata.0.clone())
                .unwrap_or_else(|| serde_json::json!({}));
            !truthy(&metadata["authorization_version"])
                && (team.user_id == 0 || binding.created_by_user_id == Some(team.user_id))
        });
        if !legacy_ok {
            bail!("Agent resource authorization is revoked or unavailable");
        }
    } else if let Some(grant) = grant
        && !approved(&grant)
    {
        bail!("Agent resource authorization is revoked or unavailable");
    }
    // `require_binding`: the project still has an active agent bound to it.
    let binding: Option<MysqlRow> = query
        .fetch_optional(binding_probe_statement(project_id, team_id), ())
        .await?;
    if binding.is_none() {
        bail!("Agent is not enabled in this project");
    }
    Ok(team)
}

fn team_grant_statement(workspace_id: i64, team_id: i64) -> String {
    format!(
        "SELECT status, role \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Team' \
         AND resource_members.resource_id = {team_id} \
         AND resource_members.entity_type = 'workspace' \
         AND resource_members.entity_id = '{workspace_id}' \n LIMIT 1"
    )
}

fn binding_probe_statement(project_id: &str, team_id: i64) -> String {
    format!(
        "SELECT loop_items.id AS loop_items_id \nFROM loop_items \n\
         WHERE loop_items.cloud_project_id = '{project_id}' \
         AND loop_items.status = 'active' \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND CAST(CASE JSON_EXTRACT(loop_items.metadata, '$.\\\"wegent_team_id\\\"') \
         WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, \
         '$.\\\"wegent_team_id\\\"')) END AS SIGNED INTEGER) = {team_id} \
         AND loop_items.resource_type IN ('chat_agent') \n LIMIT 1"
    )
}

fn legacy_bindings_statement(project_id: &str, team_id: i64) -> String {
    format!(
        "SELECT created_by_user_id, metadata \nFROM loop_items \n\
         WHERE loop_items.cloud_project_id = '{project_id}' \
         AND loop_items.status = 'active' \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND CAST(CASE JSON_EXTRACT(loop_items.metadata, '$.\\\"wegent_team_id\\\"') \
         WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, \
         '$.\\\"wegent_team_id\\\"')) END AS SIGNED INTEGER) = {team_id} \
         AND loop_items.resource_type IN ('chat_agent')"
    )
}

/// `_require_agent_use` (`collaboration_revocation.py:68-108`) for the
/// execution path: the agent Kind point read, its visibility, and the team
/// authorization with the project's already-resolved workspace.
pub(crate) async fn agent_execution_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    workspace_id: i64,
    agent_id: &str,
    user_id: i64,
) -> Result<Option<Node>> {
    let agent: Option<RawNodeRow> = query
        .fetch_optional(
            format!(
                "SELECT id, cloud_project_id, created_by_user_id, assignee_user_id, metadata \nFROM loop_items \n\
                 WHERE loop_items.id = '{agent_id}' \
                 AND loop_items.resource_type IN ('chat_agent')"
            ),
            (),
        )
        .await?;
    let Some(agent) = agent else {
        return Ok(None);
    };
    let metadata = agent
        .metadata
        .as_ref()
        .map(|metadata| metadata.0.clone())
        .unwrap_or_else(|| serde_json::json!({}));
    if metadata["visibility"] == "private" && agent.created_by_user_id != Some(user_id) {
        bail!("Private Agent is not shared with this member");
    }
    if let Some(team_id) = integer(&metadata["wegent_team_id"]).filter(|v| *v != 0) {
        team_execution_on(query, project_id, workspace_id, team_id).await?;
    } else {
        let grant: Option<Grant> = query
            .fetch_optional(
                format!(
                    "SELECT status,role FROM resource_members \
                     WHERE resource_type='Workspace' AND resource_id={workspace_id} \
                     AND entity_type='project_agent' AND entity_id='{agent_id}' \n LIMIT 1"
                ),
                (),
            )
            .await?;
        if !grant.as_ref().is_some_and(approved)
            && (grant.is_some() || truthy(&metadata["authorization_version"]))
        {
            bail!("Agent resource authorization is revoked or unavailable");
        }
    }
    Ok(Some(Node {
        id: agent.id,
        cloud_project_id: agent.cloud_project_id,
        created_by_user_id: agent.created_by_user_id.unwrap_or(0),
        assignee_user_id: agent.assignee_user_id.unwrap_or(0),
        metadata: brz_mysql::Json(metadata),
        resource_type: "chat_agent".into(),
        parent_id: String::new(),
        loop_item_id: String::new(),
        name: String::new(),
        project_key: String::new(),
        next_item_number: 1,
        local_project_id: 0,
        assignee_team_id: 0,
        priority: String::new(),
        title: String::new(),
        description: String::new(),
        status: String::new(),
        source: String::new(),
        user_id: 0,
        task_user_id: 0,
        task_id: String::new(),
        task_title: String::new(),
        device_id: String::new(),
        backend_task_id: 0,
        assignee_agent_id: String::new(),
        due_at: None,
        version: 1,
    }))
}

#[derive(FromMysqlRow)]
struct ProjectRecord {
    workspace_id: Option<i64>,
    status: String,
    metadata: Option<brz_mysql::Json<serde_json::Value>>,
}

#[derive(FromMysqlRow)]
struct DeviceGrantRow {
    resource_id: i64,
}

fn project_record_statement(project_id: &str) -> String {
    let workspace = crate::cloud_projects::WORKSPACE_ID_EXPRESSION;
    format!(
        "SELECT {workspace} AS workspace_id, status, metadata FROM loop_items \
         WHERE id = '{project_id}' AND resource_type = 'project'"
    )
}

async fn load_project_record_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
) -> Result<ProjectRecord> {
    query
        .fetch_optional(project_record_statement(project_id), ())
        .await?
        .context("Project not found")
}

/// `device_grants` (`runner_routing.py`): approved Device grants of one
/// workspace or project scope.
fn device_grants_statement(entity_type: &str, entity_id: &str) -> String {
    format!(
        "SELECT resource_id \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Device' \
         AND resource_members.entity_type = '{entity_type}' \
         AND resource_members.entity_id = '{entity_id}' \
         AND resource_members.status = 'approved' \
         AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer')"
    )
}

async fn device_grants_on(
    query: &mut impl MysqlQuery,
    entity_type: &str,
    entity_id: &str,
) -> Result<std::collections::BTreeSet<i64>> {
    let rows: Vec<DeviceGrantRow> = query
        .fetch_all(device_grants_statement(entity_type, entity_id), ())
        .await?;
    Ok(rows.into_iter().map(|row| row.resource_id).collect())
}

/// `execution_environment_ids` (`runner_routing.py:81-87`): the explicit
/// project/workspace device consent plus, for one agent, its legacy
/// owner-installed device reference.
pub(crate) async fn execution_environment_ids_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    agent_id: &str,
) -> Result<std::collections::BTreeSet<i64>> {
    execution_environment_ids_with_reads_on(query, project_id, agent_id, None).await
}

pub(crate) async fn execution_environment_ids_with_reads_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    agent_id: &str,
    reads: Option<&ProjectReads>,
) -> Result<std::collections::BTreeSet<i64>> {
    let fresh;
    let project = match reads {
        Some(reads) => {
            reads
                .record
                .get_or_try_init(|| load_project_record_on(query, project_id))
                .await?
        }
        None => {
            fresh = load_project_record_on(query, project_id).await?;
            &fresh
        }
    };
    let Some(workspace_id) = project.workspace_id else {
        return Ok(std::collections::BTreeSet::new());
    };

    let workspace_grants = device_grants_on(query, "workspace", &workspace_id.to_string()).await?;
    let project_grants = device_grants_on(query, "project", project_id).await?;
    let mut ids: std::collections::BTreeSet<_> = workspace_grants
        .intersection(&project_grants)
        .copied()
        .collect();
    if !agent_id.is_empty() && project.status == "active" {
        ids.extend(
            legacy_project_environment_ids_on(query, project_id, agent_id, workspace_id, project)
                .await?,
        );
    }
    Ok(ids)
}

fn legacy_agents_statement(project_id: &str, agent_id: &str) -> String {
    format!(
        "SELECT created_by_user_id, metadata \nFROM loop_items \n\
         WHERE loop_items.cloud_project_id = '{project_id}' \
         AND loop_items.status = 'active' \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.id = '{agent_id}' \
         AND loop_items.resource_type IN ('chat_agent')"
    )
}

fn legacy_device_grant_statement(workspace_id: i64, project_id: &str, device_id: i64) -> String {
    format!(
        "SELECT 1 \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Device' \
         AND resource_members.resource_id = {device_id} \
         AND ((resource_members.entity_type = 'workspace' \
         AND resource_members.entity_id = '{workspace_id}') \
         OR (resource_members.entity_type = 'project' \
         AND resource_members.entity_id = '{project_id}')) \
         AND resource_members.status = 'approved' \
         AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer') \n LIMIT 1"
    )
}

async fn legacy_project_environment_ids_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    agent_id: &str,
    workspace_id: i64,
    record: &ProjectRecord,
) -> Result<std::collections::BTreeSet<i64>> {
    let revoked = record
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.0["legacy_device_revocations"].as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(integer)
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    let agents: Vec<LegacyAgentRow> = query
        .fetch_all(legacy_agents_statement(project_id, agent_id), ())
        .await?;
    let mut ids = std::collections::BTreeSet::new();
    for agent in agents {
        let agent_metadata = agent
            .metadata
            .as_ref()
            .map(|metadata| metadata.0.clone())
            .unwrap_or_else(|| serde_json::json!({}));
        let device_id = agent_metadata["device_id"].as_str().unwrap_or("");
        let created_by = agent.created_by_user_id.unwrap_or(0);
        if truthy(&agent_metadata["authorization_version"])
            || device_id.is_empty()
            || created_by == 0
        {
            continue;
        }
        let Some(device) =
            crate::device_identity::resolve_owned_device_alias_on(query, created_by, device_id)
                .await?
        else {
            continue;
        };
        if revoked.contains(&device.id) {
            continue;
        }
        let grant: Option<(i64,)> = query
            .fetch_optional(
                legacy_device_grant_statement(workspace_id, project_id, device.id),
                (),
            )
            .await?;
        if grant.is_some() {
            ids.insert(device.id);
        }
    }
    Ok(ids)
}

/// Resolve the current role for execution, then load the authorized project.
pub(crate) async fn execution_access_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    user_id: i64,
) -> Result<ProjectAccess> {
    execution_access_with_reads_on(query, project_id, user_id, None).await
}

pub(crate) async fn execution_access_with_reads_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    user_id: i64,
    reads: Option<&ProjectReads>,
) -> Result<ProjectAccess> {
    // Execute access also satisfies the read threshold for the same role.
    let (priority, workspace_id) = permission_check_on(query, project_id, user_id)
        .await?
        .context("Project not found or membership revoked")?;
    if priority > 2 {
        bail!("Insufficient permission to execute in this project");
    }
    let project = match reads {
        Some(reads) => reads
            .node
            .get_or_try_init(|| load_project_on(query, project_id))
            .await?
            .clone(),
        None => load_project_on(query, project_id).await?,
    };
    Ok(ProjectAccess {
        project,
        workspace_id: workspace_id.context("Project has no unique active Workspace parent")?,
        priority,
    })
}

pub(crate) async fn require(state: &AppState, project_id: &str, user_id: i64) -> Result<i64> {
    require_on(&mut &state.mysql, project_id, user_id).await
}

pub(crate) async fn require_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    user_id: i64,
) -> Result<i64> {
    execution_priority_on(query, project_id, user_id).await?;
    parent_on(query, project_id).await
}

pub(crate) async fn execution_priority(
    mysql: &impl Mysql,
    project_id: &str,
    user_id: i64,
) -> Result<i64> {
    let mut query = mysql;
    execution_priority_on(&mut query, project_id, user_id).await
}

pub(crate) async fn execution_priority_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    user_id: i64,
) -> Result<i64> {
    let statement = crate::cloud_projects::project_access_statement(
        i32::try_from(user_id)?,
        Some(project_id.parse()?),
        None,
    );
    let access: Option<MysqlRow> = query.fetch_optional(statement, ()).await?;
    let priority: i64 = access
        .context("Project not found or membership revoked")?
        .get_required("anon_1_priority")?;
    if priority > 2 {
        bail!("Insufficient permission to execute in this project");
    }
    Ok(priority)
}

pub(crate) async fn require_issue(
    state: &AppState,
    project: &Node,
    issue: &Node,
    user: i64,
) -> Result<()> {
    let priority = execution_priority(&state.mysql, &project.id, user).await?;
    require_issue_with_priority(state, project, issue, user, priority).await
}

/// `_require_issue` with the priority `_execution_permission` already
/// resolved, so the check does not repeat the permission aggregate.
pub(crate) async fn require_issue_with_priority(
    state: &AppState,
    project: &Node,
    issue: &Node,
    user: i64,
    priority: i64,
) -> Result<()> {
    require_issue_with_priority_on(&mut &state.mysql, project, issue, user, priority).await
}

pub(crate) async fn require_issue_with_priority_on(
    query: &mut impl MysqlQuery,
    project: &Node,
    issue: &Node,
    user: i64,
    priority: i64,
) -> Result<()> {
    if issue.cloud_project_id != project.id {
        bail!("Issue is not in this project")
    }
    let security = issue.metadata.0["security_level"]
        .as_str()
        .filter(|v| matches!(*v, "open" | "related"))
        .unwrap_or(
            if project.metadata.0["default_issue_security"] == "related" {
                "related"
            } else {
                "open"
            },
        );
    if priority <= 1
        || security == "open"
        || issue.created_by_user_id == user
        || issue.assignee_user_id == user
    {
        return Ok(());
    }
    let related = crate::loop_tasks::loop_repository::is_related_item_on(
        query,
        &issue.id,
        i32::try_from(user)?,
    )
    .await?;
    if !related {
        bail!("Issue is not accessible")
    }
    Ok(())
}

pub(crate) async fn parent(state: &AppState, project_id: &str) -> Result<i64> {
    parent_on(&mut &state.mysql, project_id).await
}

pub(crate) async fn parent_on(query: &mut impl MysqlQuery, project_id: &str) -> Result<i64> {
    let row:Option<Parent>=query.fetch_optional("SELECT CAST(MIN(grant_row.entity_id) AS SIGNED) AS workspace_id FROM resource_members grant_row JOIN kinds workspace ON workspace.id=CAST(grant_row.entity_id AS SIGNED) AND workspace.kind='CollaborationWorkspace' AND workspace.is_active=true WHERE grant_row.resource_type='CloudProject' AND grant_row.resource_id=CAST(? AS SIGNED) AND grant_row.entity_type='workspace' AND grant_row.status='approved' GROUP BY grant_row.resource_id HAVING COUNT(DISTINCT grant_row.entity_id)=1",(project_id,)).await?;
    Ok(row
        .context("Project has no unique active Workspace parent")?
        .workspace_id)
}

pub(crate) async fn team(state: &AppState, project_id: &str, team_id: i64) -> Result<KindRow> {
    team_on(&mut &state.mysql, project_id, team_id).await
}

pub(crate) async fn team_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    team_id: i64,
) -> Result<KindRow> {
    let workspace = parent_on(query, project_id).await?;
    let team: KindRow = query
        .fetch_optional(resolution::team_by_id_statement(), (team_id,))
        .await?
        .context("Agent resource authorization is revoked or unavailable")?;
    let grant:Option<Grant>=query.fetch_optional("SELECT status,role FROM resource_members WHERE resource_type='Team' AND resource_id=? AND entity_type='workspace' AND entity_id=? LIMIT 1",(team_id,workspace.to_string())).await?;
    let bindings:Vec<Node>=query.fetch_all(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='chat_agent' AND cloud_project_id=? AND status='active' AND {LIVE} AND CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wegent_team_id')) AS SIGNED)=?"),(project_id,team_id)).await?;
    if bindings.is_empty() {
        bail!("Agent is not enabled in this project")
    }
    match grant {
        Some(grant) if approved(&grant) => {}
        None if bindings.iter().any(|binding| {
            !truthy(&binding.metadata.0["authorization_version"])
                && (team.user_id == 0 || binding.created_by_user_id == team.user_id)
        }) => {}
        _ => bail!("Agent resource authorization is revoked or unavailable"),
    }
    Ok(team)
}

fn approved(grant: &Grant) -> bool {
    grant.status == "approved"
        && matches!(grant.role.as_str(), "Owner" | "Maintainer" | "Developer")
}

pub(crate) async fn agent(
    state: &AppState,
    project_id: &str,
    agent_id: &str,
    user_id: i64,
    check_visibility: bool,
) -> Result<Node> {
    agent_on(
        &mut &state.mysql,
        project_id,
        agent_id,
        user_id,
        check_visibility,
    )
    .await
}

pub(crate) async fn agent_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    agent_id: &str,
    user_id: i64,
    check_visibility: bool,
) -> Result<Node> {
    let agent:Option<Node>=query.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='chat_agent' AND cloud_project_id=? AND status='active' AND {LIVE}"),(agent_id,project_id)).await?;
    let agent = agent.context("Agent is not enabled in this project")?;
    if check_visibility
        && agent.metadata.0["visibility"] == "private"
        && agent.created_by_user_id != user_id
    {
        bail!("Private Agent is not shared with this member")
    }
    if let Some(team_id) = integer(&agent.metadata.0["wegent_team_id"]).filter(|v| *v != 0) {
        team_on(query, project_id, team_id).await?;
    } else {
        let workspace = parent_on(query, project_id).await?;
        let grant:Option<Grant>=query.fetch_optional("SELECT status,role FROM resource_members WHERE resource_type='Workspace' AND resource_id=? AND entity_type='project_agent' AND entity_id=? LIMIT 1",(workspace,agent_id)).await?;
        if !grant.as_ref().is_some_and(approved)
            && (grant.is_some() || truthy(&agent.metadata.0["authorization_version"]))
        {
            bail!("Agent resource authorization is revoked or unavailable")
        }
    }
    Ok(agent)
}

pub(crate) fn integer(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
}
pub(crate) fn truthy(value: &serde_json::Value) -> bool {
    crate::json_compat::python_truthy(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revoked_and_view_only_resource_grants_do_not_authorize_execution() {
        assert!(approved(&Grant {
            status: "approved".into(),
            role: "Developer".into()
        }));
        assert!(!approved(&Grant {
            status: "pending".into(),
            role: "Owner".into()
        }));
        assert!(!approved(&Grant {
            status: "approved".into(),
            role: "Viewer".into()
        }));
    }

    /// The project load feeds `issues::load`, whose GitHub/GitLab branch
    /// parses issue ids with the project's `project_key`
    /// (`project_issues.rs:424-438`), so the loaded row must keep the key from
    /// the project projection instead of an empty default.
    #[test]
    fn the_loaded_project_keeps_its_project_key() {
        let node = project_node(ProjectRow {
            id: "1112169888680727447".into(),
            project_key: Some("PRJ4011FD".into()),
            metadata: Some(brz_mysql::Json(
                serde_json::json!({"task_provider": "github"}),
            )),
        });
        assert_eq!(node.project_key, "PRJ4011FD");
        assert_eq!(node.id, "1112169888680727447");
        assert_eq!(node.metadata.0["task_provider"], "github");

        // A local project stores NULL in both columns: the row decodes and the
        // Node keeps the previous empty-string / `JSON_OBJECT()` defaults.
        let local = project_node(ProjectRow {
            id: "1112169888680727448".into(),
            project_key: None,
            metadata: None,
        });
        assert_eq!(local.project_key, "");
        assert_eq!(local.metadata.0, serde_json::json!({}));
    }

    /// `execution_environment_ids`' statements must be real SQL — the
    /// use narrow projections and preserve the predicates, with no literal escape sequences
    /// (a doubled-escaped builder once sent literal `\n` and `\` to MySQL).
    #[test]
    fn environment_grant_statements_preserve_filters_and_use_narrow_projections() {
        let statements = [
            device_grants_statement("workspace", "2462052"),
            device_grants_statement("project", "1112169888680727447"),
            legacy_agents_statement("1112169888680727447", "621861176787721835"),
            legacy_device_grant_statement(2462052, "1112169888680727447", 267143),
        ];
        for sql in &statements {
            assert!(!sql.contains('\\'), "no literal backslash: {sql}");
            assert!(!sql.contains("\\n"), "no literal escape: {sql}");
            assert!(sql.contains("\nFROM "), "real newline before FROM: {sql}");
        }
        let grant = device_grants_statement("workspace", "2462052");
        assert!(grant.starts_with("SELECT resource_id \n"));
        assert!(statements[3].starts_with("SELECT 1 \n"));
        assert!(team_grant_statement(2462052, 1).starts_with("SELECT status, role \n"));
        assert!(grant.contains("resource_members.resource_type = 'Device'"));
        assert!(grant.contains("resource_members.entity_type = 'workspace'"));
        assert!(grant.contains("resource_members.entity_id = '2462052'"));
        assert!(grant.contains("resource_members.`role` IN ('Owner', 'Maintainer', 'Developer')"));
        let agents = legacy_agents_statement("1112169888680727447", "621861176787721835");
        assert!(agents.starts_with("SELECT created_by_user_id, metadata \n"));
        assert!(agents.contains("loop_items.id = '621861176787721835'"));
        assert!(agents.contains("loop_items.resource_type IN ('chat_agent')"));
        assert!(agents.contains("loop_items.deleted_at IS NULL"));
    }

    #[test]
    fn project_point_reads_select_only_their_required_fields() {
        let predicate = "WHERE id = '1112169888680727447' AND resource_type = 'project'";
        assert_eq!(
            project_load_statement("1112169888680727447"),
            format!("SELECT id, project_key, metadata FROM loop_items {predicate}"),
        );
        let record = project_record_statement("1112169888680727447");
        assert!(record.starts_with(
            "SELECT (SELECT CASE WHEN (count(distinct(resource_members.entity_id)) = 1)"
        ));
        assert!(record.ends_with(&format!(
            "AS workspace_id, status, metadata FROM loop_items {predicate}"
        )));
    }
}
