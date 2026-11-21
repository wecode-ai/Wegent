//! Specialist tasks share the existing stand-in task lifecycle.
use super::stand_in_role_dependencies::with_prerequisite_results;
use super::*;
use crate::task_runtime::{
    mcp::StandInMcpIdentity, personal_stand_in::stand_in_identities, TaskRuntimeError,
};
use sha2::{Digest, Sha256};

const MAX_ROLE_TASKS: usize = 16;

pub(super) fn denied() -> AppIpcError {
    AppIpcError::new(
        "permission_denied",
        "An owned personal assistant task is required",
    )
}

pub(super) fn owned_role_task(link: &RuntimeTaskLink, user: i64, device: &str) -> bool {
    let origin = &link.runtime_handle["origin"];
    !link.ephemeral
        && origin["userId"] == user
        && origin["deviceId"] == device
        && link.runtime_handle["executionRequest"]["user_id"] == user
}

pub(super) fn remote_role_intent_matches_link(link: &RuntimeTaskLink, intent: &Value) -> bool {
    let origin = &link.runtime_handle["origin"];
    origin["type"] == "stand_in_task"
        && origin["standInId"] == intent["roleId"]
        && origin["sourceTaskId"] == intent["sourceTaskId"]
        && origin["sourceDeviceId"] == intent["sourceDevice"]
        && origin["roleDelegation"] == intent["roleDelegation"]
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn request_role_retry(&self, payload: Value) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(&payload)?;
        let conversation = super::stand_in_tasks::required(&payload, "taskId")?;
        let root = super::stand_in_tasks::required(&payload, "root")?;
        let id = super::stand_in_tasks::required(&payload, "branchTaskId")?;
        let attempt = payload["attempt"].as_u64().ok_or_else(denied)?;
        let reconciliation = self.task_send_gate(&format!("stand-in-role-relay:{user}"));
        let _reconciliation = reconciliation.lock().await;
        let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        if !store
            .owns_stand_in_role_branch(user, &self.device_id, conversation, root, id)
            .map_err(super::stand_in::settings_error)?
        {
            return Err(denied());
        }
        let row = store
            .stand_in_role_request(id, user)
            .map_err(super::stand_in::settings_error)?
            .ok_or_else(denied)?;
        if attempt
            .checked_add(1)
            .is_some_and(|next| row["attempt"] == next)
        {
            return Ok(json!({"accepted":true}));
        }
        let native_failed = row["intent"]["sourceRoute"].is_null()
            && self.local_task_link(id).is_some_and(|link| {
                owned_role_task(&link, user, &self.device_id)
                    && link.status == "failed"
                    && !self.is_busy_local_task(id)
                    && role_attempt(&link) == attempt
            });
        let recorded_failure = row["resultStatus"] == "failed" || row["terminalError"].is_string();
        if !(native_failed || recorded_failure)
            || !store
                .retry_stand_in_role_request(id, user, attempt)
                .map_err(super::stand_in::settings_error)?
        {
            return Err(AppIpcError::new(
                "conflict",
                "This attempt is no longer eligible for retry",
            ));
        }
        Ok(json!({"accepted":true}))
    }

    pub(super) async fn role_delegation_operation(
        &self,
        identity: &StandInMcpIdentity,
        name: &str,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let actor = self.local_task_link(&identity.task_id).ok_or_else(denied)?;
        let origin = &actor.runtime_handle["origin"];
        let branch = &origin["roleDelegation"];
        let delegation = &actor.runtime_handle["executionRequest"]["standInDelegation"];
        let identity_conversation =
            origin["type"] == "stand_in_identity" && origin["conversationScope"].is_null();
        if identity.device != self.device_id
            || !owned_role_task(&actor, identity.user, &self.device_id)
            || matches!(actor.status.as_str(), "archived" | "cancelled")
            || identity.work.is_some()
            || identity.role.as_deref() != origin["standInId"].as_str()
            || !(identity_conversation
                || (origin["type"] == "stand_in_task"
                    && branch.is_object()
                    && delegation["roleDelegation"] == *branch
                    && delegation["userId"] == identity.user
                    && delegation["sourceTaskId"] == origin["sourceTaskId"]))
        {
            return Err(denied());
        }
        if name == "list_role_tasks" {
            return self.role_task_status(identity, &delegation_root(&actor)?);
        }
        if identity_conversation {
            let owner = &actor.runtime_handle["executionRequest"]
                [super::stand_in_proposal_continuations::OWNER];
            if owner["cancelled"] != false
                || self
                    .current_stand_in_owner_request(&identity.task_id)
                    .as_ref()
                    != Some(owner)
            {
                return Err(denied());
            }
        }
        let gate = self.task_send_gate(&format!("stand-in-processing:{}", identity.user));
        let _guard = if name == "delegate_role_task" {
            Some(gate.lock().await)
        } else {
            None
        };
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        if name == "delegate_role_task"
            && store
                .stand_in_role_cancellation(&identity.task_id, identity.user)
                .map_err(super::stand_in::settings_error)?
                .is_some()
        {
            return Err(AppIpcError::new(
                "delegation_cancelled",
                "This branch was cancelled",
            ));
        }
        let settings = store
            .personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let roles = role_directory(&settings, &delegation["roleDirectory"]);
        if name == "list_delegate_roles" {
            return Ok(
                json!({"roles":roles.iter().filter(|role| role["id"] != "@primary")
                .map(|role| json!({"id":role["id"],"name":role["name"],"responsibilities":role["prompt"],
                    "enabled":role["enabled"],"deviceId":role["executionDeviceId"],
                    "available":role["enabled"] == true && (role["executionDeviceId"] == self.device_id
                        || self.require_runtime_connection().is_ok())}))
                .collect::<Vec<_>>()}),
            );
        }
        let role_id = super::stand_in_tasks::required(args, "roleId")?;
        let mut role = roles
            .into_iter()
            .find(|role| {
                role["id"] == role_id && role["id"] != "@primary" && role["enabled"] == true
            })
            .ok_or_else(|| AppIpcError::new("role_unavailable", "Role is paused or unavailable"))?;
        let actor_role = identity.role.as_deref().unwrap_or("@primary");
        if !settings["lifecycle"]["status"].is_null()
            || (actor_role != "@primary"
                && !settings["roles"].as_array().is_some_and(|roles| {
                    roles
                        .iter()
                        .any(|role| role["id"] == actor_role && role["enabled"] == true)
                }))
        {
            return Err(denied());
        }
        let target = role["executionDeviceId"].as_str().ok_or_else(denied)?;
        let connection = if target == self.device_id {
            None
        } else {
            let connection = self.require_runtime_connection()?;
            if Self::connected_runtime_user(&connection).await? != identity.user {
                return Err(denied());
            }
            Some(connection)
        };
        let source_route = connection
            .as_ref()
            .map(|_| self.cloud_device_id())
            .transpose()?;
        let metadata = delegation_metadata(&actor, actor_role, role_id)?;
        let root = metadata["root"].as_str().ok_or_else(denied)?;
        let request = super::stand_in_tasks::required(args, "requestId")?;
        let id = role_task_id(root, &identity.task_id, request);
        let mut intent = json!({
            "sourceDevice": self.device_id,
            "sourceTaskId": identity.task_id,
            "sourceRoute": source_route,
            "backendUrl": connection.as_ref().map(|connection| &connection.backend_url),
            "targetDevice": target,
            "requestId": request,
            "roleId": role_id,
            "roleName": role["name"],
            "title": super::stand_in_tasks::required(args, "title")?,
            "message": super::stand_in_tasks::required(args, "message")?,
            "roleDelegation": metadata,
        });
        if let Some(dependencies) = args.get("dependsOn") {
            let dependencies = dependencies
                .as_array()
                .filter(|ids| ids.len() <= MAX_ROLE_TASKS)
                .ok_or_else(|| {
                    AppIpcError::new(
                        "delegation_dependency_invalid",
                        "Expected a list of prerequisite tasks",
                    )
                })?;
            if !dependencies.is_empty() {
                intent["dependsOn"] = json!(dependencies);
            }
        }
        let reservation = store
            .reserve_stand_in_role_request(&id, identity.user, root, &intent, MAX_ROLE_TASKS)
            .map_err(reservation_error)?;
        if reservation["cancelRequested"] == true {
            return Ok(
                json!({"accepted":false,"taskId":id,"deviceId":target,"status":"cancelling"}),
            );
        }
        if source_route.is_some() || intent["dependsOn"].is_array() {
            let status = remote_role_status(&reservation);
            return Ok(
                json!({"accepted":status != "failed","taskId":id,"deviceId":target,
                "status":status,"errorCode":reservation["terminalError"]}),
            );
        }
        if let Some(link) = self.local_task_link(&id) {
            let existing = &link.runtime_handle["origin"];
            if !owned_role_task(&link, identity.user, &self.device_id)
                || existing["standInId"] != role_id
                || existing["sourceTaskId"] != identity.task_id
            {
                return Err(denied());
            }
            store
                .record_stand_in_role_task_address(&id, identity.user, &self.device_id)
                .map_err(super::stand_in::settings_error)?;
            return Ok(json!({"taskId":id,"status":link.status,"alreadyExists":true}));
        }
        role["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":true});
        let result = self
            .start_delegated_task(
                args,
                &id,
                &role,
                json!({
                    "userId": identity.user, "sourceTaskId": identity.task_id,
                    "askBeforeAct": true, "readSources": [], "roleDelegation": metadata,
                    "roleDirectory": delegation["roleDirectory"],
                }),
            )
            .await;
        match &result {
            Ok(result) if result["accepted"] == true => {
                store.record_stand_in_role_task_address(&id, identity.user, &self.device_id)
            }
            outcome => {
                let code = match outcome {
                    Err(error) => &error.code,
                    Ok(result) => result["code"].as_str().unwrap_or("dispatch_rejected"),
                };
                store.record_stand_in_role_route_failure(&id, identity.user, code, false)
            }
        }
        .map_err(super::stand_in::settings_error)?;
        result
    }

    pub(super) async fn flush_remote_stand_in_role_requests(&self) -> Result<(), AppIpcError> {
        let Some(connection) = self.backend_connection_snapshot()? else {
            return Ok(());
        };
        if connection.auth_token.is_empty() || connection.backend_url.is_empty() {
            return Ok(());
        }
        let user = Self::connected_runtime_user(&connection).await?;
        let gate = self.task_send_gate(&format!("stand-in-role-relay:{user}"));
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let pending = store
            .pending_remote_stand_in_role_requests(user, &self.device_id, &connection.backend_url)
            .map_err(super::stand_in::settings_error)?;
        let results = store
            .due_remote_stand_in_role_results(user, &self.device_id, &connection.backend_url)
            .map_err(super::stand_in::settings_error)?;
        if pending.is_empty() && results.is_empty() {
            return Ok(());
        }
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let stopped = !settings["lifecycle"]["status"].is_null();
        let relay = connect_role_relay(&connection).await?;
        for (id, intent) in pending.into_iter().filter(|_| !stopped) {
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
                    .record_stand_in_role_route_failure(&id, user, "source_unavailable", false)
                    .map_err(super::stand_in::settings_error)?;
                continue;
            }
            let row = store
                .stand_in_role_request(&id, user)
                .map_err(super::stand_in::settings_error)?
                .ok_or_else(denied)?;
            let attempt = row["attempt"].as_u64().unwrap_or(0);
            let result = relay
                .start_role_task(
                    target,
                    json!({"userId":user,"taskId":id,"intent":intent,"attempt":attempt}),
                )
                .await;
            match result {
                Ok(result) if result["accepted"] == true && result["taskId"] == id => {
                    store.record_stand_in_role_task_address(&id, user, target)
                }
                Ok(_) => {
                    store.record_stand_in_role_route_failure(&id, user, "invalid_response", true)
                }
                Err(error) => store.record_stand_in_role_route_failure(
                    &id,
                    user,
                    &error.code,
                    retryable_role_dispatch(&error.code),
                ),
            }
            .map_err(super::stand_in::settings_error)?;
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

    pub(super) async fn accept_remote_role_task(
        &self,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(payload)?;
        self.verify_runtime_user(payload).await?;
        let id = super::stand_in_tasks::required(payload, "taskId")?;
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
        let verified = relay.verify_role_task(source_route, payload.clone()).await;
        relay.close().await;
        let verified = verified?;
        if verified["verified"] != true {
            return Err(denied());
        }
        let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        if let Some(link) = self.local_task_link(id) {
            if !owned_role_task(&link, user, &self.device_id)
                || !remote_role_intent_matches_link(&link, intent)
            {
                return Err(denied());
            }
            let reservation = store
                .reserve_verified_stand_in_role_request(id, user, root, intent, MAX_ROLE_TASKS)
                .map_err(reservation_error)?;
            if reservation["cancelRequested"] == true {
                return Err(AppIpcError::new(
                    "delegation_cancelled",
                    "This task was cancelled",
                ));
            }
            if role_attempt(&link) == attempt {
                return Ok(
                    json!({"accepted":true,"taskId":id,"deviceId":target,"status":link.status,"alreadyExists":true}),
                );
            }
            if attempt < role_attempt(&link)
                || link.status != "failed"
                || self.is_busy_local_task(id)
            {
                return Err(AppIpcError::new(
                    "conflict",
                    "The specialist task already has an active attempt",
                ));
            }
        }
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
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
        let reservation = store
            .reserve_verified_stand_in_role_request(id, user, root, intent, MAX_ROLE_TASKS)
            .map_err(reservation_error)?;
        if reservation["cancelRequested"] == true {
            return Err(AppIpcError::new(
                "delegation_cancelled",
                "This task was cancelled",
            ));
        }
        role["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":true});
        let args = with_prerequisite_results(intent, &verified["dependencyEvidence"]);
        let result = self.start_delegated_task(&args, id, &role, json!({
            "userId":user,"sourceTaskId":intent["sourceTaskId"],"sourceDeviceId":intent["sourceDevice"],
            "sourceRoute":intent["sourceRoute"],"askBeforeAct":true,"readSources":[],
            "roleDelegation":intent["roleDelegation"],"roleDirectory":verified["roleDirectory"],"attempt":attempt,
        })).await?;
        if result["accepted"] == true {
            store
                .record_stand_in_role_task_address(id, user, target)
                .map_err(super::stand_in::settings_error)?;
        }
        Ok(
            json!({"accepted":result["accepted"],"taskId":id,"deviceId":target,"status":result["status"]}),
        )
    }

    pub(super) async fn verify_remote_role_task(
        &self,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(payload)?;
        let connection = self.require_runtime_connection()?;
        if Self::connected_runtime_user(&connection).await? != user {
            return Err(denied());
        }
        let id = super::stand_in_tasks::required(payload, "taskId")?;
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
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let verified = (cancelling || settings["lifecycle"]["status"].is_null())
            && store
                .stand_in_role_intent_matches(id, user, intent, cancelling)
                .map_err(super::stand_in::settings_error)?;
        if cancelling {
            return Ok(json!({"verified":verified}));
        }
        if !verified {
            return Ok(json!({"verified":false}));
        }
        let directory = role_directory(
            &settings,
            &actor.runtime_handle["executionRequest"]["standInDelegation"]["roleDirectory"],
        );
        let routes = directory
            .into_iter()
            .filter(|role| role["id"] != "@primary")
            .map(|role| {
                json!({
                    "id":role["id"],"name":role["name"],"prompt":role["prompt"],
                    "enabled":role["enabled"],"executionDeviceId":role["executionDeviceId"],
                })
            })
            .collect::<Vec<_>>();
        let request = store
            .stand_in_role_request(id, user)
            .map_err(super::stand_in::settings_error)?
            .ok_or_else(denied)?;
        if request["attempt"].as_u64().unwrap_or(0) != payload["attempt"].as_u64().unwrap_or(0)
            || (intent["dependsOn"].is_array() && !request["dependencyEvidence"].is_array())
        {
            return Ok(json!({"verified":false}));
        }
        let evidence = &request["dependencyEvidence"];
        Ok(json!({"verified":true,"roleDirectory":routes,"dependencyEvidence":evidence}))
    }

    fn role_task_status(
        &self,
        identity: &StandInMcpIdentity,
        root: &str,
    ) -> Result<Value, AppIpcError> {
        let mut tasks = self.local_task_links(false).into_iter().filter_map(|link| {
            let origin = &link.runtime_handle["origin"];
            if !owned_role_task(&link, identity.user, &self.device_id)
                || origin["roleDelegation"]["root"] != root
                || !origin["roleDelegation"]["ancestors"].as_array().is_some_and(|ancestors|
                    ancestors.iter().any(|id| id == &identity.task_id))
            {
                return None;
            }
            Some(json!({"taskId":link.local_task_id,"parentTaskId":origin["sourceTaskId"],
                "roleId":origin["standInId"],"title":link.title,"status":link.status,
                "interaction":link.interaction_status,"errorCode":link.runtime_handle["lastErrorCode"]}))
        }).collect::<Vec<_>>();
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let additional = store
            .remote_stand_in_role_requests(identity.user, &self.device_id, root)
            .map_err(super::stand_in::settings_error)?;
        tasks.extend(additional.into_iter().filter_map(|(id, metadata)| {
            let intent = &metadata["intent"];
            if !intent["roleDelegation"]["ancestors"]
                .as_array()
                .is_some_and(|path| path.iter().any(|ancestor| ancestor == &identity.task_id))
            {
                return None;
            }
            Some(
                json!({"taskId":id,"parentTaskId":intent["sourceTaskId"],"roleId":intent["roleId"],
                "title":intent["title"],"deviceId":intent["targetDevice"],"status":remote_role_status(&metadata),
                "errorCode":metadata["lastError"]}),
            )
        }));
        Ok(json!({"tasks":tasks}))
    }

    pub(super) fn stand_in_role_branches(&self, payload: &Value) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(payload)?;
        let task = super::stand_in_tasks::required(payload, "taskId")?;
        let Some(link) = self.local_task_link(task) else {
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
            .map_err(super::stand_in::settings_error)?;
        let requests = store
            .role_requests_for_conversation(user, &self.device_id, task)
            .map_err(super::stand_in::settings_error)?;
        let items = requests.into_iter().map(|(task_id, created_at, metadata)| {
            let intent = &metadata["intent"];
            json!({"taskId":task_id,"createdAt":created_at,"root":metadata["root"],
                "title":intent["title"],"roleName":intent["roleName"],"deviceId":intent["targetDevice"],
                "parentTaskId":intent["sourceTaskId"],"ancestors":intent["roleDelegation"]["ancestors"],
                "prerequisiteTaskIds":intent["dependsOn"],
                "taskAddress":metadata["taskAddress"],"status":remote_role_status(&metadata),
                "attempt":metadata["attempt"].as_u64().unwrap_or(0),
                "retryAllowed":metadata["cancelRequested"] != true && (intent["sourceRoute"].is_null()
                    || metadata["resultStatus"] == "failed" || metadata["terminalError"].is_string()),
                "cancelGroup":metadata["cancelGroup"] == true,
                "errorCode":metadata["terminalError"]})
        }).collect::<Vec<_>>();
        Ok(json!({"items":items}))
    }
}

