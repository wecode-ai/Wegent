// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Gateway effects for the device connection lifecycle.

use std::sync::Arc;

use brz_socket_io::{ClientError, Reply};
use serde_json::Value;
use wegent_device_lifecycle::device_lifecycle;
use wegent_device_lifecycle::{DeviceEvent, LifecycleEffects, LifecycleServices};

use super::device_reconcile::ReconcileJob;
use super::runtime::{DeviceJob, SocketRuntime};
use super::session::{DeviceSession, RegistrationFingerprint};
use crate::state::AppState;

pub(super) fn services(state: &AppState) -> LifecycleServices<'_> {
    LifecycleServices {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        socketio_rpc: state.socketio_rpc.as_deref(),
        task_store: state.task_store.as_ref(),
        unique_app_device_names: state.unique_app_device_names,
    }
}

#[async_trait::async_trait]
impl LifecycleEffects for SocketRuntime {
    async fn emit_local(
        &self,
        event: DeviceEvent,
        user_id: i64,
        payload: &Value,
    ) -> Result<(), String> {
        let emitters = self.emitters();
        match event {
            DeviceEvent::Online => emitters.device_online(user_id, payload).await,
            DeviceEvent::Offline => emitters.device_offline(user_id, payload).await,
            DeviceEvent::Status => emitters.device_status(user_id, payload).await,
            DeviceEvent::UpgradeStatus => emitters.device_upgrade_status(user_id, payload).await,
            DeviceEvent::SlotUpdate => emitters.device_slot_update(user_id, payload).await,
        }
        .map_err(|error| error.to_string())
    }

    fn recent_display_name(
        &self,
        user_id: i64,
        device_id: &str,
        fingerprint: &RegistrationFingerprint,
    ) -> Option<String> {
        self.recent_display_name(user_id, device_id, fingerprint)
    }

    fn remember_registration(
        &self,
        user_id: i64,
        device_id: &str,
        fingerprint: RegistrationFingerprint,
        display_name: String,
    ) {
        self.remember_registration(user_id, device_id, fingerprint, display_name);
    }

    fn registered(&self, user_id: i64, route_id: &str) {
        self.enqueue(DeviceJob::RegisterSync {
            user_id,
            device_id: route_id.to_owned(),
        });
        self.enqueue_reconcile(ReconcileJob {
            user_id,
            device_id: route_id.to_owned(),
            needs_confirmation_only: false,
        });
    }

    fn enqueue_plugin_removal(&self, user_id: i64, route_id: &str) {
        self.enqueue_plugin_removal(user_id, route_id);
    }

    fn heartbeat_completed(&self, user_id: i64, route_id: String, runtime_auth_missing: bool) {
        if runtime_auth_missing {
            self.enqueue_runtime_auth_sync(user_id, &route_id);
        }
        self.enqueue_reconcile(ReconcileJob {
            user_id,
            device_id: route_id,
            needs_confirmation_only: true,
        });
    }
}

pub async fn register(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &DeviceSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    device_lifecycle::register(&services(state), runtime.as_ref(), session, socket_id, data).await
}

pub async fn disconnect(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &DeviceSession,
    socket_id: &str,
) {
    device_lifecycle::disconnect(
        &services(state),
        runtime.as_ref(),
        session,
        socket_id,
        async |user_id, device_id: String| {
            let failed =
                super::device_disconnect::fail_running_subtasks(state, user_id, &device_id).await;
            super::device_disconnect::emit_chat_errors(state, runtime, &failed).await;
        },
    )
    .await;
}

pub async fn publish_room_event(
    state: &AppState,
    event: &str,
    payload: &Value,
    namespace: &str,
    room: &str,
) {
    device_lifecycle::publish_room_event(state.redis.as_ref(), event, payload, namespace, room)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::socketio::runtime::SocketRuntimeWorkers;
    #[tokio::test]
    async fn the_registration_follow_ups_are_queued_once_on_the_handler_path() {
        let (runtime, workers) = SocketRuntime::new();
        let SocketRuntimeWorkers {
            jobs: mut register_jobs,
            mut reconcile_jobs,
            ..
        } = workers;

        runtime.registered(42, "app-record-7");

        let sync = register_jobs
            .try_recv()
            .expect("the capability sync is queued");
        assert!(matches!(
            sync,
            DeviceJob::RegisterSync { user_id: 42, ref device_id } if device_id == "app-record-7"
        ));
        let reconcile = reconcile_jobs
            .try_recv()
            .expect("the execution reconciliation is queued");
        assert_eq!(reconcile.user_id, 42);
        assert_eq!(reconcile.device_id, "app-record-7");
        assert!(!reconcile.needs_confirmation_only);
        assert!(
            register_jobs.try_recv().is_err(),
            "the registration sync is queued exactly once"
        );
        assert!(
            reconcile_jobs.try_recv().is_err(),
            "the reconciliation is queued exactly once"
        );
    }
}
