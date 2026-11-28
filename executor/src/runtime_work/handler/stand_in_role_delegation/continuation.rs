//! Admit a new turn on the exact branch previously dispatched by this actor.
use super::super::stand_in::settings_error;
use super::super::stand_in_proposal_continuations::OWNER;
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

pub(super) fn matches_delegation_command(
    actor: &RuntimeTaskLink,
    caller_command: Option<&str>,
    requires_owner_message: bool,
) -> bool {
    let Some(command) = caller_command else {
        return !requires_owner_message;
    };
    let request = &actor.runtime_handle["executionRequest"];
    request["runtime_command_id"] == command
        && (!requires_owner_message
            || (supports_role_delegation(&actor.runtime_handle["origin"])
                && request[OWNER]["commandId"] == command
                && request["standInRoleResultRoot"].is_null()))
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn with_current_delegation_command<T>(
        &self,
        actor: &RuntimeTaskLink,
        caller_command: Option<&str>,
        requires_owner_message: bool,
        operation: impl FnOnce() -> Result<T, TaskRuntimeError>,
    ) -> Result<T, AppIpcError> {
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
        if (caller_command.is_some() || requires_owner_message)
            && !self
                .store
                .read_task(&actor.local_task_id, |link| {
                    matches_delegation_command(link, caller_command, requires_owner_message)
                })
                .unwrap_or(false)
        {
            return Err(denied());
        }
        operation().map_err(reservation_error)
    }

    pub(super) async fn continue_role_task(
        &self,
        store: &LocalTaskStore,
        identity: &StandInMcpIdentity,
        actor: &RuntimeTaskLink,
        role: &mut Value,
        mut input: Value,
        caller_command: Option<&str>,
    ) -> Result<Value, AppIpcError> {
        let mut branch = input["roleDelegation"].take();
        let request_root = branch["root"].as_str().ok_or_else(denied)?.to_owned();
        let id = super::super::stand_in_tasks::required(&input, "taskId")?;
        let saved = store
            .stand_in_role_request(id, identity.user)
            .map_err(settings_error)?
            .ok_or_else(denied)?;
        let mut intent = saved["intent"].clone();
        // An explicit owner message may select an older task. The task's original
        // group still owns its ancestry, dependencies, cancellation and routing.
        let task_root = saved["root"].as_str().ok_or_else(denied)?;
        let later_message = task_root != request_root;
        if !matches_delegation_command(actor, caller_command, later_message) {
            return Err(denied());
        }
        branch["root"] = json!(task_root);
        if intent["roleDelegation"] != branch
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
        let lookup =
            || store.replayed_stand_in_role_followup(id, identity.user, &request_root, &intent);
        // A cross-request replay can bind the old receipt to this new request.
        let replay = if later_message {
            self.with_current_delegation_command(actor, caller_command, later_message, lookup)
                .await?
        } else {
            lookup().map_err(reservation_error)?
        };
        if let Some(previous) = replay {
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
                .parent_role_result_receipt(&identity.task_id, identity.user, receipt)
                .await?
                .is_some()
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
        // Finish durable admission and release its guards before entering the scheduler.
        let (row, replayed) = self
            .with_current_delegation_command(actor, caller_command, later_message, || {
                store.continue_stand_in_role_request(
                    id,
                    identity.user,
                    &request_root,
                    &intent,
                    Some(attempt),
                )
            })
            .await?;
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
        if let Some(error) = row["terminalError"].as_str() {
            response["accepted"] = json!(false);
            response["errorCode"] = json!(error);
        }
        if replayed && local.is_some() {
            response["alreadyExists"] = json!(true);
        }
        response
    }
}
