//! Owner self-channel requests can start workers without acquiring personal control.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;
use sha2::{Digest, Sha256};

fn denied() -> AppIpcError {
    AppIpcError::new("permission_denied", "A verified owner self-conversation is required to start a personal task from a connected source")
}

impl RuntimeWorkRpcHandler {
    pub(super) fn source_task_context(
        &self,
        identity: &StandInMcpIdentity,
        message: &str,
    ) -> Result<(Value, Value), AppIpcError> {
        let source = self.authorize_work_source_read(identity, &Value::Null)?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let messages = store
            .stand_in_messages(identity.user, identity.work.as_deref().ok_or_else(denied)?)
            .map_err(super::stand_in::settings_error)?;
        let record = messages
            .iter()
            .find(|record| record["recordId"] == message)
            .ok_or_else(denied)?;
        // Provider-derived identity is evidence of the participant, never an operation grant.
        // Own messages sent to colleagues or groups are not owner self-conversations.
        if record["isSelfConversation"] != true
            || record["isOwn"] != true
            || !super::stand_in_read_sources::same_source(&record["source"], &source)
        {
            return Err(denied());
        }
        let settings = store
            .personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
        let mut config = roles
            .into_iter()
            .find(|role| role["id"].as_str() == identity.role.as_deref())
            .ok_or_else(denied)?;
        let actor = self.local_task_link(&identity.task_id).ok_or_else(denied)?;
        let manual = actor.runtime_handle["executionRequest"]["origin"]["manual"] == true;
        if manual
            && !actor.runtime_handle["executionRequest"]["standInSourceBindings"]
                .as_array()
                .is_some_and(|bindings| {
                    bindings.iter().any(|binding| {
                        binding["recordId"] == message
                            && super::stand_in_read_sources::same_source(
                                &binding["source"],
                                &source,
                            )
                    })
                })
        {
            return Err(denied());
        }
        if !manual && (config["enabled"] != true || source["policy"]["automatic"] != true) {
            return Err(denied());
        }
        let ask = manual
            || identity.ask_before_act
            || source["policy"]["askBeforeAct"] == true
            || actor.runtime_handle["origin"]["askBeforeAct"] == true;
        config["userId"] = json!(identity.user);
        config["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":ask});
        Ok((config, record.clone()))
    }

    pub(super) fn authorized_manual_source_turn(
        &self,
        link: &RuntimeTaskLink,
        request: &ExecutionRequest,
    ) -> Result<bool, AppIpcError> {
        let saved = &link.runtime_handle["executionRequest"];
        if saved["standInDelegation"]["sourceMessageId"].is_string() {
            let parent = self.source_task_parent(link)?;
            return Ok(self.local_task_link(&parent.task_id).is_some_and(|parent| {
                parent.runtime_handle["executionRequest"]["origin"]["manual"] == true
            }));
        }
        if matches!(
            link.runtime_handle["origin"]["type"].as_str(),
            Some("connection_work" | "dingtalk_work")
        ) && saved["origin"]["manual"] == true
            && request.extra.get("standInManualConfirmation") == Some(&json!(true))
        {
            if request.extra.get("standInSourceBindings") != saved.get("standInSourceBindings") {
                return Err(denied());
            }
            let mut request = request.clone();
            self.refresh_stand_in_confirmation(&link.local_task_id, &mut request)?;
            return Ok(true);
        }
        Ok(false)
    }

    pub(super) async fn create_source_task(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        if !args.as_object().is_some_and(|fields| {
            fields.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "requestId" | "messageId" | "title" | "message"
                )
            })
        }) {
            return Err(denied());
        }
        let message = super::stand_in_tasks::required(args, "messageId")?;
        let (config, _) = self.source_task_context(identity, message)?;
        let key = json!([
            identity.user,
            identity.task_id,
            message,
            super::stand_in_tasks::required(args, "requestId")?
        ]);
        let id = format!(
            "stand-in-task-{:x}",
            Sha256::digest(key.to_string().as_bytes())
        );
        let gate = self.task_send_gate(&format!("stand-in-task-operation:{id}"));
        let _guard = gate.lock().await;
        if let Some(link) = self.local_task_link(&id) {
            if self.source_task_parent(&link).is_ok() {
                return Ok(json!({"success":true,"taskId":id,"alreadyExists":true}));
            }
            return Err(denied());
        }
        let delegation = json!({"userId":identity.user,"sourceTaskId":identity.task_id,
            "sourceMessageId":message,"askBeforeAct":config["handlingPolicy"]["askBeforeAct"],"readSources":[]});
        self.start_delegated_task(args, &id, &config, delegation)
            .await
    }

    pub(super) fn source_task_parent(
        &self,
        child: &RuntimeTaskLink,
    ) -> Result<StandInMcpIdentity, AppIpcError> {
        let saved = &child.runtime_handle["executionRequest"];
        let delegation = &saved["standInDelegation"];
        let origin = &child.runtime_handle["origin"];
        let user = saved["user_id"].as_i64().ok_or_else(denied)?;
        if child.ephemeral
            || origin["type"] != "stand_in_task"
            || origin["initiatedBy"] != "stand_in"
            || origin["userId"] != user
            || origin["deviceId"] != self.device_id
            || origin["standInId"] != "@primary"
            || delegation["userId"] != user
            || delegation["sourceTaskId"] != origin["sourceTaskId"]
            || delegation["readSources"] != json!([])
        {
            return Err(denied());
        }
        let parent = self
            .local_task_link(origin["sourceTaskId"].as_str().ok_or_else(denied)?)
            .ok_or_else(denied)?;
        let mut request = ExecutionRequest {
            task_id: parent.local_task_id.clone(),
            ..Default::default()
        };
        request
            .extra
            .insert("origin".into(), parent.runtime_handle["origin"].clone());
        let identity = crate::task_runtime::mcp::stand_in_identity(&request).ok_or_else(denied)?;
        if identity.user != user {
            return Err(denied());
        }
        self.source_task_context(
            &identity,
            delegation["sourceMessageId"].as_str().ok_or_else(denied)?,
        )?;
        Ok(identity)
    }
}

#[cfg(test)]
#[path = "stand_in_source_tasks_tests.rs"]
mod tests;
