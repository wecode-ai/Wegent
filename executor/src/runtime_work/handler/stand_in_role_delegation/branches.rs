//! Project the delegation branch status from durable requests and local execution.
use super::super::stand_in_role_results::RoleChildrenIndex;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) fn stand_in_role_branches(
        &self,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::super::runtime_owner::runtime_user(payload)?;
        let task = super::super::stand_in_tasks::required(payload, "taskId")?;
        let Some(link) = self.store.get_task_summary(task) else {
            return Ok(json!({"items":[]}));
        };
        let origin = &link.runtime_handle["origin"];
        if !owned_role_task(&link, user, &self.device_id)
            || origin["type"] != "stand_in_identity"
            || !origin["conversationScope"].is_null()
        {
            return Err(denied());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::super::stand_in::settings_error)?;
        let requests = store
            .role_requests_for_conversation(user, &self.device_id, task)
            .map_err(super::super::stand_in::settings_error)?;
        let roots = requests
            .iter()
            .filter_map(|(_, _, metadata)| metadata["root"].as_str())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut children = RoleChildrenIndex::new(self, user);
        let items = requests.iter().map(|(task_id, created_at, metadata)| {
            let intent = &metadata["intent"];
            let status = remote_role_status(metadata);
            let mut row = json!({"taskId":task_id,"createdAt":created_at,"root":metadata["root"],
                "title":intent["title"],"roleName":intent["roleName"],"deviceId":intent["targetDevice"],
                "parentTaskId":intent["sourceTaskId"],"ancestors":intent["roleDelegation"]["ancestors"],
                "prerequisiteTaskIds":intent["dependsOn"],
                "taskAddress":metadata["taskAddress"],"status":status,
                "attempt":metadata["attempt"].as_u64().unwrap_or(0),
                "retryAllowed":metadata["cancelRequested"] != true && (intent["sourceRoute"].is_null()
                    || metadata["resultStatus"] == "failed" || metadata["terminalError"].is_string()),
                "cancelGroup":metadata["cancelGroup"] == true,
                "errorCode":metadata["terminalError"]});
            if status == "dispatched" {
                if let Some(link) = self.accepted_local_role_branch(user, task_id, metadata) {
                    let status = self.role_execution_status(&link, true);
                    row["statusSource"] = json!("local_execution");
                    if matches!(status, "done" | "cancelled")
                        && children.has_unprocessed_children(&link, |_| {
                            store.role_completion_requests_for_roots(user, &self.device_id, &roots)
                        })
                    {
                        row["status"] = json!("running");
                        row["waitingForChildren"] = json!(true);
                    } else {
                        row["status"] = json!(status);
                    }
                    row["retryAllowed"] = json!(
                        status == "failed"
                            && link.status == "failed"
                            && metadata["cancelRequested"] != true
                    );
                    if status == "failed" {
                        row["errorCode"] = role_failure_error_code(&link);
                    }
                }
            }
            row
        }).collect::<Vec<_>>();
        Ok(json!({"items":items}))
    }

    fn accepted_local_role_branch(
        &self,
        user: i64,
        task_id: &str,
        metadata: &Value,
    ) -> Option<RuntimeTaskLink> {
        let intent = &metadata["intent"];
        let address = &metadata["taskAddress"];
        if !intent["sourceRoute"].is_null()
            || intent["sourceDevice"] != self.device_id
            || intent["targetDevice"] != self.device_id
            || address["deviceId"] != self.device_id
            || address["taskId"] != task_id
            || !metadata["root"].is_string()
            || metadata["root"] != intent["roleDelegation"]["root"]
        {
            return None;
        }
        self.store.get_task_summary(task_id).filter(|link| {
            let origin = &link.runtime_handle["origin"];
            let delegation = &link.runtime_handle["executionRequest"]["standInDelegation"];
            owned_role_task(link, user, &self.device_id)
                && role_intent_matches_link(link, intent)
                && (origin["sourceDeviceId"].is_null()
                    || origin["sourceDeviceId"] == self.device_id)
                && delegation["userId"] == user
                && delegation["sourceTaskId"] == intent["sourceTaskId"]
                && delegation["roleDelegation"] == intent["roleDelegation"]
                && role_attempt(link) == metadata["attempt"].as_u64().unwrap_or(0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::stand_in_task_results::{
        stand_in_result_command, stand_in_result_completion,
    };
    use super::*;

    #[tokio::test]
    async fn branch_status_uses_the_current_owned_local_result_without_needing_a_reminder() {
        struct ExecutorHomeRestore(Option<std::ffi::OsString>);
        impl Drop for ExecutorHomeRestore {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => std::env::set_var("WEGENT_EXECUTOR_HOME", value),
                    None => std::env::remove_var("WEGENT_EXECUTOR_HOME"),
                }
            }
        }

        let root = tempfile::tempdir().unwrap();
        let mut handler = {
            let _guard = crate::test_env::lock();
            let _home = ExecutorHomeRestore(std::env::var_os("WEGENT_EXECUTOR_HOME"));
            std::env::set_var("WEGENT_EXECUTOR_HOME", root.path());
            RuntimeWorkRpcHandler::new("desktop", "unused")
        };
        let index_path = root.path().join("runtime.json");
        handler.store = RuntimeWorkStore::new(index_path.clone());
        let user = 7;
        let conversation = "assistant";
        let branch = json!({"root":"request","ancestors":[conversation]});
        let intent = json!({"sourceDevice":"desktop","targetDevice":"desktop",
            "sourceTaskId":conversation,"roleId":"writer","roleDelegation":branch});
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: conversation.into(),
            runtime_handle: json!({"origin":{"type":"stand_in_identity","deviceId":"desktop","userId":user},
                "executionRequest":{"user_id":user}}),
            ..Default::default()
        });
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store
            .reserve_stand_in_role_request("specialist", user, "request", &intent, 1)
            .unwrap();
        store
            .record_stand_in_role_task_address("specialist", user, "desktop")
            .unwrap();
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "specialist".into(),
            status: "done".into(),
            completed_at: Some(123),
            runtime_handle: json!({"origin":{"type":"stand_in_task","deviceId":"desktop","userId":user,
                "standInId":"writer","sourceTaskId":conversation,"roleDelegation":branch},
                "executionRequest":{"user_id":user,"standInDelegation":{"sourceTaskId":conversation,
                    "userId":user,"roleDelegation":branch},"runtime_command_id":"initial"},"lastTurnId":"specialist-turn"}),
            ..Default::default()
        });
        let row = |handler: &RuntimeWorkRpcHandler| {
            handler
                .stand_in_role_branches(&json!({"userId":user,"taskId":conversation}))
                .unwrap()["items"][0]
                .clone()
        };
        // A historical local completion may have no recorded outbox result.
        assert_eq!(row(&handler)["status"], "done");
        assert_eq!(row(&handler)["statusSource"], "local_execution");
        // A legacy timestamp repair does not prove that an archived turn succeeded.
        handler.store.update_task("specialist", |link| {
            link.status = "archived".into();
            link.turn_status = None;
            link.completed_at = None;
            link.updated_at = 2_000_000_000_000;
        });
        handler.repair_legacy_task_activity_time("specialist", &json!({"updatedAt":1_780_000_000}));
        assert!(handler
            .local_task_link("specialist")
            .unwrap()
            .completed_at
            .is_some());
        assert_eq!(row(&handler)["status"], "running");
        handler.store.update_task("specialist", |link| {
            link.turn_status = Some("failed".into());
        });
        let archived = row(&handler);
        assert_eq!(archived["status"], "failed");
        assert_eq!(archived["retryAllowed"], false);
        handler.store.update_task("specialist", |link| {
            link.turn_status = Some("completed".into());
        });
        assert_eq!(row(&handler)["status"], "done");
        handler.store.update_task("specialist", |link| {
            link.status = "done".into();
        });
        handler.record_stand_in_completion_outbox("specialist", "done");
        assert_eq!(row(&handler)["status"], "done");

        let mut child = RuntimeTaskLink {
            local_task_id: "child".into(),
            thread_id: Some("child-thread".into()),
            status: "done".into(),
            completed_at: Some(124),
            runtime_handle: json!({"origin":{"type":"stand_in_task","deviceId":"desktop","userId":user,
                "sourceTaskId":"specialist","roleDelegation":{"root":"request"}},
                "executionRequest":{"user_id":user},"lastTurnId":"child-turn"}),
            ..Default::default()
        };
        let child_result = stand_in_result_command(&child, 124, "done");
        child.runtime_handle["standInResultReceipt"] = json!(child_result);
        handler.upsert_local_task(child);
        let waiting = row(&handler);
        assert_eq!(waiting["status"], "running");
        assert_eq!(waiting["waitingForChildren"], true);
        handler.store.update_task("specialist", |link| {
            link.status = "failed".into();
            link.turn_status = Some("failed".into());
            link.runtime_handle["lastErrorCode"] = json!("model_error");
        });
        handler.record_stand_in_completion_outbox("specialist", "failed");
        let failed = row(&handler);
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["retryAllowed"], true);
        assert_eq!(failed["errorCode"], "model_error");
        handler.store = RuntimeWorkStore::new(index_path);
        let restored = handler.local_task_link("specialist").unwrap();
        assert!(restored.runtime_handle["lastErrorCode"].is_null());
        let failed = row(&handler);
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["retryAllowed"], true);
        assert_eq!(failed["errorCode"], "model_error");
        let publication = handler
            .role_completion(&handler.local_task_link("specialist").unwrap(), user)
            .await
            .unwrap();
        assert_eq!(publication["status"], "running");
        assert!(publication["resultId"].is_null());
        handler.store.update_task("specialist", |link| {
            link.status = "done".into();
            link.turn_status = Some("completed".into());
        });
        handler.record_stand_in_completion_outbox("specialist", "done");
        assert_eq!(row(&handler)["status"], "running");
        handler.store.update_task("specialist", |link| {
            link.runtime_handle["standInRoleConsumedResults"] = json!([child_result]);
        });
        assert_eq!(row(&handler)["status"], "done");

        // A manual continuation advances the execution without incrementing the role retry.
        handler.record_stand_in_completion_outbox("child", "done");
        let (cancel, _cancelled) = oneshot::channel();
        let (_stopped, stopped) = oneshot::channel();
        let execution = handler.start_local_task_execution("child".into(), cancel, stopped);
        assert_eq!(row(&handler)["waitingForChildren"], true);
        let mut request =
            runtime_event_request_from_link(&handler.local_task_link("child").unwrap());
        request
            .extra
            .insert("runtime_command_id".into(), json!("continue-child"));
        handler.store.update_task("child", |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        assert!(handler.finish_local_task("child", execution, None, "failed"));
        let continued = handler.local_task_link("child").unwrap();
        assert_eq!(role_attempt(&continued), 0);
        assert_eq!(
            continued.runtime_handle["standInResultReceipt"],
            child_result
        );
        assert_eq!(row(&handler)["waitingForChildren"], true);
        let (status, completed) = stand_in_result_completion(&continued).unwrap();
        let continued_receipt = stand_in_result_command(&continued, completed, status);
        handler.store.update_task("child", |link| {
            link.runtime_handle["standInResultReceipt"] = json!(continued_receipt);
        });
        assert_eq!(row(&handler)["waitingForChildren"], true);
        handler.store.update_task("specialist", |link| {
            link.runtime_handle["standInRoleConsumedResults"]
                .as_array_mut()
                .unwrap()
                .push(json!(continued_receipt));
        });
        assert_eq!(row(&handler)["status"], "done");

        handler.store.update_task("specialist", |link| {
            link.runtime_handle["executionRequest"]["runtime_command_id"] = json!("new-command");
        });
        assert_eq!(row(&handler)["status"], "running");
        assert!(row(&handler)["waitingForChildren"].is_null());
        handler.store.update_task("specialist", |link| {
            link.runtime_handle["executionRequest"]["standInDelegation"]["attempt"] = json!(1);
        });
        let stale_attempt = row(&handler);
        assert_eq!(stale_attempt["status"], "dispatched");
        assert!(stale_attempt["statusSource"].is_null());

        for scope in ["team:00000000-0000-4000-8000-000000000001", "collaboration"] {
            handler.store.update_task(conversation, |link| {
                link.runtime_handle["origin"]["conversationScope"] = json!(scope);
            });
            assert_eq!(
                handler
                    .stand_in_role_branches(&json!({"userId":user,"taskId":conversation}))
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
        }
    }
}
