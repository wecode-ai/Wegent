//! Route specialist attempts between their two owning Executors.
use super::super::runtime_owner::runtime_user;
use super::super::stand_in::settings_error;
use super::super::stand_in_role_dependencies::with_prerequisite_results;
use super::super::stand_in_role_results::matches_role_reply;
use super::super::stand_in_tasks::required;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) async fn flush_remote_stand_in_role_requests(
        &self,
    ) -> Result<(), AppIpcError> {
        let Some(connection) = self.backend_connection_snapshot()? else {
            return Ok(());
        };
        if connection.auth_token.is_empty() || connection.backend_url.is_empty() {
            return Ok(());
        }
        let user = Self::connected_runtime_user(&connection).await?;
        let gate = self.task_send_gate(&format!("stand-in-role-relay:{user}"));
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let pending = store
            .pending_remote_stand_in_role_requests(user, &self.device_id, &connection.backend_url)
            .map_err(settings_error)?;
        let results = store
            .due_remote_stand_in_role_results(user, &self.device_id, &connection.backend_url)
            .map_err(settings_error)?;
        if pending.is_empty() && results.is_empty() {
            return Ok(());
        }
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        let stopped = !settings["lifecycle"]["status"].is_null();
        let relay = connect_role_relay(&connection).await?;
        for (id, row) in pending.into_iter().filter(|_| !stopped) {
            let intent = &row["intent"];
            let attempt = row["attempt"].as_u64().unwrap_or(0);
            let (Some(source), Some(target)) = (
                intent["sourceTaskId"].as_str(),
                intent["targetDevice"].as_str(),
            ) else {
                continue;
            };
            if !self.local_task_link(source).is_some_and(|link| {
                owned_role_task(&link, user, &self.device_id)
                    && !matches!(link.status.as_str(), "archived" | "cancelled")
            }) {
                store
                    .record_stand_in_role_route_failure(
                        &id,
                        user,
                        attempt,
                        "source_unavailable",
                        false,
                    )
                    .map_err(settings_error)?;
                continue;
            }
            let result = relay
                .start_role_task(
                    target,
                    json!({"userId":user,"taskId":id,"intent":intent,"attempt":attempt}),
                )
                .await;
            match result {
                Ok(result)
                    if result["accepted"] == true
                        && matches_role_reply(&result, &id, intent, attempt) =>
                {
                    store.record_stand_in_role_task_address(&id, user, attempt, target)
                }
                Ok(_) => store.record_stand_in_role_route_failure(
                    &id,
                    user,
                    attempt,
                    "invalid_response",
                    true,
                ),
                Err(error) => store.record_stand_in_role_route_failure(
                    &id,
                    user,
                    attempt,
                    &error.code,
                    retryable_role_dispatch(&error.code),
                ),
            }
            .map_err(settings_error)?;
        }
        for (id, metadata) in results
            .into_iter()
            .filter(|(_, row)| !stopped || row["cancelRequested"] == true)
        {
            if let Err(error) = self
                .reconcile_remote_role_result(&store, &relay, user, &id, &metadata)
                .await
            {
                log_executor_event(
                    "Specialist result reconciliation failed",
                    &[("code", error.code)],
                );
            }
        }
        relay.close().await;
        Ok(())
    }

    pub(in crate::runtime_work::handler) async fn accept_remote_role_task(
        &self,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let user = runtime_user(payload)?;
        self.verify_runtime_user(payload).await?;
        let id = required(payload, "taskId")?;
        let intent = &payload["intent"];
        let attempt = payload["attempt"].as_u64().unwrap_or(0);
        let root = validate_remote_intent(intent, id)?;
        let target = intent["targetDevice"].as_str().ok_or_else(denied)?;
        if target != self.device_id && self.cloud_device_id()?.as_str() != target {
            return Err(denied());
        }
        let source_route = intent["sourceRoute"].as_str().ok_or_else(denied)?;
        let connection = self.require_runtime_connection()?;
        let relay = connect_role_relay(&connection).await?;
        let mut verification = json!({"userId":user,"taskId":id,"intent":intent,"attempt":attempt});
        if intent["followupRequestId"].is_string() {
            verification["resumeExistingTask"] = json!(true);
        }
        let verified = relay.verify_role_task(source_route, verification).await;
        relay.close().await;
        let verified = verified?;
        if verified["verified"] != true {
            return Err(denied());
        }
        let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let retrying = verified["retrying"].as_bool().unwrap_or(attempt > 0);
        let link = self.local_task_link(id);
        let reserve = || -> Result<(), AppIpcError> {
            let reservation = store
                .reserve_verified_stand_in_role_request(
                    id,
                    user,
                    root,
                    intent,
                    MAX_ROLE_TASKS,
                    attempt,
                )
                .map_err(reservation_error)?;
            if reservation["cancelRequested"] == true {
                return Err(AppIpcError::new(
                    "delegation_cancelled",
                    "This task was cancelled",
                ));
            }
            Ok(())
        };
        if let Some(link) = link.as_ref() {
            if !owned_role_task(link, user, &self.device_id)
                || !remote_role_intent_matches_link(link, intent)
            {
                return Err(denied());
            }
            if self.role_attempt_is_admitted(link, user, attempt) {
                reserve()?;
                store
                    .record_stand_in_role_task_address(id, user, attempt, target)
                    .map_err(settings_error)?;
                return Ok(
                    json!({"accepted":true,"taskId":id,"deviceId":target,"status":link.status,"attempt":attempt,"alreadyExists":true}),
                );
            }
        }
        self.validate_role_attempt_start(link.as_ref(), intent, user, attempt, retrying)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        let mut role = stand_in_identities(&settings)
            .into_iter()
            .find(|role| {
                role["id"] == intent["roleId"]
                    && role["id"] != "@primary"
                    && role["enabled"] == true
                    && role["executionDeviceId"] == self.device_id
            })
            .filter(|_| settings["lifecycle"]["status"].is_null())
            .ok_or_else(|| {
                AppIpcError::new(
                    "role_unavailable",
                    "Role is no longer enabled on this execution device",
                )
            })?;
        reserve()?;
        role["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":true});
        let args = with_prerequisite_results(intent, &verified["dependencyEvidence"]);
        let mut delegation = json!({
            "userId":user,"sourceTaskId":intent["sourceTaskId"],"sourceDeviceId":intent["sourceDevice"],
            "sourceRoute":intent["sourceRoute"],"askBeforeAct":true,"readSources":[],
            "roleDelegation":intent["roleDelegation"],"roleDirectory":verified["roleDirectory"],"attempt":attempt,
        });
        if let Some(request_id) = intent["followupRequestId"].as_str() {
            delegation["followupRequestId"] = json!(request_id);
            delegation["retrying"] = json!(retrying);
        }
        let result = self
            .start_delegated_task(
                &args,
                id,
                &role,
                delegation,
                Some(StandInTaskPermissions::from_role(&role)),
                None,
            )
            .await?;
        if result["accepted"] == true {
            store
                .record_stand_in_role_task_address(id, user, attempt, target)
                .map_err(settings_error)?;
        }
        Ok(
            json!({"accepted":result["accepted"],"taskId":id,"deviceId":target,"status":result["status"],"attempt":attempt}),
        )
    }

    pub(in crate::runtime_work::handler) async fn verify_remote_role_task(
        &self,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let user = runtime_user(payload)?;
        let connection = self.require_runtime_connection()?;
        if Self::connected_runtime_user(&connection).await? != user {
            return Err(denied());
        }
        let id = required(payload, "taskId")?;
        let intent = &payload["intent"];
        validate_remote_intent(intent, id)?;
        let source = intent["sourceTaskId"].as_str().ok_or_else(denied)?;
        let cancelling = payload["cancel"] == true;
        let actor = self
            .local_task_link(source)
            .filter(|link| {
                owned_role_task(link, user, &self.device_id)
                    && (cancelling || !matches!(link.status.as_str(), "archived" | "cancelled"))
            })
            .ok_or_else(denied)?;
        if intent["sourceDevice"] != self.device_id
            || intent["backendUrl"] != connection.backend_url
        {
            return Err(denied());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        let Some(request) = store
            .matching_stand_in_role_request(id, user, intent, Some(cancelling))
            .map_err(settings_error)?
        else {
            return Ok(json!({"verified":false}));
        };
        let attempt = request["attempt"].as_u64().unwrap_or(0);
        if attempt != payload["attempt"].as_u64().unwrap_or(0) {
            return Ok(json!({"verified":false}));
        }
        if cancelling {
            return Ok(json!({"verified":true}));
        }
        if !settings["lifecycle"]["status"].is_null()
            || (intent["dependsOn"].is_array() && !request["dependencyEvidence"].is_array())
            || (intent["followupRequestId"].is_string() && payload["resumeExistingTask"] != true)
        {
            return Ok(json!({"verified":false}));
        }
        let directory = actor_role_directory(
            &actor,
            &settings,
            &actor.runtime_handle["executionRequest"]["standInDelegation"]["roleDirectory"],
        );
        if (intent["followupRequestId"].is_string()
            || team_scope_id(&actor.runtime_handle["origin"]["conversationScope"]).is_some())
            && !directory.iter().any(|role| {
                role["id"] == intent["roleId"]
                    && role["executionDeviceId"] == intent["targetDevice"]
                    && role["enabled"] == true
            })
        {
            return Ok(json!({"verified":false}));
        }
        let routes = directory
            .into_iter()
            .filter(|_| intent["roleDelegation"]["team"] != true)
            .filter(|role| role["id"] != "@primary")
            .map(|role| {
                json!({
                    "id":role["id"],"name":role["name"],"prompt":role["prompt"],
                    "enabled":role["enabled"],"executionDeviceId":role["executionDeviceId"],
                })
            })
            .collect::<Vec<_>>();
        let evidence = &request["dependencyEvidence"];
        let retrying = role_request_is_retry(&request);
        Ok(
            json!({"verified":true,"roleDirectory":routes,"dependencyEvidence":evidence,"retrying":retrying}),
        )
    }
}
