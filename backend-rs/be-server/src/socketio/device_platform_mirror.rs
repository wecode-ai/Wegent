// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Select the business event producer from the persisted platform dispatch.

use crate::state::AppState;
use serde_json::Value;

#[derive(Debug, PartialEq)]
struct ProjectionBinding {
    task: i64,
    subtask: i64,
    attempt: String,
}

impl ProjectionBinding {
    fn parse(payload: &Value) -> Result<Option<Self>, crate::BoxError> {
        let source = &payload["source"];
        if source["source"] != "platform_projection" {
            return Ok(None);
        }
        fn platform_id(value: &Value) -> Option<i64> {
            value
                .as_i64()
                .or_else(|| value.as_str()?.parse().ok())
                .filter(|id| *id > 0)
        }
        let task = platform_id(&source["task_id"]).ok_or("missing projection task")?;
        let subtask = platform_id(&source["subtask_id"]).ok_or("missing projection subtask")?;
        let attempt = match &source["execution_attempt_id"] {
            Value::Null => subtask.to_string(),
            Value::String(id) if !id.is_empty() => id.clone(),
            _ => return Err("invalid projection attempt".into()),
        };
        Ok(Some(Self {
            task,
            subtask,
            attempt,
        }))
    }

    fn matches_dispatch(
        &self,
        task: i64,
        executor: Option<&str>,
        device: &super::super::session::DeviceSessionState,
    ) -> bool {
        self.task == task
            && executor
                .and_then(|name| name.strip_prefix("device-"))
                .is_some_and(|id| {
                    !id.is_empty()
                        && [
                            device.device_id.as_deref(),
                            device.logical_device_id.as_deref(),
                            device.execution_target_id.as_deref(),
                        ]
                        .contains(&Some(id))
                })
    }
}

/// One verified in-flight producer per socket. Re-registration and reconnect
/// select a new key. Terminal events always re-read the durable attempt.
#[derive(Default)]
pub(crate) struct MirrorCache(std::sync::Mutex<Option<VerifiedMirror>>);

struct VerifiedMirror {
    binding: ProjectionBinding,
    owner: i64,
    executor: String,
    verified_at: std::time::Instant,
}

impl VerifiedMirror {
    fn matches(
        &self,
        binding: &ProjectionBinding,
        session: &super::super::session::SessionSnapshot,
    ) -> bool {
        self.binding == *binding
            && self.owner == session.user_id
            && self.verified_at.elapsed() < std::time::Duration::from_secs(1)
            && binding.matches_dispatch(binding.task, Some(&self.executor), &session.device)
    }
}

