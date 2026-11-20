use super::stand_in::settings_error;
use super::stand_in_role_delegation::{
    connect_role_relay, denied, owned_role_task, remote_role_intent_matches_link,
    reservation_error, role_attempt, validate_remote_intent,
};
use super::stand_in_tasks::required;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn request_role_cancellation(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(&payload)?;
        let conversation = required(&payload, "taskId")?;
        let root = required(&payload, "root")?;
        let branch = if payload["branchTaskId"].is_null() {
            None
        } else {
            Some(required(&payload, "branchTaskId")?)
        };
        let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let authorized = if let Some(branch) = branch {
            store
                .owns_stand_in_role_branch(user, &self.device_id, conversation, root, branch)
                .map_err(settings_error)?
        } else {
            self.local_task_link(conversation).is_some_and(|link| {
                let origin = &link.runtime_handle["origin"];
                owned_role_task(&link, user, &self.device_id)
                    && origin["type"] == "stand_in_identity"
                    && origin["conversationScope"].is_null()
            })
        };
        if !authorized {
            return Err(denied());
        }
        let requested = store
            .request_stand_in_role_cancellation(user, &self.device_id, conversation, root, branch)
            .map_err(settings_error)?;
        Ok(json!({"accepted":true,"taskIds":requested}))
    }

    pub(super) async fn flush_local_role_cancellations(&self) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let tasks = store
            .pending_local_stand_in_role_cancellations(&self.device_id)
            .map_err(settings_error)?;
        for (id, user) in tasks {
            match self.stop_role_execution(user, &id).await {
                Ok(true) => {
                    let attempt = store
                        .stand_in_role_request(&id, user)
                        .map_err(settings_error)?
                        .and_then(|row| row["attempt"].as_u64())
                        .unwrap_or(0);
                    let status = self
                        .local_task_link(&id)
                        .filter(|link| role_attempt(link) == attempt)
                        .map(|link| link.status);
                    let status = match status.as_deref() {
                        Some(status @ ("done" | "failed")) => status,
                        _ => "cancelled",
                    };
                    store.record_remote_stand_in_role_result(
                        &id,
                        user,
                        status,
                        Some("local-stop-confirmed"),
                    )
                }
                Ok(false) => {
                    store.record_remote_stand_in_role_result(&id, user, "cancelling", None)
                }
                Err(error) => {
                    log_executor_event("Specialist cancellation failed", &[("code", error.code)]);
                    store.record_remote_stand_in_role_result(&id, user, "cancelling", None)
                }
            }
            .map_err(settings_error)?;
        }
        Ok(())
    }

    async fn stop_role_execution(&self, user: i64, id: &str) -> Result<bool, AppIpcError> {
        let Some(link) = self.local_task_link(id) else {
            return Ok(true);
        };
        if !owned_role_task(&link, user, &self.device_id)
            || link.runtime_handle["origin"]["type"] != "stand_in_task"
            || !link.runtime_handle["origin"]["roleDelegation"].is_object()
        {
            return Err(denied());
        }
        if !self.is_busy_local_task(id)
            && matches!(
                link.status.as_str(),
                "done" | "failed" | "cancelled" | "archived"
            )
        {
            return Ok(true);
        }
        let result = self
            .cancel_task_with_stop_policy(json!({"taskId":id}), Duration::from_secs(10), true)
            .await?;
        Ok(result["cleanupPending"] != true && !self.is_busy_local_task(id))
    }

    pub(super) async fn accept_remote_role_cancellation(
        &self,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(payload)?;
        self.verify_runtime_user(payload).await?;
        let id = required(payload, "taskId")?;
        let intent = &payload["intent"];
        let root = validate_remote_intent(intent, id)?;
        let target = intent["targetDevice"].as_str().ok_or_else(denied)?;
        if target != self.device_id && self.cloud_device_id()?.as_str() != target {
            return Err(denied());
        }
        let source = intent["sourceRoute"].as_str().ok_or_else(denied)?;
        let connection = self.require_runtime_connection()?;
        let relay = connect_role_relay(&connection).await?;
        let verification = relay
            .verify_role_task(
                source,
                json!({"userId":user,"taskId":id,"intent":intent,"cancel":true}),
            )
            .await;
        relay.close().await;
        if verification?["verified"] != true {
            return Err(denied());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let conversation = intent["roleDelegation"]["ancestors"][0]
            .as_str()
            .ok_or_else(denied)?;
        let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
        {
            let _guard = gate.lock().await;
            if self.local_task_link(id).is_some_and(|link| {
                !owned_role_task(&link, user, &self.device_id)
                    || !remote_role_intent_matches_link(&link, intent)
            }) {
                return Err(denied());
            }
            store
                .reserve_verified_stand_in_role_request(id, user, root, intent, usize::MAX)
                .map_err(reservation_error)?;
            store
                .mark_inbound_stand_in_role_cancellation(id, user)
                .map_err(settings_error)?;
            store
                .request_stand_in_role_cancellation(
                    user,
                    &self.device_id,
                    conversation,
                    root,
                    Some(id),
                )
                .map_err(settings_error)?;
        }
        let stopped = self.stop_role_execution(user, id).await?;
        let dependents = store
            .has_pending_stand_in_role_descendant_cancellations(user, &self.device_id, root, id)
            .map_err(settings_error)?;
        let stopped = stopped && !dependents;
        let completed = if stopped
            && self
                .local_task_link(id)
                .is_some_and(|link| matches!(link.status.as_str(), "done" | "failed"))
        {
            self.remote_role_task_status(payload).await?
        } else {
            Value::Null
        };
        Ok(json!({"taskId":id,"stopped":stopped,"completed":completed}))
    }
}
