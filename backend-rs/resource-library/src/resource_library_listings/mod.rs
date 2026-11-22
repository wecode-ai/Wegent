// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/resource-library/listings` — the capability-center discovery
//! listing.
//!
//! Port of `app.api.endpoints.resource_library.list_resource_library` and
//! `app.services.resource_library_service.ResourceLibraryService.list_public`:
//! authenticate the session, resolve the requested resource kinds, hide the
//! caller's installed Skills when no filter narrows the scan, merge the system
//! and published discovery queries, then project each page item.

pub(crate) mod agent_bindings;
mod agent_bindings_sync;
mod handler;
pub(crate) mod models;
pub(crate) mod repository;
mod service;
pub(crate) mod skill_bindings;
