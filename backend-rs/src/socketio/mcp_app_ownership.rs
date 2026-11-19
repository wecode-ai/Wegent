// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeSet, sync::Mutex};

use serde_json::{Value, json};

use crate::state::AppState;

use super::runtime_rpc;

pub(super) const METHOD: &str = "runtime.mcp_apps.request";

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct AppInstance {
    device: String,
    task: String,
    call: String,
    session: String,
}

impl AppInstance {
    pub(super) fn parse(device: &str, params: &Value) -> Option<Self> {
        let nonempty = |value: Option<&Value>| {
            value
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        Some(Self {
            device: device.to_owned(),
            task: nonempty(params.get("taskId"))
                .or_else(|| nonempty(params["address"].get("taskId")))?,
            call: nonempty(params.get("callId"))?,
            session: nonempty(params.get("sessionId"))?,
        })
    }

    pub(super) async fn release(self, state: &AppState, user_id: i64) {
        let params = json!({
            "address": {"taskId": self.task, "deviceId": self.device},
            "callId": self.call,
            "sessionId": self.session,
            "method": "release",
        });
        if runtime_rpc::call(state, user_id, &self.device, METHOD, params, 75, false)
            .await
            .is_err()
        {
            tracing::warn!(
                user_id,
                device_id = self.device,
                "MCP App owner cleanup failed"
            );
        }
    }
}

#[derive(Debug)]
pub(super) struct Ownership(Mutex<Option<BTreeSet<AppInstance>>>);

impl Ownership {
    pub(super) fn new() -> Self {
        Self(Mutex::new(Some(BTreeSet::new())))
    }

    // A retain that completes after disconnect must release its own instance.
    pub(super) fn retain(&self, instance: AppInstance) -> Option<AppInstance> {
        if let Some(instances) = self.0.lock().expect("MCP App ownership").as_mut() {
            instances.insert(instance);
            None
        } else {
            Some(instance)
        }
    }

    pub(super) fn forget(&self, instance: &AppInstance) {
        if let Some(instances) = self.0.lock().expect("MCP App ownership").as_mut() {
            instances.remove(instance);
        }
    }

    pub(super) async fn disconnect(&self, state: &AppState, user_id: i64) {
        let instances = self.close();
        futures_util::future::join_all(
            instances.into_iter().map(|app| app.release(state, user_id)),
        )
        .await;
    }

    fn close(&self) -> BTreeSet<AppInstance> {
        self.0
            .lock()
            .expect("MCP App ownership")
            .take()
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disconnect_owns_only_retained_instances_and_rejects_late_retains() {
        let owner = Ownership::new();
        let app = |id: &str| {
            AppInstance::parse(
                "device",
                &json!({
                    "address":{"taskId":"task"}, "callId":"call", "sessionId":id,
                }),
            )
            .unwrap()
        };
        assert!(owner.retain(app("keep")).is_none());
        assert!(owner.retain(app("release")).is_none());
        owner.forget(&app("release"));
        assert_eq!(owner.close(), BTreeSet::from([app("keep")]));
        assert_eq!(owner.retain(app("late")), Some(app("late")));
        assert!(owner.close().is_empty());
    }
}
