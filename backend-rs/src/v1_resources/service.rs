// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Orchestration for `GET /api/v1/resources`
//! (`list_personal_resources`).
use brz_mysql::MysqlService;

use crate::auth::UserRow;
use crate::remote_workspace_tree::kinds::KindStore;
use crate::state::AppState;
use crate::v1_resources::environment;
use crate::v1_resources::readiness;
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

/// `list_personal_resources`, concrete over the shared MySQL/Redis services.
pub async fn list_personal_resources(
    state: &AppState,
    user: &UserRow,
) -> Result<PersonalResourcesResponse, crate::http_compat::FastApiError> {
    let mysql = &state.mysql;
    let user_id = i64::from(user.id);
    // `_list_owned_kinds` for Teams then Devices.
    let teams = repository::list_owned_kinds(mysql, user_id, "Team")
        .await
        .map_err(internal)?;
    let devices = repository::list_owned_kinds(mysql, user_id, "Device")
        .await
        .map_err(internal)?;
    // `workspace_ids_for_resources` for Team then Device.
    let team_ids: Vec<i64> = teams.iter().map(|t| t.id).collect();
    let device_ids: Vec<i64> = devices.iter().map(|d| d.id).collect();
    let team_workspace_rows = repository::workspace_ids_for_resources(mysql, "Team", &team_ids)
        .await
        .map_err(internal)?;
    let device_workspace_rows =
        repository::workspace_ids_for_resources(mysql, "Device", &device_ids)
            .await
            .map_err(internal)?;
    let team_workspaces = workspace_map(team_workspace_rows);
    let device_workspaces = workspace_map(device_workspace_rows);
    // `execution_environment_statuses`: one Redis MGET.
    let connection_statuses = environment::execution_environment_statuses(state, &devices).await;
    let environment_ids: Vec<String> = devices.iter().map(|d| d.id.to_string()).collect();

    // Remote Tree reader over the shared MySQL and the deployment's Redis.
    let kinds: &KindStore<'_, MysqlService, brz_redis::RedisService> = &resolved_reader(state);

    let mut agents = Vec::with_capacity(teams.len());
    for team in &teams {
        let status = readiness::agent_status(state, kinds, team, user).await;
        agents.push(AgentResource {
            id: team.id.to_string(),
            name: team.name.clone(),
            team_id: team.id,
            owner_type: "user",
            owner_id: user_id.to_string(),
            owner_name: user.user_name.clone(),
            status,
            execution_environment_ids: environment_ids.clone(),
            workspace_ids: team_workspaces.get(&team.id).cloned().unwrap_or_default(),
        });
    }
    let mut execution_environments: Vec<ExecutionEnvironmentResource> =
        Vec::with_capacity(devices.len());
    for (index, device) in devices.iter().enumerate() {
        let status = connection_statuses.get(index).cloned().unwrap_or_default();
        execution_environments.push(environment::personal_environment_values(
            device,
            &status,
            user,
            device_workspaces
                .get(&device.id)
                .cloned()
                .unwrap_or_default(),
        ));
    }
    Ok(PersonalResourcesResponse {
        agents,
        execution_environments,
    })
}

/// Build a `KindStore` over the shared MySQL and the deployment's kinds-cache
/// Redis client.
fn resolved_reader(state: &AppState) -> KindStore<'_, MysqlService, brz_redis::RedisService> {
    KindStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
    }
}

/// Internal error projection.
fn internal(error: brz_mysql::MysqlError) -> crate::http_compat::FastApiError {
    tracing::error!(%error, "resource listing database dependency failure");
    crate::http_compat::FastApiError::unhandled()
}
