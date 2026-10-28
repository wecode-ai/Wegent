//! Application operations shared by the managed control MCP and Runtime clients.
use super::*;
use crate::workbench_control::{self, ControlContext, ControlService};
use futures_util::{stream, StreamExt};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

mod execution;
mod new_conversation;
mod schedules;
#[cfg(test)]
mod tests;

impl ControlService for RuntimeWorkRpcHandler {
    fn call<'a>(
        &'a self,
        context: &'a ControlContext,
        operation: &'a str,
        arguments: Value,
    ) -> futures_util::future::BoxFuture<'a, Result<Value, AppIpcError>> {
        Box::pin(async move { self.control_operation(context, operation, arguments).await })
    }
}

impl RuntimeWorkRpcHandler {
    async fn control_operation(
        &self,
        context: &ControlContext,
        operation: &str,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        workbench_control::validate_arguments(operation, &args)?;
        self.validate_control_context(context)?;
        if operation.contains("automation") {
            return self.control_schedule(context, operation, args).await;
        }
        match operation {
            "get_current_context" => Ok(
                json!({"conversation_id": workbench_control::conversation_id(&self.device_id, &context.task_id),
                "device_id": self.device_id, "scope":"owning_device", "other_tools":["wework_space","wework_notifications"]}),
            ),
            "list_conversations" => self.control_list(context, args).await,
            "search_conversations" => {
                let mut result = self.search_tasks(json!({"query":args["query"],"limit":args.get("limit").cloned().unwrap_or(json!(20))})).await?;
                let items = result["items"].as_array().cloned().unwrap_or_default();
                let total = items.len();
                let links = items
                    .iter()
                    .filter_map(|item| {
                        item["taskId"]
                            .as_str()
                            .and_then(|task| self.store.get_task(task))
                    })
                    .filter(|link| !self.archived_link_is_deleted(link))
                    .collect();
                let (authorized, mut unavailable_reasons) =
                    self.control_authorized_links(context, links).await;
                let authorized: HashSet<_> = authorized
                    .into_iter()
                    .map(|link| link.local_task_id)
                    .collect();
                let mut visible = Vec::new();
                for mut item in items {
                    if !item["taskId"]
                        .as_str()
                        .is_some_and(|task| authorized.contains(task))
                    {
                        continue;
                    }
                    if let Some(address) = item["address"].as_object_mut() {
                        address.remove("runtimeHandle");
                    }
                    visible.push(item);
                }
                let unavailable_count = total.saturating_sub(visible.len());
                let classified: usize = unavailable_reasons.values().sum();
                if unavailable_count > classified {
                    unavailable_reasons.insert(
                        "conversation_unavailable".into(),
                        unavailable_count - classified,
                    );
                }
                result["items"] = json!(visible);
                result["coverage"] = json!({"scope":"owning_device","unavailable_count":unavailable_count,"unavailable_reasons":unavailable_reasons});
                add_conversation_ids(&mut result, &self.device_id);
                Ok(result)
            }
            "get_operation" => self.control_get_operation(context, &args).await,
            "create_conversation" => self.control_create(context, args).await,
            "get_conversation_creation_options" => {
                self.control_creation_options(context, args).await
            }
            "find_conversations_by_change_request" => self.control_find_pr(&args),
            "get_runtime_settings" => self.get_runtime_settings().await,
            "get_runtime_capacity" => self.get_runtime_capacity().await,
            "list_models" => self.runner_catalog().await,
            _ => {
                let link = self.control_target(&args)?;
                self.authorize_control_target(context, &link).await?;
                if restricted_execution(&link)
                    && !operation.starts_with("get_")
                    && operation != "read_conversation"
                {
                    return Err(AppIpcError::new(
                        "permission_denied",
                        "Use the execution's scoped tools and approval flow",
                    ));
                }
                match operation {
                    "get_conversation" => Ok(self.control_task_view(link)),
                    "read_conversation" => self.transcript(json!({"taskId":link.local_task_id,"limit":args["limit"],"beforeCursor":args["before_cursor"],"afterCursor":args["after_cursor"]})).await,
                    "continue_conversation" => self.control_continue(context, link, args).await,
                    "bind_change_request" => self.control_bind_pr(link, &args),
                    _ => self.control_mutation(context, operation, link, args).await,
                }
            }
        }
    }

