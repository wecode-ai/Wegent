//! Application operations shared by the managed control MCP and Runtime clients.
use super::dispatch::boxed_rpc;
use super::*;
use crate::workbench_control::{self, ControlContext, ControlService};
use futures_util::{stream, StreamExt};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

mod execution;
mod materialization;
mod new_conversation;
mod query;
mod remote_continuation;
mod schedules;
use remote_continuation::validate_continuation_target;
#[cfg(test)]
mod app_tests;
#[cfg(all(test, unix))]
mod local_execution_tests;
#[cfg(test)]
mod tests;

impl ControlService for RuntimeWorkRpcHandler {
    fn call<'a>(
        &'a self,
        context: &'a ControlContext,
        operation: &'a str,
        arguments: Value,
    ) -> futures_util::future::BoxFuture<'a, Result<Value, AppIpcError>> {
        self.control_operation(context, operation, arguments)
    }
}

impl RuntimeWorkRpcHandler {
    fn control_operation<'a>(
        &'a self,
        context: &'a ControlContext,
        operation: &'a str,
        args: Value,
    ) -> futures_util::future::BoxFuture<'a, Result<Value, AppIpcError>> {
        if let Err(error) = workbench_control::validate_arguments(operation, &args)
            .and_then(|_| self.validate_control_context(context))
        {
            return boxed_rpc(move || async move { Err(error) });
        }
        if operation.contains("automation") {
            return boxed_rpc(move || async move {
                self.control_schedule(context, operation, args).await
            });
        }
        // Use the Runtime dispatcher so only the selected branch occupies a worker's stack.
        match operation {
            "present_interaction" => {
                boxed_rpc(move || async move { workbench_control::apps::present(args) })
            }
            "get_current_context" => boxed_rpc(move || async move {
                Ok(
                    json!({"conversation_id": workbench_control::conversation_id(&self.device_id, &context.task_id),
                "device_id": self.device_id, "scope":"all", "continuation_scope":"owned_devices", "other_tools":["wework_space","wework_notifications"]}),
                )
            }),
            "list_conversations" | "search_conversations" => {
                boxed_rpc(move || async move { self.control_query(context, operation, args).await })
            }
            "get_conversation" | "read_conversation"
                if args["conversation_id"].as_str().is_some_and(|id| {
                    id.starts_with("cloudconv_")
                        || workbench_control::conversation_address(id)
                            .is_ok_and(|(device, _)| device != self.device_id)
                }) =>
            {
                boxed_rpc(move || async move {
                    self.control_remote_read(context, operation, args).await
                })
            }
            "get_conversation" | "read_conversation" => boxed_rpc(move || async move {
                workbench_control::read_budget::ReadBudget::default()
                    .read(
                        &self.device_id,
                        operation,
                        self.control_local_query(Some(context), operation, args),
                    )
                    .await
            }),
            "continue_conversation"
                if args["conversation_id"].as_str().is_some_and(|id| {
                    workbench_control::conversation_address(id)
                        .is_ok_and(|(device, _)| device != self.device_id)
                }) =>
            {
                boxed_rpc(move || async move { self.control_continue_remote(context, args).await })
            }
            "get_operation" => {
                boxed_rpc(move || async move { self.control_get_operation(context, &args).await })
            }
            "create_conversation" => {
                boxed_rpc(move || async move { self.control_create(context, args).await })
            }
            "get_conversation_creation_options" => {
                boxed_rpc(move || async move { self.control_creation_options(context, args).await })
            }
            "find_conversations_by_change_request" => {
                boxed_rpc(move || async move { self.control_find_pr(&args) })
            }
            "get_runtime_settings" => {
                boxed_rpc(move || async move { self.get_runtime_settings().await })
            }
            "get_runtime_capacity" => {
                boxed_rpc(move || async move { self.get_runtime_capacity().await })
            }
            "list_models" => boxed_rpc(move || async move { self.runner_catalog().await }),
            _ => boxed_rpc(move || async move {
                let link = self.control_target(&args)?;
                if operation == "continue_conversation" {
                    validate_continuation_target(&link, &self.device_id)?;
                    self.authorize_control_target(context, &link).await?;
                    return self.control_continue(context, link, args).await;
                }
                self.authorize_control_target(context, &link).await?;
                if restricted_execution(&link)
                    && !operation.starts_with("get_")
                    && operation != "read_conversation"
                {
                    return Err(control_target_restriction(
                        &self.device_id,
                        &link.local_task_id,
                        link.runtime_handle.get("origin"),
                    ));
                }
                match operation {
                    "bind_change_request" => self.control_bind_pr(link, &args),
                    _ => self.control_mutation(context, operation, link, args).await,
                }
            }),
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
        if workbench_control::restricted_request(&runtime_event_request_from_link(&source)) {
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
            // The desktop resolves current owner/binding/project permissions through
            // cloud-context before reading locally. A transcript RPC to this device
            // would incorrectly require enabling remote control for local data.
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("device_id", &self.device_id)
                .append_pair("task_id", &link.local_task_id)
                .finish();
            self.control_http(
                context,
                reqwest::Method::GET,
                &format!("/v1/runtime-tasks/cloud-context?{query}"),
                None,
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
        if let Some(body) = &body {
            request = request.json(body);
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
        let mut task = crate::runtime_work::response::local_task_json(link.clone());
        task["project_key"] = json!(link.runtime_project_key);
        task["workspace_roots"] = json!(link.runtime_workspace_roots);
        query::remote::native_view(&self.device_id, task).expect("valid local task projection")
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
                "unarchive_conversation" => {
                    ("/runtime-work/archived-conversations/unarchive", address)
                }
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
            "unarchive_conversation" => self.unarchive_task(payload).await,
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

fn control_target_restriction(device: &str, task: &str, origin: Option<&Value>) -> AppIpcError {
    let marker = workbench_control::origin_restriction(origin).unwrap_or("unknown");
    // Log a bounded classification, never arbitrary origin data or dispatch IDs.
    let value_class = match origin.and_then(|value| value.get(marker)) {
        Some(Value::String(value)) => match value.as_str() {
            "stand_in_identity" => "stand_in_identity",
            "connection_work" => "connection_work",
            "dingtalk_work" => "dingtalk_work",
            "manager" => "manager",
            "executor" => "executor",
            value if value.trim().is_empty() => "empty_string",
            _ => "nonempty_string",
        },
        Some(_) => "non_string",
        None => "missing",
    };
    log_executor_event(
        "Wework control target restricted",
        &[
            ("device_id", device.to_owned()),
            ("task_id", task.to_owned()),
            ("origin_marker", marker.to_owned()),
            ("marker_value_class", value_class.to_owned()),
        ],
    );
    AppIpcError::new(
        "permission_denied",
        format!(
            "Target conversation is restricted by origin.{marker} ({value_class}). \
             Use its scoped continuation flow; this is not a sign-in or approval request."
        ),
    )
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
        || link.runtime_handle["origin"]
            .get("cloudProjectId")
            .or_else(|| link.runtime_handle["origin"].get("cloud_project_id"))
            .is_some_and(|v| !v.is_null())
        || link.runtime_handle["origin"]["projectStore"] == "cloud"
        || link.runtime_handle["origin"]["project_store"] == "cloud"
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
