use serde::Deserialize;

use crate::protocol::StandInTaskPermissions;

use super::super::stand_in_task_permissions;
use super::*;

pub(super) use stand_in_task_permissions::{task_permissions, TASK_PERMISSIONS};

impl RuntimeWorkRpcHandler {
    pub(super) async fn set_stand_in_task_permissions(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(&payload)?;
        self.verify_local_stand_in_owner(user)?;
        let task = super::stand_in_tasks::required(&payload, "taskId")?;
        let permissions = StandInTaskPermissions::deserialize(&payload[TASK_PERMISSIONS])
            .map_err(|_| AppIpcError::new("bad_request", "Invalid Stand-in task permissions"))?;
        let gate = self.task_send_gate(task);
        let _guard = gate.lock().await;
        let owned_permissions = |link: &RuntimeTaskLink| {
            if link.status != "archived"
                && super::stand_in_role_delegation::owned_role_task(link, user, &self.device_id)
            {
                task_permissions(link)
            } else {
                None
            }
        };
        let current = self
            .store
            .read_task(task, owned_permissions)
            .flatten()
            .ok_or_else(super::stand_in_role_delegation::denied)?;
        if current == permissions {
            return Ok(json!({"taskPermissions":current}));
        }

        let mut saved = false;
        self.store
            .try_update_task(task, |link| {
                if owned_permissions(link).is_some() {
                    link.runtime_handle[TASK_PERMISSIONS] = json!(permissions);
                    saved = true;
                }
            })
            .map_err(|error| {
                log_executor_event(
                    "stand-in task permission persistence failed",
                    &[("task_id", task.to_owned()), ("error", error.to_string())],
                );
                AppIpcError::new(
                    "task_permissions_save_failed",
                    "Could not save task permissions",
                )
            })?;
        if !saved {
            return Err(super::stand_in_role_delegation::denied());
        }
        emit_runtime_work_changed(&self.event_tx, &self.device_id, task);
        Ok(json!({"taskPermissions":permissions}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn owner_updates_existing_specialist_permissions_and_keeps_source_work_scoped() {
        let root = tempfile::tempdir().unwrap();
        let index = root.path().join("runtime.json");
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(index.clone());
        let make_task = |task: &str, source_message: Value| {
            let mut link = RuntimeTaskLink::new_pending(task.into(), "".into(), task.into());
            let branch = json!({"root":"branch"});
            link.runtime_handle = json!({
                "origin":{"type":"stand_in_task","initiatedBy":"stand_in","deviceId":"mac", "userId":7,"sourceTaskId":"parent","roleDelegation":branch},
                "executionRequest":{"user_id":7,"standInDelegation":{"userId":7,"sourceTaskId":"parent","roleDelegation":branch,"sourceMessageId":source_message}},
            });
            handler.store.upsert_task(link);
        };
        make_task("specialist", Value::Null);
        make_task("source-worker", json!("external-event"));
        make_task("forked", Value::Null);
        handler.store.update_task("forked", |task| {
            task.parent = Some(json!({"taskId":"specialist"}));
            task.runtime_handle[TASK_PERMISSIONS] = json!({"permissionMode":"full-access"});
        });
        assert_eq!(
            handler.get_task(&json!({"taskId":"specialist"})).unwrap()["task"]["runtimeHandle"]
                [TASK_PERMISSIONS],
            json!({"permissionMode":"read-only"})
        );
        let update = |task: &str, user| {
            json!({"method":"runtime.tasks.permissions.set", "payload":{
                "taskId":task,"userId":user,"taskPermissions":{"permissionMode":"workspace-write"}
            }})
        };
        for (task, user) in [("specialist", 8), ("source-worker", 7), ("forked", 7)] {
            assert_eq!(
                handler
                    .handle_runtime_rpc(update(task, user))
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
        }
        let saved = handler
            .handle_runtime_rpc(update("specialist", 7))
            .await
            .unwrap();
        assert_eq!(
            saved[TASK_PERMISSIONS],
            json!({"permissionMode":"workspace-write"})
        );
        let reloaded = RuntimeWorkStore::new(index).get_task("specialist").unwrap();
        assert_eq!(
            json!(task_permissions(&reloaded).unwrap()),
            saved[TASK_PERMISSIONS]
        );
    }
}
