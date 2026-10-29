//! Primary stand-in orchestration uses the same task lifecycle as the workbench.
use super::*;
use crate::task_runtime::mcp::{stand_in_tasks, StandInMcpIdentity};

fn owns_task(link: &RuntimeTaskLink, user: i64) -> bool {
    link.runtime_handle["executionRequest"]["user_id"].as_i64() == Some(user)
        && link.runtime_handle["origin"]["type"] != "stand_in_coordinator"
        && link.runtime_handle["origin"]["type"] != "stand_in_identity"
        && !link.ephemeral
}

fn required<'a>(args: &'a Value, field: &str) -> Result<&'a str, AppIpcError> {
    args[field]
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.len() <= 32000)
        .ok_or_else(|| AppIpcError::new("bad_request", format!("{field} is required")))
}

impl RuntimeWorkRpcHandler {
    pub(super) fn register_stand_in_task_dispatcher(&self) {
        let handler = self.clone();
        stand_in_tasks::register(Arc::new(move |identity, name, args| {
            let handler = handler.clone();
            Box::pin(async move {
                handler
                    .stand_in_task_operation(identity, &name, args)
                    .await
                    .map_err(|error| format!("{}: {}", error.code, error.message))
            })
        }));
    }

    async fn stand_in_task_operation(
        &self,
        identity: StandInMcpIdentity,
        name: &str,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        if identity.device != self.device_id
            || identity.work.is_some()
            || !matches!(identity.role.as_deref(), None | Some("@primary"))
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Only the primary stand-in can orchestrate tasks",
            ));
        }
        let actor = self.local_task_link(&identity.task_id).ok_or_else(|| {
            AppIpcError::new("permission_denied", "Stand-in session is unavailable")
        })?;
        if actor.runtime_handle["executionRequest"]["user_id"].as_i64() != Some(identity.user)
            || actor.runtime_handle["origin"]["userId"] != identity.user
            || !matches!(
                actor.runtime_handle["origin"]["type"].as_str(),
                Some("stand_in_identity" | "stand_in_coordinator")
            )
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Stand-in session owner changed",
            ));
        }
        let gate = self.task_send_gate(&format!("stand-in-processing:{}", identity.user));
        let _processing_guard = if identity.coordinator_batch.is_some()
            && matches!(name, "create_task" | "continue_task")
        {
            Some(gate.lock().await)
        } else {
            None
        };
        if let Some(batch) = identity.coordinator_batch.as_deref() {
            let store = LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(super::stand_in::settings_error)?;
            let state = store
                .stand_in_processing_state(identity.user)
                .map_err(super::stand_in::settings_error)?;
            let settings = store
                .personal_stand_in(identity.user, &self.device_id)
                .map_err(super::stand_in::settings_error)?;
            if state["batchId"] != batch || settings["processing"]["mode"] != "silent" {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Background batch was revoked",
                ));
            }
        }
        if name == "list_tasks" {
            return Ok(json!({"items": self.local_task_links(false).into_iter()
                .filter(|link| owns_task(link, identity.user)).take(100)
                .map(|link| json!({"taskId":link.local_task_id,"title":link.title,"status":link.status,"interactionStatus":link.interaction_status})).collect::<Vec<_>>()}));
        }
        if name == "create_task" {
            return self.create_primary_task(&identity, &args).await;
        }
        let id = required(&args, "taskId")?;
        let gate = self.task_send_gate(&format!("stand-in-task-operation:{id}"));
        let _guard = gate.lock().await;
        let link = self
            .local_task_link(id)
            .filter(|link| owns_task(link, identity.user))
            .ok_or_else(|| {
                AppIpcError::new(
                    "permission_denied",
                    "Task does not belong to the current user",
                )
            })?;
        if name == "read_task" {
            return self
                .transcript(json!({"taskId":id,"limit":50,"includeFullContent":false}))
                .await;
        }
        if name != "continue_task" || link.status == "archived" || link.interaction_status.is_some()
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Task cannot be continued; user input and approvals require the user",
            ));
        }
        if !is_codex_runtime(&link.runtime) {
            return Err(AppIpcError::new(
                "confirmation_runtime_unsupported",
                "Use a Codex task to retain native confirmation controls",
            ));
        }
        self.validate_primary_task_followup(identity.user, &link)
            .await?;
        let message = required(&args, "message")?;
        let client = format!(
            "stand-in:{}:{}",
            identity.task_id,
            required(&args, "requestId")?
        );
        if crate::runtime_work::runtime_handle_messages::user_message_presentations(&link)
            .iter()
            .any(|row| row["clientUserMessageId"] == client)
        {
            return Ok(json!({"success":true,"taskId":id,"alreadyAccepted":true}));
        }
        let mut request = link.runtime_handle["executionRequest"].clone();
        request["prompt"] = json!(message);
        // Source-driven orchestration never elevates an existing conversation.
        request["standInDelegation"] =
            json!({"sourceTaskId":identity.task_id,"userId":identity.user,"askBeforeAct":true});
        Box::pin(self.send_message(json!({"taskId":id,"message":message,"executionRequest":request,"clientUserMessageId":client,"queueIfBusy":true}))).await
    }

    async fn validate_primary_task_followup(
        &self,
        user: i64,
        link: &RuntimeTaskLink,
    ) -> Result<(), AppIpcError> {
        let origin = &link.runtime_handle["origin"];
        if origin["initiatedBy"] != "stand_in"
            || !matches!(
                origin["type"].as_str(),
                Some("connection_work" | "dingtalk_work" | "issue_dispatch")
            )
        {
            return Ok(());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
        let role = roles
            .iter()
            .find(|role| role["id"] == origin["standInId"] && role["enabled"] == true)
            .ok_or_else(|| {
                AppIpcError::new("permission_denied", "The work role is no longer enabled")
            })?;
        self.validate_followup_role(&store, user, role, link).await
    }

    async fn create_primary_task(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        use sha2::{Digest, Sha256};
        let key = json!([
            identity.user,
            identity.task_id,
            required(args, "requestId")?
        ])
        .to_string();
        let id = format!("stand-in-task-{:x}", Sha256::digest(key.as_bytes()));
        let gate = self.task_send_gate(&format!("stand-in-task-operation:{id}"));
        let _guard = gate.lock().await;
        if let Some(link) = self.local_task_link(&id) {
            if owns_task(&link, identity.user) {
                return Ok(json!({"success":true,"taskId":id,"alreadyExists":true}));
            }
            return Err(AppIpcError::new(
                "permission_denied",
                "Task ID is unavailable",
            ));
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let mut config = settings["primary"].clone();
        config["userId"] = json!(identity.user);
        config["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":true});
        let origin = json!({"type":"stand_in_task","initiatedBy":"stand_in","userId":identity.user,"deviceId":self.device_id,"sourceTaskId":identity.task_id,"askBeforeAct":true});
        let payload = self.prepare_stand_in_execution(json!({"taskId":id,"title":required(args,"title")?,"message":required(args,"message")?,"origin":origin}), &config).await?;
        Box::pin(self.create_task(payload)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_access_requires_recorded_owner_and_excludes_private_sessions() {
        let mut link =
            RuntimeTaskLink::new_pending("ordinary".into(), "".into(), "Ordinary".into());
        assert!(!owns_task(&link, 7));
        link.runtime_handle = json!({"executionRequest":{"user_id":7}});
        assert!(owns_task(&link, 7));
        assert!(!owns_task(&link, 8));
        link.runtime_handle["origin"] = json!({"type":"stand_in_identity"});
        assert!(!owns_task(&link, 7));
    }
}

#[cfg(test)]
mod operation_tests {
    use super::*;

    #[tokio::test]
    async fn coordinator_mutations_wait_for_settings_and_recheck_revoked_batches() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.upsert_local_task(RuntimeTaskLink { local_task_id: "coordinator".into(), runtime_handle: json!({"origin":{"type":"stand_in_coordinator","userId":7},"executionRequest":{"user_id":7}}), ..Default::default() });
        let identity = StandInMcpIdentity {
            task_id: "coordinator".into(),
            user: 7,
            device: "mac".into(),
            role: None,
            work: None,
            ask_before_act: true,
            coordinator_batch: Some("batch".into()),
        };
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        for operation in ["create_task", "continue_task"] {
            let mut settings = store.personal_stand_in(7, "mac").unwrap();
            settings["processing"] = json!({"mode":"silent","intervalMinutes":5});
            let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
            store
                .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
                .unwrap();
            let gate = handler.task_send_gate("stand-in-processing:7");
            let guard = gate.lock().await;
            let mutation = handler.stand_in_task_operation(identity.clone(), operation, json!({}));
            tokio::pin!(mutation);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut mutation)
                    .await
                    .is_err()
            );
            settings["processing"]["mode"] = json!("immediate");
            store.save_personal_stand_in(7, "mac", settings).unwrap();
            drop(guard);
            assert_eq!(mutation.await.unwrap_err().code, "permission_denied");
        }
        assert_eq!(handler.local_task_links(true).len(), 1);
    }

    #[tokio::test]
    async fn primary_orchestration_isolates_owners_and_never_answers_pending_interactions() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.upsert_local_task(RuntimeTaskLink { local_task_id: "primary".into(), runtime_handle: json!({"origin":{"type":"stand_in_identity","userId":7},"executionRequest":{"user_id":7}}), ..Default::default() });
        for (id, user, interaction) in [
            ("own", 7, None),
            ("foreign", 8, None),
            ("waiting", 7, Some("waitingForUserInput")),
            ("approval", 7, Some("waitingForApproval")),
        ] {
            handler.upsert_local_task(RuntimeTaskLink {
                local_task_id: id.into(),
                interaction_status: interaction.map(str::to_owned),
                runtime_handle: json!({"executionRequest":{"user_id":user}}),
                ..Default::default()
            });
        }
        let identity = StandInMcpIdentity {
            task_id: "primary".into(),
            user: 7,
            device: "mac".into(),
            role: None,
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
        };
        let listed = handler
            .stand_in_task_operation(identity.clone(), "list_tasks", json!({}))
            .await
            .unwrap();
        assert_eq!(listed["items"].as_array().unwrap().len(), 3);
        assert!(!listed.to_string().contains("foreign"));
        for id in ["foreign", "waiting", "approval", "missing"] {
            let error = handler
                .stand_in_task_operation(
                    identity.clone(),
                    "continue_task",
                    json!({"taskId":id,"message":"continue","requestId":"one"}),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "permission_denied");
        }
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:"revoked".into(), runtime:"codex".into(), runtime_handle:json!({"origin":{"type":"connection_work","initiatedBy":"stand_in","standInId":"removed","userId":7},"executionRequest":{"user_id":7}}),..Default::default()});
        assert_eq!(
            handler
                .stand_in_task_operation(
                    identity.clone(),
                    "continue_task",
                    json!({"taskId":"revoked","message":"continue","requestId":"one"})
                )
                .await
                .unwrap_err()
                .code,
            "permission_denied"
        );
        let role = StandInMcpIdentity {
            role: Some("review".into()),
            ..identity
        };
        assert_eq!(
            handler
                .stand_in_task_operation(role, "list_tasks", json!({}))
                .await
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }
}