pub(super) fn role_attempt(link: &RuntimeTaskLink) -> u64 {
    link.runtime_handle["executionRequest"]["standInDelegation"]["attempt"]
        .as_u64()
        .unwrap_or(0)
}

fn remote_role_status(metadata: &Value) -> &str {
    if metadata["cancelRequested"] == true && metadata["resultReceipt"].is_null() {
        if metadata["resultStatus"] == "cancelling_waiting_for_device" {
            "cancelling_waiting_for_device"
        } else {
            "cancelling"
        }
    } else if let Some(status) = metadata["resultStatus"].as_str() {
        status
    } else if metadata["terminalError"].is_string() {
        "failed"
    } else if metadata["taskAddress"].is_object() {
        "dispatched"
    } else if metadata["attempt"].as_u64().unwrap_or(0) > 0 {
        "retrying"
    } else if metadata["intent"]["dependsOn"].is_array()
        && !metadata["dependencyEvidence"].is_array()
    {
        if metadata["dependencyStatus"] == "blocked_by_dependency" {
            "blocked_by_dependency"
        } else {
            "waiting_for_dependencies"
        }
    } else if metadata["intent"]["sourceRoute"].is_null()
        && metadata["dependencyEvidence"].is_array()
    {
        "running"
    } else {
        "waiting_for_device"
    }
}

