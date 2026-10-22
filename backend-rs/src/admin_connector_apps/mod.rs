// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/connector-apps` implementation.
//!
//! Source: `app/api/endpoints/admin/connector_apps.py::list_connector_apps`
//! (router `prefix="/connector-apps"` included by
//! `app/api/endpoints/admin/router.py` and mounted under `prefix="/admin"` in
//! `app/api/api.py`, so the full route is `/api/admin/connector-apps`) and
//! `app/services/connector_apps.py::ConnectorAppService.list_all_apps` plus
//! `admin_response`.
//!
//! Flow: the administrator dependency chain (`get_admin_user` over
//! `get_current_user`) loads the active session user row and rejects a
//! non-admin with the source 403; `list_all_apps` lists every active
//! `ConnectorApp` kind ordered by name then id; each app is projected through
//! `admin_response`, which decrypts its stored provider headers and counts its
//! active `ConnectorConnection` kinds.

pub mod db;
pub mod handler;
pub mod models;
pub mod service;

mod crypto;
