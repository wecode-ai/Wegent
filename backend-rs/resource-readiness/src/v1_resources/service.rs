// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Orchestration for `GET /api/v1/resources`
//! (`WorkspacePersonalResourceService.list_personal_resources`).
use crate::ResourceReadinessState;
use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use crate::v1_resources::environment;
use crate::v1_resources::readiness::{ReadinessContext, agent_catalog_name, agent_display_name};
use crate::v1_resources::repository;
use crate::v1_resources::response::{
    AgentResource, ExecutionEnvironmentResource, PersonalResourcesResponse,
};

/// `workspace_ids_for_resources` -> `resource_id` -> ordered workspace ids.
fn workspace_map(rows: Vec<(i64, String)>) -> std::collections::HashMap<i64, Vec<String>> {
    let mut map: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    for (resource_id, entity_id) in rows {
        map.entry(resource_id).or_default().push(entity_id);
    }
    map
}

/// One Agent catalog entry before its Workspace bindings are attached.
struct AgentSummary {
    id: i64,
    name: String,
    status: String,
}

/// `list_personal_resources`, concrete over the shared MySQL/Redis services.
///
/// `include_readiness` mirrors the source query parameter: when false the
/// Agent entries omit `execution_environment_ids`/`workspace_ids` and report
/// `unchecked`, the Team readiness graph is not loaded, and the device
/// `workspace_ids` field is omitted.
pub async fn list_personal_resources(
    state: &ResourceReadinessState,
    user: &UserRow,
    include_readiness: bool,
) -> Result<PersonalResourcesResponse, FastApiError> {
    let mysql = &state.mysql;
    let user_id = i64::from(user.id);
    let agents_summary = if include_readiness {
        let teams = repository::list_owned_kinds(mysql, user_id, "Team")
            .await
            .map_err(internal)?;
        Some(agent_summaries_with_readiness(state, &teams, user).await?)
    } else {
        None
    };
    let catalog = if include_readiness {
        None
    } else {
        Some(
            repository::list_owned_agent_catalog(mysql, user_id)
                .await
                .map_err(internal)?,
        )
    };
    let devices = repository::list_owned_kinds(mysql, user_id, "Device")
        .await
        .map_err(internal)?;
    let environment_ids: Vec<String> = devices.iter().map(|device| device.id.to_string()).collect();
    let team_workspaces = if include_readiness {
        let teams = agents_summary
            .as_ref()
            .map(|summaries| {
                summaries
                    .iter()
                    .map(|summary| summary.id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Some(workspace_map(
            repository::workspace_ids_for_resources(mysql, "Team", &teams)
                .await
                .map_err(internal)?,
        ))
    } else {
        None
    };
    let device_workspaces = if include_readiness {
        let device_ids: Vec<i64> = devices.iter().map(|device| device.id).collect();
        Some(workspace_map(
            repository::workspace_ids_for_resources(mysql, "Device", &device_ids)
                .await
                .map_err(internal)?,
        ))
    } else {
        None
    };
    let connection_statuses = environment::execution_environment_statuses(state, &devices).await?;

    let agents = match (agents_summary, catalog) {
        (Some(summaries), _) => {
            let team_workspaces = team_workspaces.unwrap_or_default();
            summaries
                .into_iter()
                .map(|summary| AgentResource {
                    id: summary.id.to_string(),
                    name: summary.name,
                    team_id: summary.id,
                    owner_type: "user",
                    owner_id: user_id.to_string(),
                    owner_name: user.user_name.clone(),
                    status: summary.status,
                    execution_environment_ids: Some(environment_ids.clone()),
                    workspace_ids: Some(
                        team_workspaces
                            .get(&summary.id)
                            .cloned()
                            .unwrap_or_default(),
                    ),
                })
                .collect()
        }
        (None, Some(rows)) => rows
            .into_iter()
            .map(|row| AgentResource {
                id: row.id.to_string(),
                name: agent_catalog_name(
                    &row.name,
                    row.metadata.as_ref().map(|metadata| &metadata.0),
                ),
                team_id: row.id,
                owner_type: "user",
                owner_id: user_id.to_string(),
                owner_name: user.user_name.clone(),
                status: "unchecked".to_string(),
                execution_environment_ids: None,
                workspace_ids: None,
            })
            .collect(),
        (None, None) => Vec::new(),
    };

    let mut execution_environments: Vec<ExecutionEnvironmentResource> =
        Vec::with_capacity(devices.len());
    for (index, device) in devices.iter().enumerate() {
        let status = connection_statuses.get(index).cloned().unwrap_or_default();
        let workspace_ids = device_workspaces
            .as_ref()
            .map(|map| map.get(&device.id).cloned().unwrap_or_default());
        execution_environments.push(environment::personal_environment_values(
            device,
            &status,
            user,
            workspace_ids,
        ));
    }
    Ok(PersonalResourcesResponse {
        agents,
        execution_environments,
    })
}

/// `_list_owned_agents`'s readiness path: the session Teams, resolved through
/// one shared readiness context.
async fn agent_summaries_with_readiness(
    state: &ResourceReadinessState,
    teams: &[repository::OwnedKindRow],
    user: &UserRow,
) -> Result<Vec<AgentSummary>, FastApiError> {
    let mut context = ReadinessContext::build(state, teams, i64::from(user.id)).await?;
    let mut summaries = Vec::with_capacity(teams.len());
    for team in teams {
        let status = context.agent_status(team, user).await?;
        summaries.push(AgentSummary {
            id: team.id,
            name: agent_display_name(team),
            status,
        });
    }
    Ok(summaries)
}

/// Internal error projection.
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "resource listing database dependency failure");
    FastApiError::unhandled()
}
