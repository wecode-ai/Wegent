//! Telemetry RPCs share the existing authenticated, device-addressed stand-in transport.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::stand_in_telemetry::origin_properties;

impl RuntimeWorkRpcHandler {
    pub(super) fn stand_in_telemetry_rpc(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        self.store
            .set_telemetry_path(self.task_store_path.as_ref().clone());
        match method {
            "runtime.stand_in.telemetry.configure" => {
                let enabled = payload["enabled"]
                    .as_bool()
                    .ok_or_else(|| AppIpcError::new("bad_request", "enabled is required"))?;
                store
                    .configure_stand_in_telemetry(
                        user,
                        enabled,
                        payload["enabledSince"].as_i64().filter(|at| *at > 0),
                    )
                    .map_err(settings_error)?;
            }
            "runtime.stand_in.telemetry.list" => {
                return store.list_stand_in_telemetry(user).map_err(settings_error)
            }
            _ => {
                let ids = payload["ids"]
                    .as_array()
                    .filter(|ids| ids.len() <= 100)
                    .ok_or_else(|| {
                        AppIpcError::new("bad_request", "ids must contain at most 100 event IDs")
                    })?;
                let ids = ids
                    .iter()
                    .map(|id| {
                        id.as_str()
                            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                            .map(str::to_owned)
                            .ok_or_else(|| AppIpcError::new("bad_request", "Invalid event ID"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                store
                    .ack_stand_in_telemetry(user, &ids)
                    .map_err(settings_error)?;
            }
        }
        Ok(json!({"success":true}))
    }

    pub(super) fn record_stand_in_dispatch(
        &self,
        config: &Value,
        result: &Result<(), AppIpcError>,
    ) {
        let Some(user) = config["userId"].as_i64() else {
            return;
        };
        let origin = json!({"type":"issue_dispatch","standInId":config["id"],"projectStore":config["projectStore"],"manual":config["manual"]});
        let mut properties = origin_properties(&origin);
        properties["action"] = json!("dispatch");
        self.record_stand_in_result(user, "dispatch", properties, result.as_ref().err());
    }

    pub(super) fn record_stand_in_result(
        &self,
        user: i64,
        operation: &str,
        mut properties: Value,
        error: Option<&AppIpcError>,
    ) {
        if let Some(error) = error {
            properties["failure_stage"] = json!(match error.code.as_str() {
                "stand_in_start_failed" => "start",
                "stand_in_agent_unavailable"
                | "model_unavailable"
                | "stand_in_workspace_unavailable" => "prepare",
                "permission_denied" | "unauthorized" | "forbidden" => "permission",
                _ => "request",
            });
        }
        let name = format!(
            "stand_in_{operation}_{}",
            if error.is_some() {
                "failed"
            } else {
                "succeeded"
            }
        );
        super::super::stand_in_telemetry::diagnose(
            LocalTaskStore::open(self.task_store_path.as_ref())
                .and_then(|store| store.record_stand_in_fact(user, &name, &properties)),
        );
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn stand_in_operation(
        &self,
        method: &str,
        payload: &Value,
    ) -> Option<(i64, &'static str, Value)> {
        if matches!(
            method,
            "runtime.tasks.send" | "runtime.tasks.retry" | "runtime.tasks.interrupt_and_send"
        ) {
            let task = self.local_task_link(payload["taskId"].as_str()?)?;
            let origin = &task.runtime_handle["origin"];
            let initiated = origin["initiatedBy"].as_str()?;
            if !matches!(initiated, "stand_in" | "stand_in_identity") {
                return None;
            }
            let operation = if initiated == "stand_in_identity" {
                "conversation"
            } else {
                "work_action"
            };
            let mut properties = origin_properties(origin);
            properties["action"] = json!(if operation == "conversation" {
                "send"
            } else if method == "runtime.tasks.retry" {
                "retry"
            } else if payload["requestUserInputResponse"].is_object()
                || payload["request_user_input_response"].is_object()
            {
                "confirm"
            } else {
                "reply"
            });
            return Some((origin["userId"].as_i64()?, operation, properties));
        }
        let (operation, action) = match method {
            "runtime.stand_in.personal.save" | "runtime.stand_in.save" => {
                ("configuration", "update")
            }
            "runtime.stand_in.conversation" => ("conversation", "send"),
            "runtime.stand_in.proposal.resolve" => (
                "proposal",
                if payload["accept"] == true {
                    "accept"
                } else {
                    "reject"
                },
            ),
            "runtime.stand_in.work.run" => ("work_action", "confirm"),
            "runtime.stand_in.work.adjust" => ("work_action", "adjust"),
            "runtime.stand_in.source.retry" => ("work_action", "retry"),
            "runtime.stand_in.work.organize" => (
                "work_action",
                match payload["telemetryAction"].as_str() {
                    Some("undo") => "undo",
                    Some("merge") => "merge",
                    _ if payload["targetWorkId"].is_string() => "move",
                    _ => "split",
                },
            ),
            _ => return None,
        };
        let user = payload["userId"].as_i64()?;
        let mut origin = json!({"standInId":payload.get("roleId").or(payload.get("standInId")).cloned().unwrap_or(Value::Null),"manual":true});
        if operation == "conversation" {
            origin["type"] = json!("stand_in_identity");
        }
        if let Some(id) = payload["workId"].as_str() {
            if let Ok(work) = LocalTaskStore::open(self.task_store_path.as_ref())
                .and_then(|store| store.stand_in_work(user, id))
            {
                origin["type"] = json!("connection_work");
                origin["standInId"] = work["roleId"].clone();
                origin["sourceProvider"] = json!(
                    crate::task_runtime::personal_stand_in::source_provider(&work["source"])
                );
            }
        }
        let mut properties = origin_properties(&origin);
        properties["action"] = json!(action);
        Some((user, operation, properties))
    }
}
