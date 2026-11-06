//! Project source adapters feed the same DSH Router without exposing private conversations.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::project_router_store::context_id;

#[path = "project_router_assessment.rs"]
mod assessment;

#[cfg(test)]
#[path = "project_router_tests.rs"]
mod tests;

fn target(store: &str, project: &str, group: &str, binding: &Value, device: &str) -> Value {
    json!({"projectStore":store,"projectId":project,"groupId":group,"userId":binding["userId"],"deviceId":device,"binding":binding})
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn project_coordination_processing(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let binding = self
            .project_coordination_binding(
                "runtime.project_coordinator.binding.get",
                payload.clone(),
            )
            .await?;
        if binding["binding"]["enabled"] != true
            || binding["binding"]["userId"] != payload["userId"]
            || binding["binding"]["deviceId"] != self.device_id
        {
            return Err(AppIpcError::new(
                "stale_context",
                "Project coordination belongs to another member or device, or is disabled",
            ));
        }
        let target = target(
            payload["projectStore"].as_str().unwrap_or_default(),
            payload["projectId"].as_str().unwrap_or_default(),
            payload["groupId"].as_str().unwrap_or_default(),
            &binding["binding"],
            &self.device_id,
        );
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        self.current_project_router_source(&target).await?;
        store
            .register_project_router_target(&target)
            .map_err(settings_error)?;
        let request = json!({"contextId":context_id(&target)});
        if method == "runtime.project_coordinator.processing.check" {
            self.project_router_rpc(&store, "runtime.coordination.wake", &request)
                .await?;
        }
        self.project_router_rpc(&store, "runtime.coordination.status", &request)
            .await
    }

    pub(super) async fn project_router_contexts(&self, store: &LocalTaskStore) -> Value {
        let mut targets = Vec::new();
        let mut errors = Vec::new();
        match store.list_projects() {
            Ok(projects)=>for project in projects {
                for (group,binding) in project.metadata["projectCoordination"].as_object().into_iter().flatten() {
                    if binding["enabled"]==true && binding["deviceId"]==self.device_id {
                        targets.push(target("local",&project.id,group,binding,&self.device_id));
                    }
                }
            },
            Err(error)=>errors.push(json!({"contextId":"project:local","code":"source_unavailable","message":error.to_string()})),
        }
        if matches!(self.backend_connection_snapshot(), Ok(Some(_))) {
            match self
                .runtime_http(
                    reqwest::Method::GET,
                    "/v1/me/project-coordinator-bindings",
                    None,
                )
                .await
            {
                Ok(value) => {
                    for item in value["contexts"].as_array().into_iter().flatten() {
                        if item["binding"]["deviceId"] == self.device_id {
                            if let (Some(project), Some(group)) =
                                (item["projectId"].as_str(), item["groupId"].as_str())
                            {
                                targets.push(target(
                                    "cloud",
                                    project,
                                    group,
                                    &item["binding"],
                                    &self.device_id,
                                ));
                            }
                        }
                    }
                }
                Err(error) => errors.push(
                    json!({"contextId":"project:cloud","code":error.code,"message":error.message}),
                ),
            }
        }
        let mut contexts = Vec::new();
        for target in targets {
            let id = context_id(&target);
            match store.register_project_router_target(&target) {
                Ok(()) => {
                    let state = store.project_router_state(&target).map_err(settings_error);
                    let processing = state.as_ref().map_or(true, project_processing_due);
                    contexts.push(json!({"id":id,"kind":"project","revision":target["binding"]["generation"],"enabled":true,"needsProcessing":processing}));
                }
                Err(error) => errors.push(
                    json!({"contextId":id,"code":"source_unavailable","message":error.to_string()}),
                ),
            }
        }
        json!({"contexts":contexts,"errors":errors})
    }

    pub(super) async fn current_project_router_context(
        &self,
        target: &Value,
    ) -> Result<Value, AppIpcError> {
        let user = target["userId"].as_i64().ok_or_else(|| {
            AppIpcError::new("permission_denied", "Missing project coordination member")
        })?;
        if target["deviceId"] != self.device_id {
            return Err(AppIpcError::new(
                "permission_denied",
                "Project coordination belongs to another device",
            ));
        }
        let project = target["projectId"].as_str().unwrap_or_default();
        let group = target["groupId"].as_str().unwrap_or_default();
        let storage = target["projectStore"].as_str().unwrap_or_default();
        let result = self
            .project_coordination_binding(
                "runtime.project_coordinator.binding.get",
                json!({"userId":user,"projectId":project,"groupId":group,"projectStore":storage}),
            )
            .await?;
        if result["canEnable"] != true
            || result["binding"]["enabled"] != true
            || result["binding"]["userId"] != user
            || result["binding"]["deviceId"] != self.device_id
            || result["binding"]["generation"] != target["binding"]["generation"]
        {
            return Err(AppIpcError::new(
                "stale_context",
                "Project coordination was stopped, revoked or taken over",
            ));
        }
        let context = self
            .project_coordinator_context(user, storage, project, group)
            .await?;
        if !context["agent"].is_object() {
            return Err(AppIpcError::new(
                "leader_not_ai",
                "Project coordination requires an AI leader",
            ));
        }
        Ok(context)
    }

    pub(super) async fn current_project_router_source(
        &self,
        target: &Value,
    ) -> Result<(Value, Value), AppIpcError> {
        let context = self.current_project_router_context(target).await?;
        let project_data = json!({"id":context["project"]["id"],"name":context["project"]["name"],"description":context["project"]["description"],"version":context["project"]["version"]});
        let members: Vec<Value> = context["group"]["members"]
            .as_array()
            .into_iter()
            .flatten()
            .map(shared_participant)
            .collect();
        let group_data = json!({"id":context["group"]["id"],"name":context["group"]["name"],"description":context["group"]["description"],"instructions":context["group"]["instructions"],"leader":shared_participant(&context["group"]["leader"]),"members":members,"version":context["group"]["version"]});
        Ok((project_data, group_data))
    }

    async fn project_router_source_events(
        &self,
        store: &LocalTaskStore,
        target: &Value,
    ) -> Result<(Value, Vec<Value>), AppIpcError> {
        let (project, group) = self.current_project_router_source(target).await?;
        let project_id = target["projectId"].as_str().unwrap();
        let issues = self.project_router_issues(store, target).await?;
        let mut items = Vec::new();
        let mut events = Vec::new();
        for issue in issues.as_array().ok_or_else(|| {
            AppIpcError::new("source_invalid", "Project source returned no Issue list")
        })? {
            if issue["can_view_detail"] == false {
                continue;
            }
            let id = issue["id"].as_str().ok_or_else(|| {
                AppIpcError::new(
                    "source_invalid",
                    "Project source returned an invalid Issue identity",
                )
            })?;
            let mut item = shared_issue(issue);
            let binding = work_binding(issue);
            item["binding"] = binding.clone();
            events.push(source_event(
                "issue",
                id,
                &issue["version"],
                &issue["updated_at"],
                &item,
                Value::Null,
                binding.clone(),
            )?);
            if binding.is_null() && issue["status"] != "completed" {
                let comments = if target["projectStore"] == "local" {
                    serde_json::to_value(
                        store
                            .list_comments(project_id, id, 0)
                            .map_err(settings_error)?,
                    )
                    .map_err(|error| AppIpcError::new("source_invalid", error.to_string()))?
                } else {
                    let encoded =
                        url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>();
                    self.runtime_http(
                        reqwest::Method::GET,
                        &format!("/v1/loop-items/{encoded}/comments"),
                        None,
                    )
                    .await?
                };
                for comment in comments.as_array().ok_or_else(|| {
                    AppIpcError::new(
                        "source_invalid",
                        "Project source returned no comment history",
                    )
                })? {
                    let comment = shared_comment(comment);
                    events.push(source_event(
                        "comment",
                        id,
                        &comment["id"],
                        &comment["updated_at"],
                        &item,
                        comment.clone(),
                        Value::Null,
                    )?);
                }
            }
            items.push(item);
        }
        Ok((
            json!({"project":project,"group":group,"issues":items}),
            events,
        ))
    }

    async fn project_router_issues(
        &self,
        store: &LocalTaskStore,
        target: &Value,
    ) -> Result<Value, AppIpcError> {
        let project_id = target["projectId"].as_str().unwrap();
        let issues = if target["projectStore"] == "local" {
            serde_json::to_value(store.list_tasks(project_id).map_err(settings_error)?)
                .map_err(|error| AppIpcError::new("source_invalid", error.to_string()))?
        } else {
            self.runtime_http(
                reqwest::Method::GET,
                &format!("/v1/cloud-projects/{project_id}/loop-items"),
                None,
            )
            .await?["items"]
                .clone()
        };
        if !issues.is_array() {
            return Err(AppIpcError::new(
                "source_invalid",
                "Project source returned no Issue list",
            ));
        }
        Ok(issues)
    }

    pub(super) async fn project_router_rpc(
        &self,
        store: &LocalTaskStore,
        method: &str,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let id = payload["contextId"].as_str().ok_or_else(|| {
            AppIpcError::new("bad_request", "Missing project coordination context")
        })?;
        let target = store.project_router_target(id).map_err(settings_error)?;
        let gate = self.task_send_gate(id);
        let _guard = gate.lock().await;
        match method {
            "runtime.coordination.status" => {
                self.current_project_router_source(&target).await?;
                let mut state = store
                    .project_router_state(&target)
                    .map_err(settings_error)?;
                if state["questions"]
                    .as_object()
                    .is_some_and(|questions| !questions.is_empty())
                {
                    let issues = self.project_router_issues(store, &target).await?;
                    state["questions"].as_object_mut().unwrap().retain(|id, _| {
                        issues
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|issue| issue["id"] == *id && issue["can_view_detail"] != false)
                    });
                }
                let error = if state["error"].is_null() {
                    state["batch"]["error"].clone()
                } else {
                    state["error"].clone()
                };
                Ok(
                    json!({"contextId":id,"lastCheckAt":state["lastCheckAt"],"nextCheckAt":state["nextWakeAt"],"running":matches!(state["batch"]["status"].as_str(), Some("pending" | "dispatching")),"questions":state["questions"],"error":error,"lastBatch":state["lastBatch"]["id"]}),
                )
            }
            "runtime.coordination.wake" => {
                self.current_project_router_source(&target).await?;
                store.project_router_wake(&target).map_err(settings_error)?;
                Ok(json!({"accepted":true}))
            }
            "runtime.coordination.snapshot" => {
                if payload["revision"] != target["binding"]["generation"] {
                    return Err(AppIpcError::new(
                        "stale_context",
                        "Project coordination revision changed",
                    ));
                }
                self.advance_project_router_batch(store, &target).await?;
                let state = store
                    .project_router_state(&target)
                    .map_err(settings_error)?;
                if state["batch"].is_object() || !project_processing_due(&state) {
                    return Ok(json!({"skip":true}));
                }
                let (source, events) = self.project_router_source_events(store, &target).await?;
                store
                    .project_router_snapshot(&target, &source, &events)
                    .map_err(settings_error)
            }
            "runtime.coordination.commit" => {
                self.current_project_router_source(&target).await?;
                let result = store
                    .commit_project_router_plan(&target, payload)
                    .map_err(settings_error)?;
                self.advance_project_router_batch(store, &target).await?;
                Ok(result)
            }
            _ => Err(AppIpcError::new(
                "method_not_found",
                "Unknown project coordination operation",
            )),
        }
    }
}

