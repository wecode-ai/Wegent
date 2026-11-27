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
pub(crate) use wegent_socket_events::callback_sequencer;
pub mod chat_control;
pub(crate) mod chat_device_resolution;
pub mod chat_events;
mod chat_references;
pub mod chat_retry;
pub mod chat_send;
pub mod chat_session;
pub(crate) mod chat_support;
pub mod chat_task_join;
mod chat_trigger;
pub use wegent_device_lifecycle::device;
pub mod device_auth_sync;
pub mod device_disconnect;
pub mod device_heartbeat;
pub mod device_lifecycle;
pub mod device_pull;
pub mod device_pull_claim;
mod device_pull_payload;
pub mod device_reconcile;
#[cfg(test)]
pub(crate) mod issue_timestamp_tests;
#[cfg(test)]
pub(crate) use device_reconcile::verify_reconnect_projection;
#[cfg(test)]
pub(crate) use runtime_projection::verify_late_human_reply_projection;
pub mod device_responses;
pub mod device_runtime_event;
pub mod device_runtime_tasks;
pub mod device_status;
pub mod device_sync;
pub use wegent_device_lifecycle::device_upsert;
#[cfg(test)]
#[path = "engineio_wire_tests.rs"]
mod engineio_wire_tests;
pub use wegent_runtime_execution::execution_aggregate;
pub mod handlers;
pub(crate) mod issue_discussion;
mod issue_room_access;
mod project_chat_comment;
pub mod project_chat_events;
mod project_chat_mentions;
pub(crate) mod project_chat_messages;
pub(crate) mod project_chat_snapshot;
pub use wegent_devices::runner_catalog;
pub mod runtime;
pub use wegent_devices::runtime_features;
pub use wegent_socket_events::runtime_event_order;
pub mod runtime_projection;
mod runtime_projection_metrics;
pub mod runtime_request;
pub use wegent_device_lifecycle::session;
pub use wegent_socket_events::skill_registry;
mod subscription_forms;
mod subscription_handoff;
mod terminal_transport;
pub use wegent_socket_adapter::upgrade;
pub mod workspace_cleanup_intents;

pub use device::{BindShell, RegisterPayload, Registered};

#[cfg(test)]
#[test]
fn the_downlink_pool_stays_concurrent() {
    assert_eq!(runtime::RPC_WORKER_COUNT, 4);
}
