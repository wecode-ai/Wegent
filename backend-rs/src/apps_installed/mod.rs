// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/apps/installed` implementation.
//!
//! Source: `app/api/endpoints/connector_app_projection.py::installed_apps`
//! (router mounted under the `/apps` prefix in `app/api/api.py`, so the full
//! route is `/api/apps/installed`).
//!
//! Flow: JWT session auth (`get_current_user`) loads the active user row;
//! `connector_runtime_service.list_tools` discovers tools for every connected
//! connector app (one MCP `initialize`/`notifications/initialized`/
//! `tools/list` exchange per streamable-http app); then each visible enabled
//! app with a `connected` user view is projected into a
//! `ConnectorInstalledApp`.

pub mod db;
mod handler;
pub mod mcp;
pub mod models;
pub mod service;
