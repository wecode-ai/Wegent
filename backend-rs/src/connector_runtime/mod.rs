// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Connector-runtime API implementation.
//!
//! Source: `app/api/endpoints/connector_runtime.py` (the router is mounted
//! under the `/connector-runtime` prefix in `app/api/api.py`, so the full
//! routes are `/api/connector-runtime/*`).
//!
//! - `GET /api/connector-runtime/tools`: [`handler`] — the tool listing, backed
//!   by `app/services/connector_runtime.py::ConnectorRuntimeService.list_tools`.
//! - `POST /api/connector-runtime/token`: [`token`] — mint a connector-scoped
//!   access token for an authenticated user session.
//!
//! Flow for the tool listing: the `Bearer` connector token is verified with the
//! active JWT signing key and its `aud`/`scope`/`token_type` claims, then the
//! matching active user row is loaded by id and username. Tool discovery runs
//! over every connected visible connector app: one streamable-HTTP MCP session
//! per app (`initialize` / `notifications/initialized` / paginated `tools/list`)
//! with the caller's user-context headers, filtered by the app's
//! `toolAllowlist`.

mod auth;
mod handler;
mod models;
mod service;
mod token;