fn role_directory(settings: &Value, verified_routes: &Value) -> Vec<Value> {
    let mut roles = stand_in_identities(settings);
    for route in [&settings["delegationRoutes"], verified_routes]
        .into_iter()
        .flat_map(|routes| routes.as_array().into_iter().flatten())
    {
        // A peer's directory can locate another device. This device always uses
        // its current saved role configuration for local execution.
        if route["executionDeviceId"].is_string()
            && route["executionDeviceId"] != settings["executionDeviceId"]
            && route["id"]
                .as_str()
                .is_some_and(|id| id != "@primary" && !roles.iter().any(|role| role["id"] == id))
        {
            roles.push(route.clone());
        }
    }
    roles
}

fn role_task_id(root: &str, actor: &str, request: &str) -> String {
    format!(
        "stand-in-role-task-{:x}",
        Sha256::digest(json!([root, actor, request]).to_string())
    )
}

pub(super) async fn connect_role_relay(
    connection: &ConnectionConfig,
) -> Result<crate::runtime_work::reader::RuntimeReader, AppIpcError> {
    let request = ExecutionRequest {
        backend_url: Some(connection.backend_url.clone()),
        auth_token: Some(connection.auth_token.clone()),
        ..Default::default()
    };
    crate::runtime_work::reader::RuntimeReader::connect(
        &request,
        connection,
        crate::workbench_control::read_budget::ReadBudget::new(Duration::from_secs(45)),
    )
    .await
}

