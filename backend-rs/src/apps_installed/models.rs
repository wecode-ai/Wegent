// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response models for `GET /api/apps/installed`.
//!
//! Mirrors the pydantic models `ConnectorInstalledApp`,
//! `ConnectorInstalledResponse`, `ConnectorToolSummary`, and
//! `ConnectorConnectionResponse` in `app/schemas/connector.py`. Field names
//! serialize in the source snake_case form (pydantic without aliases).
use serde::Serialize;

/// `ConnectorConnectionResponse`.
#[derive(Debug, Serialize)]
pub struct ConnectionResponse {
    /// `connected`, `disconnected`, `expired`, `pending`, or `error` from the
    /// stored connection, or the `auth_type == "none"` default.
    pub status: String,
    pub external_account_name: Option<String>,
    pub granted_scopes: Vec<String>,
    /// Pydantic serializes the stored naive datetime without a timezone.
    pub expires_at: Option<String>,
}

/// `ConnectorToolSummary`.
#[derive(Debug, Clone, Serialize)]
pub struct ToolSummary {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub raw_tool_name: Option<String>,
}

/// `ConnectorInstalledApp`.
#[derive(Debug, Serialize)]
pub struct InstalledApp {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub runtime_name: Option<String>,
    pub enabled: bool,
    pub callable: bool,
    pub connection: ConnectionResponse,
    pub tool_summaries: Vec<ToolSummary>,
}

/// `ConnectorInstalledResponse`.
#[derive(Debug, Serialize)]
pub struct InstalledResponse {
    pub apps: Vec<InstalledApp>,
}

/// The `auth_type == "none"` connection default from
/// `ConnectorAppService.user_response`.
pub fn connected_no_auth() -> ConnectionResponse {
    ConnectionResponse {
        status: "connected".to_string(),
        external_account_name: None,
        granted_scopes: Vec::new(),
        expires_at: None,
    }
}
