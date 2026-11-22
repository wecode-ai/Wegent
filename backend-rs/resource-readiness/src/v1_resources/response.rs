// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response shape for `GET /api/v1/resources`.
//!
//! Mirrors the pydantic `PersonalResourcesResponse`,
//! `PersonalAgentResource`, and `PersonalExecutionEnvironmentResource`
//! models in source `app/schemas/workspace.py`. The endpoint renders with
//! `response_model_exclude_unset=True`, so fields the source omits for a
//! catalog-only read (`include_readiness=false`) are absent instead of null;
//! `app_device_id` stays present because the source always supplies it (a
//! missing device field serialises as an explicit `null`).

use serde::Serialize;

/// `PersonalAgentResource`. The binding columns are `Option` because the
/// catalog-only path builds the entry without `execution_environment_ids` and
/// `workspace_ids`.
#[derive(Debug, Serialize)]
pub struct AgentResource {
    pub id: String,
    pub name: String,
    pub team_id: i64,
    pub owner_type: &'static str,
    pub owner_id: String,
    pub owner_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_environment_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_ids: Option<Vec<String>>,
}

/// `PersonalExecutionEnvironmentResource`. `updated_at` is a naive datetime
/// rendered by pydantic `isoformat()` (seconds precision, microseconds only
/// when non-zero), so it is serialised as a preformatted string.
#[derive(Debug, Serialize)]
pub struct ExecutionEnvironmentResource {
    pub id: String,
    pub device_id: i64,
    pub device_key: String,
    pub app_device_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub coding_tools: Vec<String>,
    pub owner_type: &'static str,
    pub owner_id: String,
    pub owner_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_ids: Option<Vec<String>>,
    pub updated_at: String,
}

/// `PersonalResourcesResponse`.
#[derive(Debug, Serialize)]
pub struct PersonalResourcesResponse {
    pub agents: Vec<AgentResource>,
    pub execution_environments: Vec<ExecutionEnvironmentResource>,
}
