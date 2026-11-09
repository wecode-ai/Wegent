// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Socket.IO business exports and Wegent device/authentication adapters.
//!
//! [`handlers`] exports the source namespaces and events through
//! `brz-socket-io`. The shared HTTP listener owns polling and WebSocket upgrade.
//! Device registration, heartbeat, disconnect cleanup and the post-registration
//! capability sync are migrated ([`device_lifecycle`], [`device_heartbeat`],
//! [`device_sync`]); the remaining event bodies stay explicit
//! `NOT_IMPLEMENTED` scaffolding until their business behavior is ported and
//! verified. Protocol codecs, sessions, room membership and ACK scheduling are
//! provided exclusively by `brz-socket-io`; this module contains application
//! policy.

pub mod auth;
pub mod chat_session;
pub mod chat_task_join;
pub mod device;
pub mod device_disconnect;
mod device_error_text;
pub mod device_heartbeat;
pub mod device_lifecycle;
pub mod device_pull;
pub mod device_reconcile;
pub mod device_runtime_event;
pub mod device_sync;
pub mod device_upsert;
#[cfg(test)]
#[path = "engineio_wire_tests.rs"]
mod engineio_wire_tests;
pub mod execution_aggregate;
pub mod execution_intent;
pub mod handlers;
pub mod runner_catalog;
pub mod runtime;
pub mod runtime_features;
pub mod runtime_projection;
pub mod runtime_request;
pub mod runtime_rpc;
pub mod session;
pub mod upgrade;

pub use device::{BindShell, RegisterPayload, Registered};
