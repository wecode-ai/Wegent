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
                    && crate::task_runtime::personal_stand_in::supports_role_delegation(origin)
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
        for (id, user, attempt) in tasks {
            match self.stop_role_execution(user, &id, attempt).await {
                Ok(true) => {
                    let status = self
                        .local_task_link(&id)
                        .filter(|link| role_attempt(link) == attempt)
                        .map(|link| link.status)
                        .filter(|status| matches!(status.as_str(), "done" | "failed"));
                    store.record_remote_stand_in_role_result(
                        &id,
                        user,
                        attempt,
                        status.as_deref().unwrap_or("cancelled"),
                        Some("local-stop-confirmed"),
                    )
                }
                Ok(false) => {
                    store.record_remote_stand_in_role_result(&id, user, attempt, "cancelling", None)
                }
                Err(error) => {
                    log_executor_event("Specialist cancellation failed", &[("code", error.code)]);
                    store.record_remote_stand_in_role_result(&id, user, attempt, "cancelling", None)
                }
            }
            .map_err(settings_error)?;
        }
        Ok(())
    }

    async fn stop_role_execution(
        &self,
        user: i64,
        id: &str,
        attempt: u64,
    ) -> Result<bool, AppIpcError> {
        let Some(link) = self.local_task_link(id) else {
            return Ok(true);
        };
        if !owned_role_task(&link, user, &self.device_id)
            || link.runtime_handle["origin"]["type"] != "stand_in_task"
            || !link.runtime_handle["origin"]["roleDelegation"].is_object()
        {
            return Err(denied());
        }
        if role_attempt(&link) > attempt {
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
            .cancel_task_with_stop_policy(
                json!({"taskId":id}),
                Duration::from_secs(10),
                true,
                Some(attempt),
            )
            .await?;
        Ok(result["cleanupPending"] != true && !self.is_busy_local_task(id))
    }

    pub(super) fn check_role_stop_attempt(
        &self,
        id: &str,
        expected: Option<u64>,
    ) -> Result<(), AppIpcError> {
        if let Some(attempt) = expected {
            let link = self
                .store
                .read_loaded_task(id, Clone::clone)
                .ok_or_else(denied)?;
            let owner = link.runtime_handle["origin"]["userId"]
                .as_i64()
                .ok_or_else(denied)?;
            if role_attempt(&link) > attempt
                || attempt
                    .checked_add(1)
                    .is_some_and(|next| self.role_attempt_is_admitted(&link, owner, next))
            {
                return Err(denied());
            }
        }
        Ok(())
    }

    pub(super) async fn accept_remote_role_cancellation(
        &self,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(payload)?;
        self.verify_runtime_user(payload).await?;
        let id = required(payload, "taskId")?;
        let intent = &payload["intent"];
        let attempt = payload["attempt"].as_u64().unwrap_or(0);
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
                json!({"userId":user,"taskId":id,"intent":intent,"attempt":attempt,"cancel":true}),
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
                    || role_attempt(&link) > attempt
            }) {
                return Err(denied());
            }
            store
                .reserve_verified_stand_in_role_request(id, user, root, intent, usize::MAX, attempt)
                .map_err(reservation_error)?;
            store
                .mark_inbound_stand_in_role_cancellation(id, user, attempt)
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
        let stopped = self.stop_role_execution(user, id, attempt).await?;
        let dependents = store
            .has_pending_stand_in_role_descendant_cancellations(user, &self.device_id, root, id)
            .map_err(settings_error)?;
        let stopped = stopped && !dependents;
        let completed = if stopped
            && self.local_task_link(id).is_some_and(|link| {
                role_attempt(&link) == attempt && matches!(link.status.as_str(), "done" | "failed")
            }) {
            self.remote_role_task_status(payload).await?
        } else {
            Value::Null
        };
        Ok(json!({"taskId":id,"stopped":stopped,"completed":completed,"attempt":attempt}))
    }
}