fn project_processing_due(state: &Value) -> bool {
    if state["force"] == true {
        return true;
    }
    if state["batch"].is_object() {
        return state["batch"]["status"] != "failed";
    }
    let now = chrono::Utc::now();
    state["lastCheckAt"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map_or(true, |at| at + chrono::Duration::minutes(5) <= now)
        || state["nextWakeAt"]
            .as_str()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| at <= now)
}

fn shared_issue(issue: &Value) -> Value {
    json!({"id":issue["id"],"title":issue["title"],"description":issue["description"],"status":issue["status"],"priority":issue["priority"],"version":issue["version"],"created_at":issue["created_at"],"updated_at":issue["updated_at"]})
}

fn shared_participant(member: &Value) -> Value {
    json!({"kind":member["kind"],"id":member["id"],"name":member["name"]})
}

fn shared_comment(comment: &Value) -> Value {
    json!({"id":comment.get("message_id").unwrap_or(&comment["id"]),"body":comment.get("body").unwrap_or(&comment["content"]),"author":comment.get("author").unwrap_or(&comment["sender_name"]),"created_at":comment["created_at"],"updated_at":comment["updated_at"]})
}

fn work_binding(issue: &Value) -> Value {
    let assigned = issue["assignee_agent_id"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
        || issue["assignee_user_id"].as_i64().is_some_and(|id| id != 0)
        || issue["assignee_team_id"].as_i64().is_some_and(|id| id != 0)
        || issue["assignee_group_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        || issue["metadata"]["collaboration_group"].is_object()
        || matches!(
            issue["execution_state"].as_str(),
            Some(
                "pending_approval"
                    | "waiting_runtime"
                    | "queued"
                    | "claimed"
                    | "running"
                    | "cancel_requested"
            )
        )
        || issue["status"] == "completed";
    if !assigned {
        return Value::Null;
    }
    json!({"workId":issue["id"],"revision":issue["version"].to_string(),"awaitingApproval":issue["execution_state"]=="pending_approval","awaitingUser":false})
}

fn source_event(
    kind: &str,
    issue: &str,
    version: &Value,
    timestamp: &Value,
    item: &Value,
    comment: Value,
    binding: Value,
) -> Result<Value, AppIpcError> {
    let time = timestamp.as_str().ok_or_else(|| {
        AppIpcError::new("source_invalid", "Project source event has no timestamp")
    })?;
    let parsed = chrono::DateTime::parse_from_rfc3339(time)
        .map(|time| time.with_timezone(&chrono::Utc))
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(time, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|time| time.and_utc())
        })
        .map_err(|_| {
            AppIpcError::new(
                "source_invalid",
                "Project source event has an invalid UTC timestamp",
            )
        })?;
    Ok(
        json!({"id":LocalTaskStore::coordination_event_version(&json!([kind,issue,version,time])),"kind":"connection","sourceKey":"project","issueId":issue,
        "receivedAt":parsed.to_rfc3339(),"processingMode":"silent","binding":binding,"issue":item,"comment":comment}),
    )
}
