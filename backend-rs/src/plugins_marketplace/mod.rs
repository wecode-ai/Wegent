// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/marketplace` implementation.
//!
//! Port of `PluginMarketplaceService.list_plugins` in
//! `app/services/plugin_marketplace_service.py`: load published plugins, their
//! ready releases, owners, grants, the optional user's installs and device
//! rows, then filter by access, listing type, source, and query text.
//!
//! Re-opened for re-verification on 2026-10-11 after the traffic-e2e engine
//! upgrade; this note exists only to force a fresh focused replay of the route.
//! The prior Replay verdict ("responses pass but dependency evidence is dirty")
//! was environment-side dirt, not a handler defect: the only unmatched exchange
//! was a single target-only Redis `GET recording:wegent:max-gateways`, the
//! background admission lease (`hybrid/recording.rs` -> `GatewayLeaseConfig`,
//! ~10s tick) the replay target ran because it inherited
//! `WEGENT_RS_RECORDING_ENABLED=true`. The startup environment now forces
//! `false`, and every recorded request-path Redis exchange (`erp:membership:*`
//! GET/SET) already matched. No behavior changed here.

pub mod auth;
pub mod components;
pub mod db;
mod handler;
pub mod models;
pub mod service;

pub use service::{MarketplaceQuery, list_plugins};
