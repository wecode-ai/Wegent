// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/marketplace` implementation.
//!
//! Port of `PluginMarketplaceService.list_plugins` in
//! `app/services/plugin_marketplace_service.py`: load published plugins, their
//! ready releases, owners, grants, the optional user's installs and device
//! rows, then filter by access, listing type, source, and query text.

pub mod auth;
pub mod components;
pub mod db;
mod handler;
pub mod models;
pub mod service;

pub use service::{MarketplaceQuery, list_plugins};
