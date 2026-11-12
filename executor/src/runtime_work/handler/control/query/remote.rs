//! Federation uses the exact device read operations used by the desktop.
use super::*;
use crate::runtime_work::reader::{invalid_response, RuntimeReader};

impl RuntimeWorkRpcHandler {
    pub(super) async fn control_other_sources(
        &self,
        context: &ControlContext,
        operation: &str,
        args: Value,
        budget: ReadBudget,
    ) -> Vec<Value> {
        let cloud = async {
            if args["device_id"].is_string() {
                return None;
            }
            Some(source_result(
                "cloud_history",
                "cloud_history",
                self.control_cloud_query(context, operation, &args, budget)
                    .await,
            ))
        };
        let devices = async {
            let listing = budget
                .read(
                    "devices",
                    "devices.list",
                    self.control_http(context, reqwest::Method::GET, "/devices", None),
                )
                .await;
            let devices = match listing
                .and_then(|v| v["items"].as_array().cloned().ok_or_else(invalid_response))
            {
                Ok(devices) => devices,
                Err(error) => return vec![source_result("devices", "devices", Err(error))],
            };
            let mut sources = Vec::new();
            let mut online = Vec::new();
            let mut seen = HashSet::new();
            for device in devices {
                if !device["bind_shell"]
                    .as_str()
                    .unwrap_or("claudecode")
                    .eq_ignore_ascii_case("claudecode")
                {
                    continue;
                }
                let Some(id) = device["device_id"].as_str().filter(|id| !id.is_empty()) else {
                    sources.push(source_result("devices", "devices", Err(invalid_response())));
                    continue;
                };
                if args["device_id"]
                    .as_str()
                    .is_some_and(|id| !device_aliases(&device).any(|alias| alias == id))
                {
                    continue;
                }
                if (args["device_id"].is_null()
                    && device_aliases(&device).any(|alias| alias == self.device_id))
                    || !seen.insert(
                        device["runtime_instance_id"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .unwrap_or(id)
                            .to_owned(),
                    )
                {
                    continue;
                }
                if !matches!(device["status"].as_str(), Some("online" | "busy")) {
                    sources.push(source_result(
                        id,
                        device["device_type"].as_str().unwrap_or("device"),
                        Err(AppIpcError::new("device_offline", "Device is offline")),
                    ));
                } else {
                    online.push(device);
                }
            }
            if online.is_empty() {
                if sources.is_empty() && args["device_id"].is_string() {
                    sources.push(source_result(
                        args["device_id"].as_str().unwrap(),
                        "device",
                        Err(AppIpcError::new("not_found", "Owned device was not found")),
                    ));
                }
                return sources;
            }
            let reader = match self.control_runtime_reader(context, budget).await {
                Ok(reader) => reader,
                Err(error) => {
                    for device in online {
                        sources.push(source_result(
                            device["device_id"].as_str().unwrap(),
                            "device",
                            Err(AppIpcError::new(
                                &error.code,
                                "Runtime read channel unavailable",
                            )),
                        ));
                    }
                    return sources;
                }
            };
            let mut reads = stream::iter(
                online
                    .into_iter()
                    .map(|device| {
                        let reader = &reader;
                        let args = &args;
                        async move {
                            let id = device["device_id"].as_str().unwrap();
                            source_result(
                                id,
                                device["device_type"].as_str().unwrap_or("device"),
                                self.control_device_query(reader, id, args).await,
                            )
                        }
                    })
                    .collect::<Vec<_>>(),
            )
            .buffer_unordered(8);
            while let Some(source) = reads.next().await {
                sources.push(source);
            }
            drop(reads);
            reader.close().await;
            sources
        };
        let (cloud, mut devices) = tokio::join!(cloud, devices);
        devices.extend(cloud);
        devices
    }

    async fn control_device_query(
        &self,
        reader: &RuntimeReader,
        device: &str,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let (tasks, mut reasons) =
            device_tasks(reader, device, args["include_archived"] == true).await?;
        let mut matching = Vec::new();
        let mut checks = stream::iter(tasks.into_iter().map(|mut task| async move {
            if !matches_filters(&task, args)? { return Ok(None); }
            if let Some(query) = args["query"].as_str() {
                if text_match(task["title"].as_str().unwrap_or_default(), query).is_none()
                    && text_match(task["workspacePath"].as_str().unwrap_or_default(), query).is_none() {
                    let result = reader.request(device, "runtime.tasks.transcript.search", json!({"taskId":task["taskId"], "workspacePath":task["workspacePath"],"query":query,"limit":1})).await?;
                    if result["totalMatches"].as_u64().ok_or_else(invalid_response)? == 0 { return Ok(None); }
                    task["match"] = result["matches"].as_array().and_then(|items| items.first()).cloned().unwrap_or(Value::Null);
                }
            }
            Ok::<_,AppIpcError>(Some(task))
        })).buffer_unordered(8);
        while let Some(result) = checks.next().await {
            match result {
                Ok(Some(task)) => matching.push(task),
                Ok(None) => {}
                Err(error) => {
                    *reasons.entry(error.code).or_insert(0) += 1;
                }
            }
        }
        let mut result = page(matching, args)?;
        result["coverage"] =
            json!({"authorized_index_complete":reasons.is_empty(),"unavailable_reasons":reasons});
        Ok(result)
    }
}

pub(super) async fn device_tasks(
    reader: &RuntimeReader,
    device: &str,
    include_archived: bool,
) -> Result<(Vec<Value>, BTreeMap<String, usize>), AppIpcError> {
    let listing = reader
        .request(device, "runtime.tasks.list", json!({}))
        .await?;
    let workspaces = listing["workspaces"]
        .as_array()
        .ok_or_else(invalid_response)?;
    let mut tasks = Vec::new();
    for workspace in workspaces {
        for task in workspace["tasks"].as_array().ok_or_else(invalid_response)? {
            let mut view = native_view(device, task.clone())?;
            view["project_key"] = workspace["projectKey"].clone();
            tasks.push(view);
        }
    }
    let mut reasons = coverage_reasons(&listing);
    if include_archived {
        match reader
            .request(device, "runtime.archived_conversations.list", json!({}))
            .await
        {
            Ok(archived) => {
                for (code, count) in coverage_reasons(&archived) {
                    *reasons.entry(code).or_insert(0) += count;
                }
                for task in archived["items"].as_array().ok_or_else(invalid_response)? {
                    let mut view = native_view(device, task.clone())?;
                    view["status"] = json!("archived");
                    tasks.push(view);
                }
            }
            Err(error) => {
                *reasons.entry(error.code).or_insert(0) += 1;
            }
        }
    }
    Ok((tasks, reasons))
}

fn device_aliases(device: &Value) -> impl Iterator<Item = &str> {
    [
        "device_id",
        "app_device_id",
        "socket_device_id",
        "runtime_instance_id",
    ]
    .into_iter()
    .filter_map(|key| device[key].as_str())
    .chain(
        device["runtime_routes"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|route| {
                [
                    route["device_id"].as_str(),
                    route["runtime_device_id"].as_str(),
                ]
                .into_iter()
                .flatten()
            }),
    )
    .map(str::trim)
    .filter(|alias| !alias.is_empty())
}

fn coverage_reasons(value: &Value) -> BTreeMap<String, usize> {
    let mut reasons: BTreeMap<String, usize> = value["coverage"]["unavailable_reasons"]
        .as_object()
        .map(|reasons| {
            reasons
                .iter()
                .filter_map(|(code, count)| {
                    count.as_u64().map(|count| (code.clone(), count as usize))
                })
                .collect()
        })
        .unwrap_or_default();
    if value["coverage"]["authorized_index_complete"] == false && reasons.is_empty() {
        reasons.insert("source_incomplete".into(), 1);
    }
    reasons
}

pub(super) fn source_result(id: &str, kind: &str, result: Result<Value, AppIpcError>) -> Value {
    match result {
        Ok(result) => {
            json!({"source_id":id,"source_type":kind,"status":"available","result":result})
        }
        Err(error) => {
            json!({"source_id":id,"source_type":kind,"status":"unavailable","code":error.code})
        }
    }
}

pub(in crate::runtime_work::handler::control) fn native_view(
    device: &str,
    mut task: Value,
) -> Result<Value, AppIpcError> {
    if !task.is_object() {
        return Err(invalid_response());
    }
    let id = task["taskId"]
        .as_str()
        .or_else(|| task["address"]["taskId"].as_str())
        .ok_or_else(invalid_response)?
        .to_owned();
    let handle = task
        .as_object_mut()
        .unwrap()
        .remove("runtimeHandle")
        .unwrap_or(Value::Null);
    task["taskId"] = json!(id);
    task["conversation_id"] = json!(workbench_control::conversation_id(device, &id));
    task["device_id"] = json!(device);
    if task["workspacePath"].is_null() {
        task["workspacePath"] = task["address"]["workspacePath"].clone();
    }
    for (key, field) in [
        ("model_selection", "modelSelection"),
        ("origin", "origin"),
        ("change_requests", "changeRequests"),
        ("goal", "goal"),
    ] {
        task[key] = handle.get(field).cloned().unwrap_or(Value::Null);
    }
    if task["project_key"].is_null() {
        task["project_key"] = task["projectKey"].clone();
    }
    redact_execution_profile_secrets(&mut task);
    Ok(task)
}

pub(super) fn history_request(args: &Value, task: &str) -> Value {
    json!({"taskId":task,"limit":args.get("limit").cloned().unwrap_or(json!(50)),
        "beforeCursor":args["before_cursor"],"afterCursor":args["after_cursor"]})
}