pub(super) fn reservation_error(error: TaskRuntimeError) -> AppIpcError {
    match error {
        TaskRuntimeError::StandInRoleRequestLimit => {
            AppIpcError::new("delegation_limit", error.to_string())
        }
        TaskRuntimeError::StandInRoleRequestCancelled => {
            AppIpcError::new("delegation_cancelled", error.to_string())
        }
        TaskRuntimeError::StandInRoleDependencyInvalid => {
            AppIpcError::new("delegation_dependency_invalid", error.to_string())
        }
        TaskRuntimeError::VersionConflict => AppIpcError::new(
            "conflict",
            "The request ID is already bound to a different specialist task",
        ),
        error => super::stand_in::settings_error(error),
    }
}

pub(super) fn retryable_role_dispatch(code: &str) -> bool {
    matches!(
        code,
        "device_offline"
            | "device_disconnected"
            | "device_timeout"
            | "runtime_rpc_timeout"
            | "runtime_route_missing"
            | "cloud_unavailable"
            | "device_query_failed"
            | "query_timeout"
            | "invalid_response"
    )
}

pub(super) fn validate_remote_intent<'a>(
    intent: &'a Value,
    id: &str,
) -> Result<&'a str, AppIpcError> {
    use super::stand_in_tasks::required;
    for key in [
        "title",
        "message",
        "sourceDevice",
        "sourceRoute",
        "targetDevice",
    ] {
        required(intent, key)?;
    }
    let role = required(intent, "roleId")?;
    let source = required(intent, "sourceTaskId")?;
    let request = required(intent, "requestId")?;
    let branch = &intent["roleDelegation"];
    let root = required(branch, "root")?;
    let ancestors = branch["ancestors"].as_array().ok_or_else(denied)?;
    let roles = branch["roles"].as_array().ok_or_else(denied)?;
    if id != role_task_id(root, source, request)
        || root.len() != 64
        || !root.bytes().all(|byte| byte.is_ascii_hexdigit())
        || ancestors.last().and_then(Value::as_str) != Some(source)
        || roles.last().and_then(Value::as_str) != Some(role)
        || roles.len() != ancestors.len() + 1
        || ancestors.len() > MAX_ROLE_TASKS
        || !ancestors.iter().all(Value::is_string)
        || roles
            .iter()
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>()
            .len()
            != roles.len()
    {
        return Err(denied());
    }
    Ok(root)
}

