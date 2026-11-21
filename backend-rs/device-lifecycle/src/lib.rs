// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Device connection registration and presence.

#![forbid(unsafe_code)]

use brz_mysql::MysqlService;
use brz_redis::RedisService;
use serde_json::Value;
use wegent_socket_events::socketio_rpc::SocketIoRpc;
use wegent_task_store::task_store::TaskStore;

pub mod device;
mod device_error_text;
pub mod device_heartbeat;
pub mod device_lifecycle;
pub mod device_status;
pub mod device_upsert;
pub mod session;

pub struct LifecycleServices<'a> {
    pub mysql: &'a MysqlService,
    pub redis: Option<&'a RedisService>,
    pub socketio_rpc: Option<&'a SocketIoRpc>,
    pub task_store: &'a dyn TaskStore,
    pub unique_app_device_names: bool,
}

/// Device events whose local delivery is bound to the gateway's sockets.
pub enum DeviceEvent {
    Online,
    Offline,
    Status,
    UpgradeStatus,
    SlotUpdate,
}

/// Local broadcasts and background work scheduled by the lifecycle handlers.
#[async_trait::async_trait]
pub trait LifecycleEffects: Send + Sync {
    async fn emit_local(
        &self,
        event: DeviceEvent,
        user_id: i64,
        payload: &Value,
    ) -> Result<(), String>;

    fn recent_display_name(
        &self,
        user_id: i64,
        device_id: &str,
        fingerprint: &session::RegistrationFingerprint,
    ) -> Option<String>;

    fn remember_registration(
        &self,
        user_id: i64,
        device_id: &str,
        fingerprint: session::RegistrationFingerprint,
        display_name: String,
    );

    fn registered(&self, user_id: i64, route_id: &str);
    fn enqueue_plugin_removal(&self, user_id: i64, route_id: &str);
    fn heartbeat_completed(&self, user_id: i64, route_id: String, runtime_auth_missing: bool);
}
