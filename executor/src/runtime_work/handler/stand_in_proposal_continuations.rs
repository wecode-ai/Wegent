//! Configuration acceptance resumes only its verified, still-current owner request.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;

const OWNER: &str = "standInOwnerRequest";
const EXPECTED: &str = "standInExpectedOwnerRequest";

#[cfg(test)]
#[path = "stand_in_proposal_continuations_tests.rs"]
mod tests;

fn denied() -> AppIpcError {
    AppIpcError::new(
        "owner_request_changed",
        "The original owner request is no longer current",
    )
}

impl RuntimeWorkRpcHandler {
    pub(super) fn current_stand_in_owner_request(&self, task: &str) -> Option<Value> {
        let link = self.local_task_link(task)?;
        let mut candidates = vec![
            link.runtime_handle[OWNER].clone(),
            link.runtime_handle["executionRequest"][OWNER].clone(),
        ];
        candidates.extend(
            self.turn_scheduler
                .lock()
                .ok()?
                .queued_turns
                .iter()
                .filter(|turn| turn.local_task_id == task)
                .filter_map(|turn| turn.request.extra.get(OWNER).cloned()),
        );
        // An immediately started input is durable in the command journal before
        // the independently persisted task link receives its generation.
        candidates.extend(
            self.command_journal
                .lock()
                .ok()?
                .values()
                .filter(|command| command.turn.local_task_id == task)
                .filter_map(|command| command.turn.request.extra.get(OWNER).cloned()),
        );
        candidates.retain(|value| {
            value["taskId"] == task
                && value["deviceId"] == self.device_id
                && value["userId"] == link.runtime_handle["origin"]["userId"]
                && value["roleId"] == link.runtime_handle["origin"]["standInId"]
        });
        let revision = candidates
            .iter()
            .filter_map(|value| value["revision"].as_u64())
            .max()?;
        let mut current = candidates
            .into_iter()
            .filter(|value| value["revision"] == revision);
        let first = current.next()?;
        if current.any(|value| value != first) {
            return None;
        }
        (first["taskId"] == task && first["deviceId"] == self.device_id).then_some(first)
    }

    pub(super) fn stamp_stand_in_owner_request(
        &self,
        task: &str,
        request: &mut ExecutionRequest,
        activity: bool,
    ) -> Result<(), AppIpcError> {
        let expected = request.extra.remove(EXPECTED);
        request.extra.remove(OWNER);
        let origin = request.extra.get("origin").cloned().unwrap_or(Value::Null);
        if origin["type"] != "stand_in_identity" {
            return Ok(());
        }
        let user = request
            .extra
            .get("user_id")
            .and_then(Value::as_i64)
            .filter(|id| *id >= 0)
            .ok_or_else(denied)?;
        let role = origin["standInId"].as_str();
        if origin["userId"] != user
            || origin["deviceId"] != self.device_id
            || task != super::stand_in_conversations::conversation_task_id(user, role)
        {
            return Err(denied());
        }
        let current = self.current_stand_in_owner_request(task);
        if activity {
            if let Some(expected) = expected.filter(|value| !value.is_null()) {
                if current.as_ref() != Some(&expected) || expected["cancelled"] == true {
                    return Err(denied());
                }
                request.extra.insert(EXPECTED.into(), expected);
            }
            if let Some(current) = current {
                request.extra.insert(OWNER.into(), current);
            }
        } else {
            let revision = current
                .as_ref()
                .and_then(|value| value["revision"].as_u64())
                .unwrap_or(0)
                + 1;
            request.extra.insert(OWNER.into(), json!({"id":uuid::Uuid::new_v4().to_string(),"revision":revision,"taskId":task,"userId":user,"deviceId":self.device_id,"roleId":role,"cancelled":false}));
        }
        Ok(())
    }

    pub(super) fn record_stand_in_owner_admission(&self, task: &str, owner: &Value) {
        self.store.update_task(task, |link| {
            if link.runtime_handle[OWNER]["revision"].as_u64().unwrap_or(0)
                < owner["revision"].as_u64().unwrap_or(0)
            {
                link.runtime_handle[OWNER] = owner.clone();
            }
        });
    }

    pub(super) fn bind_stand_in_owner_command(&self, payload: &mut Value, activity: bool) {
        if activity || payload.get("commandId").is_some() {
            return;
        }
        let Some(task) = runtime_task_id(payload) else {
            return;
        };
        let origin = self
            .local_task_link(&task)
            .map(|link| link.runtime_handle["origin"].clone())
            .or_else(|| {
                execution_request(payload).and_then(|request| request.extra.get("origin").cloned())
            });
        let Some(origin) = origin.filter(|origin| origin["type"] == "stand_in_identity") else {
            return;
        };
        let Some(user) = origin["userId"].as_i64().filter(|id| *id >= 0) else {
            return;
        };
        if task
            != super::stand_in_conversations::conversation_task_id(
                user,
                origin["standInId"].as_str(),
            )
        {
            return;
        }
        let id = payload
            .get("clientUserMessageId")
            .or_else(|| payload.get("client_user_message_id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(|id| {
                use sha2::{Digest, Sha256};
                format!("{:x}", Sha256::digest(id.as_bytes()))
            })
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        payload["commandId"] = json!(format!("stand-in-owner-input:{id}"));
    }