fn delegation_root(actor: &RuntimeTaskLink) -> Result<String, AppIpcError> {
    let handle = &actor.runtime_handle;
    let branch = &handle["origin"]["roleDelegation"];
    let request = &handle["executionRequest"];
    if let Some(root) = branch["root"]
        .as_str()
        .or_else(|| request["standInRoleResultRoot"].as_str())
    {
        return Ok(root.to_owned());
    }
    let command = request["runtime_command_id"].as_str().ok_or_else(denied)?;
    Ok(format!(
        "{:x}",
        Sha256::digest(json!([actor.local_task_id, command]).to_string())
    ))
}

fn delegation_metadata(
    actor: &RuntimeTaskLink,
    actor_role: &str,
    role: &str,
) -> Result<Value, AppIpcError> {
    let branch = &actor.runtime_handle["origin"]["roleDelegation"];
    let root = delegation_root(actor)?;
    let mut roles = branch["roles"].as_array().cloned().unwrap_or_default();
    if roles.is_empty() {
        roles.push(json!(actor_role));
    }
    if roles.iter().any(|seen| seen == role) {
        return Err(AppIpcError::new(
            "delegation_cycle",
            "This role is already in the current delegation branch",
        ));
    }
    roles.push(json!(role));
    let mut ancestors = branch["ancestors"].as_array().cloned().unwrap_or_default();
    ancestors.push(json!(actor.local_task_id));
    let root_device = branch
        .get("rootDevice")
        .unwrap_or(&actor.runtime_handle["origin"]["deviceId"]);
    Ok(json!({"root":root,"roles":roles,"ancestors":ancestors,"rootDevice":root_device}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specialist_directory_adds_verified_routes_without_restoring_revoked_local_roles() {
        let settings = json!({"executionDeviceId":"target","roles":[
            {"id":"existing","enabled":false}
        ]});
        let routes = json!([
            {"id":"@primary","executionDeviceId":"source","enabled":true},
            {"id":"existing","executionDeviceId":"source","enabled":true},
            {"id":"removed","executionDeviceId":"target","enabled":true},
            {"id":"database","executionDeviceId":"source","enabled":true},
        ]);
        let directory = role_directory(&settings, &routes);
        assert_eq!(directory.len(), 2);
        assert_eq!(directory[0]["id"], "existing");
        assert_eq!(directory[0]["enabled"], false);
        assert_eq!(directory[1]["id"], "database");
        assert_eq!(directory[1]["executionDeviceId"], "source");
    }

    #[test]
    fn specialist_split_preserves_root_and_rejects_recursive_role_cycles() {
        let root = RuntimeTaskLink {
            local_task_id: "original".into(),
            runtime_handle: json!({"executionRequest":{"runtime_command_id":"owner-turn"}}),
            ..Default::default()
        };
        let engineering = delegation_metadata(&root, "@primary", "engineering").unwrap();
        let writing = delegation_metadata(&root, "@primary", "writing").unwrap();
        assert_eq!(engineering["root"], writing["root"]);
        let worker = RuntimeTaskLink {
            local_task_id: "engineering-task".into(),
            runtime_handle: json!({"origin":{"roleDelegation":engineering}}),
            ..Default::default()
        };
        let nested = delegation_metadata(&worker, "engineering", "database").unwrap();
        assert_eq!(nested["root"], writing["root"]);
        assert_eq!(nested["ancestors"], json!(["original", "engineering-task"]));
        assert_eq!(
            delegation_metadata(&worker, "engineering", "engineering")
                .unwrap_err()
                .code,
            "delegation_cycle"
        );
    }
}