    fn validate_control_context(&self, context: &ControlContext) -> Result<(), AppIpcError> {
        if context.device_id != self.device_id
            || !ControlContext::from_request(&context.request).is_some_and(|bound| {
                bound.device_id == context.device_id && bound.task_id == context.task_id
            })
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Invalid personal control context",
            ));
        }
        let source = self
            .store
            .get_task(&context.task_id)
            .filter(|link| !self.archived_link_is_deleted(link))
            .ok_or_else(|| {
                AppIpcError::new("not_found", "Calling conversation no longer exists")
            })?;
        if restricted_execution(&source) {
            return Err(AppIpcError::new(
                "permission_denied",
                "Restricted executions cannot control personal conversations",
            ));
        }
        Ok(())
    }

    fn control_target(&self, args: &Value) -> Result<RuntimeTaskLink, AppIpcError> {
        let (device, task) = workbench_control::conversation_address(
            args["conversation_id"].as_str().unwrap_or_default(),
        )?;
        if device != self.device_id {
            return Err(AppIpcError::new(
                "wrong_device",
                "Call the control service on the conversation's owning device",
            ));
        }
        self.store
            .get_task(&task)
            .filter(|link| !self.archived_link_is_deleted(link))
            .ok_or_else(|| AppIpcError::new("not_found", "Conversation not found"))
    }

    async fn authorize_control_target(
        &self,
        context: &ControlContext,
        link: &RuntimeTaskLink,
    ) -> Result<(), AppIpcError> {
        if cloud_bound(link) {
            // Reuse the existing addressed transcript API's current resource permissions.
            self.control_backend(
                context,
                "/runtime-work/transcript",
                json!({
                "deviceId": self.device_id, "taskId": link.local_task_id,
                "workspacePath":link.workspace_path,"limit":1}),
            )
            .await?;
        }
        Ok(())
    }

    async fn control_backend(
        &self,
        context: &ControlContext,
        path: &str,
        body: Value,
    ) -> Result<Value, AppIpcError> {
        self.control_http(context, reqwest::Method::POST, path, Some(body))
            .await
    }

    async fn control_http(
        &self,
        context: &ControlContext,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AppIpcError> {
        let backend = crate::agents::request_backend_url(&context.request).ok_or_else(|| {
            AppIpcError::new(
                "cloud_unavailable",
                "Current user cloud connection is required",
            )
        })?;
        let token = context
            .request
            .auth_token
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AppIpcError::new(
                    "cloud_unavailable",
                    "Current user cloud authorization is required",
                )
            })?;
        let client = crate::agents::backend_url::backend_http_client()
            .map_err(|_| AppIpcError::new("cloud_unavailable", "Backend client unavailable"))?;
        let mut request = client
            .request(
                method,
                crate::agents::runtime_capabilities::api_url(&backend, &format!("/api{path}"))
                    .map_err(|_| {
                        AppIpcError::new("invalid_configuration", "Invalid backend API URL")
                    })?,
            )
            .bearer_auth(token)
            .timeout(Duration::from_secs(60));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| AppIpcError::new("cloud_unavailable", "Wework backend request failed"))?;
        if !response.status().is_success() {
            let code = if response.status().is_client_error() && path == "/runtime-work/create" {
                "backend_request_rejected"
            } else if response.status() == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
                "backend_validation_error"
            } else if matches!(response.status().as_u16(), 401 | 403 | 404) {
                "permission_denied"
            } else if response.status().is_server_error() {
                "backend_unavailable"
            } else {
                "backend_request_rejected"
            };
            log_executor_event(
                "Wework control backend request failed",
                &[
                    ("path", path.to_owned()),
                    ("http_status", response.status().as_u16().to_string()),
                    ("code", code.to_owned()),
                ],
            );
            return Err(AppIpcError::new(
                code,
                format!("Wework request returned {}", response.status()),
            ));
        }
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        response
            .json()
            .await
            .map_err(|_| AppIpcError::new("invalid_response", "Invalid Wework backend response"))
    }

    async fn control_list(
        &self,
        context: &ControlContext,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        let include_archived = args["include_archived"].as_bool().unwrap_or(false);
        // Reconcile native histories before querying the same authoritative Runtime index.
        let mut links = self.collect_links(false).await;
        if include_archived {
            links.extend(self.collect_links(true).await);
        }
        let project_index = CodexGlobalProjectIndex::load();
        let mut links = self.visible_links_for_projects(links, &project_index);
        let mut seen = HashSet::new();
        links.retain(|link| seen.insert(link.local_task_id.clone()));
        links.retain(|link| {
            !self.archived_link_is_deleted(link)
                && args["workspace_path"]
                    .as_str()
                    .map_or(true, |path| link.workspace_path == path)
                && args["project_key"]
                    .as_str()
                    .map_or(true, |key| link.runtime_project_key.as_deref() == Some(key))
        });
        let (mut links, unavailable_reasons) = self.control_authorized_links(context, links).await;
        let unavailable: usize = unavailable_reasons.values().sum();
        links.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.local_task_id.cmp(&b.local_task_id))
        });
        let after = args["after"]
            .as_str()
            .map(workbench_control::conversation_address)
            .transpose()?;
        if let Some((device, task)) = after {
            let position = links
                .iter()
                .position(|link| link.local_task_id == task && device == self.device_id)
                .ok_or_else(|| AppIpcError::new("bad_request", "Invalid conversation cursor"))?;
            links.drain(..=position);
        }
        let limit = args["limit"].as_u64().unwrap_or(20) as usize;
        let has_more = links.len() > limit;
        let items: Vec<Value> = links
            .into_iter()
            .take(limit)
            .map(|link| self.control_task_view(link))
            .collect();
        Ok(
            json!({"items":items,"has_more":has_more,"next_cursor":if has_more {items.last().map(|i| i["conversation_id"].clone())} else {None},
            "coverage":{"device_id":self.device_id,"scope":"owning_device","unavailable_count":unavailable,"unavailable_reasons":unavailable_reasons,"authorized_index_complete":unavailable == 0,"native_discovery":"same_as_runtime_ui"}}),
        )
    }

    async fn control_authorized_links(
        &self,
        context: &ControlContext,
        links: Vec<RuntimeTaskLink>,
    ) -> (Vec<RuntimeTaskLink>, BTreeMap<String, usize>) {
        let total = links.len();
        let (mut authorized, cloud): (Vec<_>, Vec<_>) =
            links.into_iter().partition(|link| !cloud_bound(link));
        let mut checks = stream::iter(cloud.into_iter().map(|link| async move {
            let result = self.authorize_control_target(context, &link).await;
            (link, result)
        }))
        .buffer_unordered(8);
        let mut unavailable_reasons = BTreeMap::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while let Ok(Some((link, result))) = tokio::time::timeout_at(deadline, checks.next()).await
        {
            match result {
                Ok(()) => authorized.push(link),
                Err(error) => *unavailable_reasons.entry(error.code).or_insert(0) += 1,
            }
        }
        let unavailable: usize = unavailable_reasons.values().sum();
        let timed_out = total - authorized.len() - unavailable;
        if timed_out > 0 {
            unavailable_reasons.insert("authorization_timeout".into(), timed_out);
        }
        (authorized, unavailable_reasons)
    }

    fn control_task_view(&self, mut link: RuntimeTaskLink) -> Value {
        let active = self.is_active_local_task(&link.local_task_id);
        let queued = self.queued_local_task_position(&link.local_task_id);
        apply_local_execution_state(&mut link, active, queued);
        let mut selection = link
            .runtime_handle
            .get("modelSelection")
            .or_else(|| link.runtime_handle.get("model_selection"))
            .cloned()
            .unwrap_or(Value::Null);
        redact_execution_profile_secrets(&mut selection);
        let mut task = crate::runtime_work::response::local_task_json(link.clone());
        task.as_object_mut()
            .expect("task projection")
            .remove("runtimeHandle");
        task["conversation_id"] = json!(workbench_control::conversation_id(
            &self.device_id,
            &link.local_task_id
        ));
        task["device_id"] = json!(self.device_id);
        task["model_selection"] = selection;
        task["origin"] = link
            .runtime_handle
            .get("origin")
            .cloned()
            .unwrap_or(Value::Null);
        task["change_requests"] = link
            .runtime_handle
            .get("changeRequests")
            .cloned()
            .unwrap_or(json!([]));
        task["goal"] = link
            .runtime_handle
            .get("goal")
            .cloned()
            .unwrap_or(Value::Null);
        task["project_key"] = json!(link.runtime_project_key);
        task["workspace_roots"] = json!(link.runtime_workspace_roots);
        task
    }

    fn control_find_pr(&self, args: &Value) -> Result<Value, AppIpcError> {
        let url = canonical_pr(args["url"].as_str().unwrap_or_default())?;
        let items: Vec<Value> = self
            .store
            .list_task_summaries(false)
            .into_iter()
            .filter(|link| {
                !cloud_bound(link)
                    && link.runtime_handle["changeRequests"]
                        .as_array()
                        .is_some_and(|urls| urls.contains(&json!(url)))
            })
            .map(|link| self.control_task_view(link))
            .collect();
        Ok(
            json!({"resolution":match items.len(){0=>"missing",1=>"unique",_=>"ambiguous"},"items":items,"url":url}),
        )
    }

    fn control_bind_pr(&self, link: RuntimeTaskLink, args: &Value) -> Result<Value, AppIpcError> {
        if cloud_bound(&link) {
            return Err(AppIpcError::new(
                "project_binding_required",
                "Use the existing project-space PR binding for cloud Issue conversations",
            ));
        }
        let url = canonical_pr(args["url"].as_str().unwrap_or_default())?;
        let updated = self
            .store
            .try_update_task(&link.local_task_id, |task| {
                let mut urls = task.runtime_handle["changeRequests"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                urls.retain(|value| value != &json!(url));
                if args["remove"] != true {
                    urls.push(json!(url));
                }
                task.runtime_handle["changeRequests"] = json!(urls);
            })
            .map_err(|_| {
                AppIpcError::new("control_storage_failed", "Could not persist PR binding")
            })?
            .ok_or_else(|| AppIpcError::new("not_found", "Conversation no longer exists"))?;
        emit_runtime_work_changed(&self.event_tx, &self.device_id, &link.local_task_id);
        Ok(self.control_task_view(updated))
    }

    async fn control_mutation(
        &self,
        context: &ControlContext,
        operation: &str,
        link: RuntimeTaskLink,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        if cloud_bound(&link) && !operation.starts_with("get_") {
            let address = json!({"deviceId":self.device_id,"taskId":link.local_task_id,"workspacePath":link.workspace_path});
            let (path, body) = match operation {
                "rename_conversation" => (
                    "/runtime-work/rename",
                    json!({"address":address,"title":args["title"]}),
                ),
                "archive_conversation" => ("/runtime-work/archive", address),
                "cancel_conversation" => ("/runtime-work/cancel", address),
                "guide_conversation" => (
                    "/runtime-work/guidance",
                    json!({"address":address,"message":args["message"]}),
                ),
                _ => {
                    return Err(AppIpcError::new(
                        "project_operation_required",
                        "Use project-space controls for this project-bound operation",
                    ))
                }
            };
            return self.control_backend(context, path, body).await;
        }
        let payload =
            json!({"taskId":link.local_task_id,"title":args["title"],"message":args["message"]});
        match operation {
            "rename_conversation" => self.rename_task(payload).await,
            "archive_conversation" => self.archive_task(payload).await,
            "cancel_conversation" => self.cancel_task(payload).await,
            "guide_conversation" => self.send_guidance(payload).await,
            "get_conversation_goal" => self.get_task_goal(payload).await,
            "clear_conversation_goal" => self.clear_task_goal(payload).await,
            "get_conversation_supervisor" => self.get_task_supervisor(payload).await,
            "clear_conversation_supervisor" => self.clear_task_supervisor(payload).await,
            _ => Err(AppIpcError::new("not_found", "Unknown Wework operation")),
        }
    }
}