    pub(super) fn invalidate_stand_in_owner_request(&self, task: &str) {
        if let Some(mut current) = self.current_stand_in_owner_request(task) {
            current["revision"] = json!(current["revision"].as_u64().unwrap() + 1);
            current["id"] = json!(uuid::Uuid::new_v4().to_string());
            current["cancelled"] = json!(true);
            self.store
                .update_task(task, |link| link.runtime_handle[OWNER] = current);
        }
    }

    pub(super) fn stand_in_owner_request_matches(
        &self,
        request: &ExecutionRequest,
        task: &str,
    ) -> bool {
        request.extra.get(EXPECTED).map_or(true, |expected| {
            self.current_stand_in_owner_request(task).as_ref() == Some(expected)
                && expected["cancelled"] != true
        })
    }

    pub(super) fn propose_stand_in_profile(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let task = super::stand_in_conversations::conversation_task_id(
            identity.user,
            identity.role.as_deref(),
        );
        let actor = self.local_task_link(&identity.task_id).ok_or_else(denied)?;
        let origin = &actor.runtime_handle["origin"];
        if identity.task_id != task
            || identity.device != self.device_id
            || identity.work.is_some()
            || identity.project.is_some()
            || identity.coordinator_batch.is_some()
            || identity.readonly_worker
            || identity.review
            || actor.status == "archived"
            || actor.runtime_handle["executionRequest"]["user_id"] != identity.user
            || origin["type"] != "stand_in_identity"
            || origin["userId"] != identity.user
            || origin["deviceId"] != self.device_id
            || origin["standInId"].as_str() != identity.role.as_deref()
        {
            return Err(denied());
        }
        if args
            .get("continueCurrentRequest")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(AppIpcError::new(
                "bad_request",
                "continueCurrentRequest must be a boolean",
            ));
        }
        let continuation = (args["continueCurrentRequest"] == true)
            .then(|| self.current_stand_in_owner_request(&task))
            .flatten()
            .filter(|owner| {
                owner["cancelled"] != true
                    && actor.runtime_handle["executionRequest"][OWNER] == *owner
            });
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let mut proposal = store
            .propose_stand_in_settings_with_continuation(
                identity.user,
                &self.device_id,
                identity.role.as_deref(),
                args["summary"].as_str().unwrap_or_default(),
                args["settings"].clone(),
                continuation.clone(),
            )
            .map_err(super::stand_in::settings_error)?;
        proposal["willContinueCurrentRequest"] = json!(continuation.is_some());
        Ok(proposal)
    }

    pub(super) async fn flush_stand_in_proposal_continuations(&self) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        for row in store
            .pending_stand_in_proposal_continuations(&self.device_id)
            .map_err(super::stand_in::settings_error)?
        {
            let id = row["proposalId"].as_str().ok_or_else(denied)?;
            let gate = self.task_send_gate(&format!("stand-in-proposal-resume:{id}"));
            let _guard = gate.lock().await;
            let owner = &row["ownerRequest"];
            let task = owner["taskId"].as_str().ok_or_else(denied)?;
            let user = owner["userId"].as_i64().ok_or_else(denied)?;
            let command = format!("stand-in-proposal-resume:{id}");
            let receipt = self
                .command_receipt(json!({"taskId":task,"commandId":command,"userId":user}))
                .await;
            let status = match receipt {
                Ok(_) => "delivered",
                Err(error) if error.code == "not_found" => {
                    let valid = self.local_task_link(task).is_some_and(|actor| {
                        actor.status != "archived"
                            && actor.runtime_handle["origin"]["type"] == "stand_in_identity"
                            && actor.runtime_handle["origin"]["userId"] == user
                            && actor.runtime_handle["origin"]["deviceId"] == self.device_id
                            && actor.runtime_handle["origin"]["standInId"] == owner["roleId"]
                            && actor.runtime_handle["executionRequest"]["user_id"] == user
                    }) && self.current_stand_in_owner_request(task).as_ref()
                        == Some(owner)
                        && owner["cancelled"] != true;
                    if !valid {
                        "cancelled"
                    } else {
                        let message = format!("Wework configuration proposal {id} was accepted for the same still-current owner request. Read the current profile and continue that original business request. This notification grants no additional permissions to any existing worker and is not a new business event or a reason to send an unrelated reminder. Preserve existing approvals; choose exact read sources for any new worker. Deliver the actual useful result in this original conversation.");
                        match self
                            .deliver_identity_activity(
                                user,
                                owner["roleId"].as_str(),
                                &command,
                                &message,
                                "配置已确认，继续原请求",
                                Some(owner),
                            )
                            .await
                        {
                            Ok(Some(result))
                                if result["accepted"] != false && result["success"] != false =>
                            {
                                "delivered"
                            }
                            Err(error) if error.code == "owner_request_changed" => "cancelled",
                            _ => continue,
                        }
                    }
                }
                Err(_) => continue,
            };
            store
                .settle_stand_in_proposal_continuation(id, status)
                .map_err(super::stand_in::settings_error)?;
        }
        Ok(())
    }
}