/// A marked frame is a display copy of a dispatched platform turn. Unmarked
/// frames (including older protocols) retain their native Runtime behavior.
pub(crate) async fn platform_mirror(
    state: &AppState,
    session: &super::super::session::SessionSnapshot,
    payload: &Value,
    cache: Option<&MirrorCache>,
) -> Result<bool, crate::BoxError> {
    let Some(binding) = ProjectionBinding::parse(payload)? else {
        return Ok(false);
    };
    if cache.is_some_and(|cache| {
        cache
            .0
            .lock()
            .expect("mirror cache poisoned")
            .as_ref()
            .is_some_and(|entry| entry.matches(&binding, session))
    }) {
        return Ok(true);
    }
    let (task, subtask) = (binding.task, binding.subtask);
    let row = state
        .task_store
        .streaming_subtask_by_id(subtask)
        .await?
        .ok_or("unknown projection subtask")?;
    if !binding.matches_dispatch(row.task_id, row.executor_name.as_deref(), &session.device) {
        return Err("projection dispatch device mismatch".into());
    }
    let parent = state
        .task_store
        .get_active_task_owned(task, session.user_id.try_into()?)
        .await?
        .ok_or("projection task owner mismatch")?;
    let payload =
        wegent_task_store::projection::task_column::<brz_mysql::Json<Value>>(&parent, "json")
            .ok_or("projection task state missing")?;
    let attempt = super::super::chat_trigger::device_attempt_id(&payload.0, subtask);
    if binding.attempt != attempt {
        return Err("projection dispatch attempt mismatch".into());
    }
    if let Some(cache) = cache {
        *cache.0.lock().expect("mirror cache poisoned") = Some(VerifiedMirror {
            binding,
            owner: session.user_id,
            executor: row.executor_name.expect("validated dispatch device"),
            verified_at: std::time::Instant::now(),
        });
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn platform_projection_routes_only_an_explicit_dispatched_turn() {
        let mut device = crate::socketio::session::DeviceSessionState::default();
        device.device_id = Some("app-record-3".into());
        device.logical_device_id = Some("logical-7".into());
        for payload in [
            json!({"taskId":"32"}),
            json!({"taskId":"32","source":{"source":"im"}}),
        ] {
            assert_eq!(ProjectionBinding::parse(&payload).unwrap(), None);
        }
        let payload = json!({"taskId":"a-local-session","source":{
            "source":"platform_projection","task_id":"32","subtask_id":"93","execution_attempt_id":"retry-2"
        }});
        let binding = ProjectionBinding::parse(&payload).unwrap().unwrap();
        assert_eq!(binding.attempt, "retry-2");
        assert!(binding.matches_dispatch(32, Some("device-logical-7"), &device));
        assert!(binding.matches_dispatch(32, Some("device-app-record-3"), &device));
        assert!(!binding.matches_dispatch(33, Some("device-logical-7"), &device));
        assert!(!binding.matches_dispatch(32, Some("device-another-device"), &device));
        assert!(
            ProjectionBinding::parse(
                &json!({"taskId":"32","source":{"source":"platform_projection"}})
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn a_platform_terminal_and_watcher_update_only_read_the_dispatch_binding() {
        use crate::socketio::{
            device::DeviceType, device_runtime_tasks, runtime::SocketRuntime,
            session::SessionSnapshot,
        };
        use crate::sql_test_support::mysql_rows::{MysqlRows, Value as Column};
        let db = MysqlRows::start(|query| {
            if query.contains("FROM subtasks") {
                vec![
                    ("subtasks_id", Column::I64(93)),
                    ("subtasks_task_id", Column::I64(32)),
                    ("subtasks_status", Column::Text("COMPLETED".into())),
                    (
                        "subtasks_executor_name",
                        Column::Text("device-runner".into()),
                    ),
                    ("subtasks_created_at", Column::DateTime),
                ]
            } else if query.contains("FROM `tasks`") {
                vec![
                    ("id", Column::I64(32)),
                    ("user_id", Column::I32(7)),
                    ("kind", Column::Text("Task".into())),
                    ("name", Column::Text("task".into())),
                    ("namespace", Column::Text("default".into())),
                    (
                        "json",
                        Column::Text(
                            json!({"status":{"executionAttempts":{"93":"retry"}}}).to_string(),
                        ),
                    ),
                ]
            } else {
                panic!("unexpected business projection query: {query}");
            }
        })
        .await;
        let app = crate::app_test_support::app(db.mysql.clone());
        let (runtime, _workers) = SocketRuntime::new();
        let mut device = crate::socketio::session::DeviceSessionState::default();
        device.device_id = Some("runner".into());
        device.device_type = Some(DeviceType::App);
        let session = SessionSnapshot {
            user_id: 7,
            user_name: "owner".into(),
            auth_type: "jwt",
            client_ip: None,
            device,
        };
        let mut payload = json!({"taskId":"local", "localTaskId":"local", "status":"completed",
            "event_type":"response.completed", "data":{"value":"finished"},
            "source":{"source":"platform_projection","task_id":32,"subtask_id":93,"execution_attempt_id":"retry"}});
        let frame = json!({"event":"response.completed","payload":payload});
        assert_eq!(
            super::super::forward(
                &app,
                &runtime,
                &session,
                frame.as_object().unwrap(),
                &MirrorCache::default()
            )
            .await
            .unwrap(),
            json!({"success":true})
        );
        assert_eq!(
            device_runtime_tasks::updated(&app, &runtime, &session, &payload)
                .await
                .unwrap(),
            json!({"success":true,"notified":0})
        );
        payload["source"]["execution_attempt_id"] = json!("stale");
        assert!(
            platform_mirror(&app, &session, &payload, None)
                .await
                .is_err()
        );
    }
}