fn restricted_execution(link: &RuntimeTaskLink) -> bool {
    workbench_control::restricted_origin(link.runtime_handle.get("origin"))
}

fn cloud_bound(link: &RuntimeTaskLink) -> bool {
    if link.runtime_handle["origin"]["projectStore"] == "local"
        || link.runtime_handle["origin"]["project_store"] == "local"
    {
        return false;
    }
    link.runtime_handle
        .get("cloudProjectId")
        .or_else(|| link.runtime_handle.get("cloud_project_id"))
        .is_some_and(|v| !v.is_null())
        || link.runtime_handle["origin"]["projectStore"] == "cloud"
        || link.runtime_handle["origin"]["project_store"] == "cloud"
}

fn add_conversation_ids(value: &mut Value, device: &str) {
    match value {
        Value::Object(object) => {
            if let Some(task) = object
                .get("taskId")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                object.insert(
                    "conversation_id".into(),
                    json!(workbench_control::conversation_id(device, &task)),
                );
            }
            for value in object.values_mut() {
                add_conversation_ids(value, device);
            }
        }
        Value::Array(items) => {
            for item in items {
                add_conversation_ids(item, device);
            }
        }
        _ => {}
    }
}

fn canonical_pr(raw: &str) -> Result<String, AppIpcError> {
    let invalid = || {
        AppIpcError::new(
            "bad_request",
            "Expected an HTTPS pull request or merge request URL",
        )
    };
    let mut url = url::Url::parse(raw).map_err(|_| invalid())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(invalid());
    }
    let parts: Vec<_> = url
        .path()
        .trim_end_matches('/')
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    let valid = (parts.len() == 4 && parts[2] == "pull")
        || (parts.len() >= 5
            && parts[parts.len() - 3] == "-"
            && parts[parts.len() - 2] == "merge_requests");
    if !valid
        || parts
            .last()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
            == 0
    {
        return Err(invalid());
    }
    let number = parts
        .last()
        .unwrap()
        .parse::<u64>()
        .map_err(|_| invalid())?;
    let path = if parts.len() == 4 && parts[2] == "pull" {
        format!(
            "{}/{}/pull/{number}",
            parts[0].to_lowercase(),
            parts[1].to_lowercase()
        )
    } else {
        format!("{}/{number}", parts[..parts.len() - 1].join("/"))
    };
    url.set_path(&format!("/{path}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.into())
}
