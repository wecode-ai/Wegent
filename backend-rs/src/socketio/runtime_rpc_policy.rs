// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Installation consent for personal task RPCs, independent of project grants.

use serde_json::{Value, json};

use crate::runtime_work::remote_control_is_enabled;

use super::runtime_rpc::{CallFailure, REMOTE_CONTROL_DISABLED_MESSAGE, Route, RuntimeRpcError};

const PERSONAL_TASK_METHODS: [&str; 9] = [
    "runtime.tasks.create",
    "runtime.tasks.list",
    "runtime.tasks.search",
    "runtime.tasks.transcript",
    "runtime.tasks.transcript.search",
    "runtime.tasks.send",
    "runtime.tasks.cancel",
    "runtime.tasks.goal.get",
    "runtime.tasks.goal.set",
];
const PROJECT_READ_METHODS: [&str; 2] = [
    "runtime.tasks.transcript",
    "runtime.tasks.transcript.search",
];

pub(super) fn authorize(
    route: &Route,
    method: &str,
    project_read: bool,
) -> Result<Option<&'static str>, CallFailure> {
    if remote_control_is_enabled(route.device_type) {
        return Ok(None);
    }
    if project_read && PROJECT_READ_METHODS.contains(&method) {
        return Ok(Some("project-session"));
    }
    let access = route
        .online
        .get("runtime_features")
        .and_then(|features| features.get("remoteTaskAccess"))
        .unwrap_or(&Value::Null);
    if PERSONAL_TASK_METHODS.contains(&method)
        && access["version"].as_i64() == Some(1)
        && access["enabled"] == Value::Bool(true)
    {
        return Ok(None);
    }
    Err(CallFailure::Rpc(RuntimeRpcError {
        code: "remote_control_disabled".into(),
        message: REMOTE_CONTROL_DISABLED_MESSAGE.into(),
        retryable: Some(false),
        details: Some(json!({"deviceId": route.logical_device_id})),
    }))
}

pub(super) fn personal_events_allowed(is_app: bool, marker: Option<&Value>) -> bool {
    !is_app || marker == Some(&Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_identity::DeviceType;

    fn route(access: Value) -> Route {
        Route {
            logical_device_id: "app-record-72".into(),
            runtime_device_id: "app-record-72".into(),
            device_type: DeviceType::App,
            socket_id: "current-socket".into(),
            online: json!({"runtime_features": {"remoteTaskAccess": access}})
                .as_object()
                .unwrap()
                .clone(),
        }
    }

    #[test]
    fn personal_tasks_require_current_typed_consent() {
        for access in [
            Value::Null,
            json!({"version":1,"enabled":false}),
            json!({"version":true,"enabled":true}),
            json!({"version":1.0,"enabled":true}),
            json!({"version":2,"enabled":true}),
            json!({"version":1,"enabled":"true"}),
        ] {
            for method in PERSONAL_TASK_METHODS {
                assert!(
                    authorize(&route(access.clone()), method, false).is_err(),
                    "{method}: {access}"
                );
            }
        }
        let mut target = route(json!({"version":1,"enabled":true}));
        for method in PERSONAL_TASK_METHODS {
            assert_eq!(authorize(&target, method, false).unwrap(), None);
        }
        target.online["runtime_features"]["remoteTaskAccess"]["enabled"] = json!(false);
        assert!(authorize(&target, "runtime.tasks.send", false).is_err());
    }

    #[test]
    fn consent_never_grants_other_controls() {
        let target = route(json!({"version":1,"enabled":true}));
        for method in [
            "executor.remote_task_access.update",
            "device.execute_command",
            "runtime.terminal.start",
            "runtime.tasks.rollback",
            "runtime.automations.create",
        ] {
            assert!(authorize(&target, method, false).is_err());
        }
    }

    #[test]
    fn project_grants_remain_limited_to_validated_reads() {
        let target = route(Value::Null);
        for method in PROJECT_READ_METHODS {
            assert_eq!(
                authorize(&target, method, true).unwrap(),
                Some("project-session")
            );
            assert!(authorize(&target, method, false).is_err());
        }
        assert!(authorize(&target, "runtime.tasks.send", true).is_err());
    }

    #[test]
    fn events_use_the_executor_current_consent_marker() {
        for marker in [Value::Null, json!(false), json!("true"), json!(1)] {
            assert!(!personal_events_allowed(true, Some(&marker)));
        }
        assert!(!personal_events_allowed(true, None));
        assert!(personal_events_allowed(true, Some(&json!(true))));
        assert!(personal_events_allowed(false, None));
    }
}
