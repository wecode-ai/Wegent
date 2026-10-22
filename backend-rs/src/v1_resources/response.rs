// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response shape for `GET /api/v1/resources`.
//!
//! Mirrors the pydantic `PersonalResourcesResponse`,
//! `PersonalAgentResource`, and `PersonalExecutionEnvironmentResource`
//! models in source `app/schemas/workspace.py`. The source returns a UTF-8
//! JSON document with these array entries; contract order is the array order,
//! key membership and scalar values, not JSON key order.

use serde::Serialize;

/// `PersonalAgentResource`.
#[derive(Debug, Serialize)]
pub struct AgentResource {
    pub id: String,
    pub name: String,
    pub team_id: i64,
    pub owner_type: &'static str,
    pub owner_id: String,
    pub owner_name: String,
    pub status: String,
    pub execution_environment_ids: Vec<String>,
    pub workspace_ids: Vec<String>,
}

/// `PersonalExecutionEnvironmentResource`. `updated_at` is a naive datetime
/// rendered by pydantic `isoformat()` (seconds precision, microseconds only
/// when non-zero), so it is serialised as a preformatted string.
#[derive(Debug, Serialize)]
pub struct ExecutionEnvironmentResource {
    pub id: String,
    pub device_id: i64,
    pub device_key: String,
    pub name: String,
    pub kind: String,
    pub coding_tools: Vec<String>,
    pub owner_type: &'static str,
    pub owner_id: String,
    pub owner_name: String,
    pub status: String,
    pub workspace_ids: Vec<String>,
    pub updated_at: String,
}

/// `PersonalResourcesResponse`.
#[derive(Debug, Serialize)]
pub struct PersonalResourcesResponse {
    pub agents: Vec<AgentResource>,
    pub execution_environments: Vec<ExecutionEnvironmentResource>,
}
