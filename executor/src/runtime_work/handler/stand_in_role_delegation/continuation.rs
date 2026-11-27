//! Admit a new turn on the exact branch previously dispatched by this actor.
use super::super::stand_in::settings_error;
use super::super::stand_in_role_results::role_result_receipt;
use super::*;

pub(super) fn role_dependencies(args: &Value) -> Result<Value, AppIpcError> {
    let Some(value) = args.get("dependsOn") else {
        return Ok(Value::Null);
    };
    let ids = value
        .as_array()
        .filter(|ids| ids.len() <= MAX_ROLE_TASKS && ids.iter().all(Value::is_string))
        .ok_or_else(|| {
            AppIpcError::new(
                "delegation_dependency_invalid",
                "Expected prerequisite task IDs",
            )
        })?;
    Ok(if ids.is_empty() {
        Value::Null
    } else {
        value.clone()
    })
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn continue_role_task(
        &self,
        store: &LocalTaskStore,
        identity: &StandInMcpIdentity,
        actor: &RuntimeTaskLink,
        id: &str,
        role: &mut Value,
        input: Value,
    ) -> Result<Value, AppIpcError> {
        let branch = &input["roleDelegation"];
        let root = branch["root"].as_str().ok_or_else(denied)?;
        let saved = store
            .stand_in_role_request(id, identity.user)
            .map_err(settings_error)?
            .ok_or_else(denied)?;
        let mut intent = saved["intent"].clone();
        if saved["root"] != root
            || intent["roleDelegation"] != *branch
            || intent["sourceTaskId"] != identity.task_id
            || intent["sourceDevice"] != self.device_id
            || intent["roleId"] != role["id"]
        {
            return Err(denied());
        }
        if intent["targetDevice"] != role["executionDeviceId"] {
            return Err(AppIpcError::new(
                "role_device_changed",
                "The specialist has moved to another device",
            ));
        }
        intent["followupRequestId"] = input["requestId"].clone();
        intent["requestBrief"] = input["requestBrief"].clone();
        intent["message"] = input["message"].clone();
        if input["dependsOn"].is_null() {
            intent
                .as_object_mut()
                .ok_or_else(denied)?
                .remove("dependsOn");
        } else {
            intent["dependsOn"] = input["dependsOn"].clone();
        }

        if !intent["sourceRoute"].is_null() {
            let connection = self.require_runtime_connection()?;
            if Self::connected_runtime_user(&connection).await? != identity.user
                || intent["backendUrl"] != connection.backend_url
                || intent["sourceRoute"] != self.cloud_device_id()?
            {
                return Err(denied());
            }
        }
        if let Some(previous) = store
            .replayed_stand_in_role_request(id, identity.user, root, &intent, true)
            .map_err(reservation_error)?
        {
            return Ok(self.role_submission_response(identity.user, id, &previous, true));
        }
        let attempt = saved["attempt"].as_u64().unwrap_or(0);
        let next = attempt.checked_add(1).ok_or_else(denied)?;
        if intent["sourceRoute"].is_null() {
            let link = self.local_task_link(id).ok_or_else(denied)?;
            self.validate_role_attempt_start(Some(&link), &intent, identity.user, next, false)?;
            if role_attempt(&link) != attempt {
                return Err(AppIpcError::new(
                    "conflict",
                    "The specialist has a pending turn",
                ));
            }
            self.ensure_role_result_delivered_before_continuation(&link)
                .await?;
        } else if saved["resultReceipt"].is_null() && saved["pendingResult"]["status"] == "done" {
            // The parent queue can accept the result before the relay records its receipt.
            let receipt = role_result_receipt(&saved["pendingResult"])?;
            if self
                .parent_accepted_role_result(&identity.task_id, identity.user, receipt)
                .await?
            {
                store
                    .record_remote_stand_in_role_result(
                        id,
                        identity.user,
                        attempt,
                        "done",
                        Some(receipt),
                    )
                    .map_err(settings_error)?;
            }
        }
        let prepared = if intent["sourceRoute"].is_null() && intent["dependsOn"].is_null() {
            role["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":true});
            let delegation = json!({
                "userId":identity.user,"sourceTaskId":identity.task_id,
                "askBeforeAct":true,"readSources":[],"roleDelegation":branch,
                "roleDirectory":actor.runtime_handle["executionRequest"]["standInDelegation"]["roleDirectory"],
                "attempt":next,"followupRequestId":intent["followupRequestId"],"retrying":false
            });
            Some(
                self.prepare_delegated_turn(&intent, id, role, delegation)
                    .await?,
            )
        } else {
            None
        };
        let (row, replayed) = {
            // A durable reservation is the admission point. Dispatch (including recovery
            // after restart) occurs after these guards drop, through the same scheduler.
            let owner = supports_role_delegation(&actor.runtime_handle["origin"]);
            let _queue = if owner {
                Some(self.turn_queue_operation.lock().await)
            } else {
                None
            };
            let _lifecycle = owner.then(|| {
                self.stand_in_lifecycle_gate
                    .lock()
                    .expect("stand-in lifecycle gate poisoned")
            });
            if owner && !self.has_current_stand_in_owner_request(actor) {
                return Err(denied());
            }
            store
                .continue_stand_in_role_request(id, identity.user, root, &intent, Some(attempt))
                .map_err(reservation_error)?
        };
        if let Some(payload) = prepared.filter(|_| !replayed) {
            match self
                .send_prepared_role_attempt(&row["intent"], payload, next)
                .await
            {
                Ok(_) => store
                    .record_stand_in_role_task_address(id, identity.user, next, &self.device_id)
                    .map_err(settings_error)?,
                Err(error) => {
                    store
                        .record_stand_in_role_route_failure(
                            id,
                            identity.user,
                            next,
                            &error.code,
                            retryable_role_dispatch(&error.code),
                        )
                        .map_err(settings_error)?;
                    return Err(error);
                }
            }
        }
        Ok(self.role_submission_response(identity.user, id, &row, replayed))
    }

    pub(super) fn role_submission_response(
        &self,
        user: i64,
        id: &str,
        row: &Value,
        replayed: bool,
    ) -> Value {
        let mut status = remote_role_status(row);
        let local = self.accepted_local_role_branch(user, id, row);
        if let Some(link) = local.as_ref().filter(|_| status == "dispatched") {
            status = self.role_execution_status(link, true);
            if status == "done" && self.role_task_has_unprocessed_children(link, user) {
                status = "running";
            }
        }
        let mut response = json!({"accepted":true,"alreadyAccepted":replayed,"taskId":id,
            "deviceId":row["intent"]["targetDevice"], "status":status,
            "attempt":row["attempt"].as_u64().unwrap_or(0)});
        if replayed && local.is_some() {
            response["alreadyExists"] = json!(true);
        }
        response
    }
}
