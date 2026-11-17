//! Cloud history is read through the existing frontend Task and Subtask APIs.
use super::*;
use crate::runtime_work::reader::invalid_response;

struct CloudRead<'a> {
    control: &'a ControlContext,
    budget: ReadBudget,
}

impl RuntimeWorkRpcHandler {
    async fn cloud_get(&self, context: &CloudRead<'_>, path: &str) -> Result<Value, AppIpcError> {
        context
            .budget
            .read(
                "cloud_history",
                path.split('?').next().unwrap_or(path),
                self.control_http(context.control, reqwest::Method::GET, path, None),
            )
            .await
    }

    pub(super) async fn control_cloud_query(
        &self,
        context: &ControlContext,
        _operation: &str,
        args: &Value,
        budget: ReadBudget,
    ) -> Result<Value, AppIpcError> {
        let read = CloudRead {
            control: context,
            budget,
        };
        let context = &read;
        let active = self.cloud_task_pages(context, false);
        let archived = async {
            if args["include_archived"] == true {
                self.cloud_task_pages(context, true).await
            } else {
                Ok(Vec::new())
            }
        };
        let (active, archived) = tokio::join!(active, archived);
        let mut tasks = Vec::new();
        let mut reasons = BTreeMap::<String, usize>::new();
        for result in [active, archived] {
            match result {
                Ok(items) => tasks.extend(items),
                Err(error) => {
                    *reasons.entry(error.code).or_insert(0) += 1;
                }
            }
        }
        let mut matching = Vec::new();
        let mut checks = stream::iter(
            tasks
                .into_iter()
                .map(|task| async move {
                    let mut view = cloud_view(&task)?;
                    if !matches_filters(&view, args)? {
                        return Ok(None);
                    }
                    if let Some(query) = args["query"].as_str() {
                        if text_match(view["title"].as_str().unwrap_or_default(), query).is_none()
                            && text_match(view["workspacePath"].as_str().unwrap_or_default(), query)
                                .is_none()
                        {
                            let messages = self
                                .cloud_messages(
                                    context,
                                    &self
                                        .cloud_task_detail(
                                            context,
                                            task["id"].as_i64().ok_or_else(invalid_response)?,
                                        )
                                        .await?,
                                )
                                .await?;
                            let query = query.to_lowercase();
                            let Some(hit) = messages.iter().find(|message| {
                                message.to_string().to_lowercase().contains(&query)
                            }) else {
                                return Ok(None);
                            };
                            view["match"] = hit.clone();
                        }
                    }
                    Ok::<_, AppIpcError>(Some(view))
                })
                .collect::<Vec<_>>(),
        )
        .buffer_unordered(8);
        while let Some(result) = checks.next().await {
            match result {
                Ok(Some(view)) => matching.push(view),
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

    async fn cloud_task_pages(
        &self,
        context: &CloudRead<'_>,
        archived: bool,
    ) -> Result<Vec<Value>, AppIpcError> {
        let mut tasks = Vec::new();
        let mut seen = HashSet::new();
        let mut page = 1;
        loop {
            let endpoint = if archived {
                "/tasks/archived"
            } else {
                "/tasks"
            };
            let response = self
                .cloud_get(
                    context,
                    &format!("{endpoint}?client_origin=wework&page={page}&limit=100"),
                )
                .await?;
            let items = response["items"].as_array().ok_or_else(invalid_response)?;
            let total = response["total"].as_u64().ok_or_else(invalid_response)?;
            for task in items {
                let id = task["id"].as_i64().ok_or_else(invalid_response)?;
                if !seen.insert(id) {
                    continue;
                }
                if task["client_origin"] == "wework" && task["is_group_chat"] != true {
                    tasks.push(task.clone());
                }
            }
            // The existing list API filters display rows after its database page
            // and may overlap pages. Advance by its requested page, not item count.
            if page * 100 >= total {
                break;
            }
            page += 1;
        }
        Ok(tasks)
    }

    pub(super) async fn control_cloud_read(
        &self,
        context: &ControlContext,
        operation: &str,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let read = CloudRead {
            control: context,
            budget: ReadBudget::default(),
        };
        let context = &read;
        let id = args["conversation_id"]
            .as_str()
            .and_then(|id| id.strip_prefix("cloudconv_"))
            .and_then(|id| id.parse::<i64>().ok())
            .filter(|id| *id > 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "Invalid cloud conversation address"))?;
        // The same authorized detail request used by the frontend guards message reads.
        let task = self.cloud_task_detail(context, id).await?;
        if operation == "get_conversation" {
            return cloud_view(&task);
        }
        message_page(self.cloud_messages(context, &task).await?, args)
    }

    async fn cloud_task_detail(
        &self,
        context: &CloudRead<'_>,
        id: i64,
    ) -> Result<Value, AppIpcError> {
        let task = self
            .cloud_get(context, &format!("/tasks/{id}?client_origin=wework"))
            .await?;
        if task["client_origin"] != "wework" || task["is_group_chat"] == true {
            return Err(AppIpcError::new(
                "permission_denied",
                "Cloud conversation is unavailable",
            ));
        }
        Ok(task)
    }

    async fn cloud_messages(
        &self,
        context: &CloudRead<'_>,
        task: &Value,
    ) -> Result<Vec<Value>, AppIpcError> {
        let id = task["id"].as_i64().ok_or_else(invalid_response)?;
        let mut messages = Vec::new();
        let mut seen = HashSet::new();
        // Task detail is the frontend's authorized inherited-history projection.
        // Never follow a fork parent with a separate, weaker authorization path.
        for item in task["subtasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["inherited"] == true)
        {
            if seen.insert(item["id"].as_i64().ok_or_else(invalid_response)?) {
                messages.push(cloud_message(item));
            }
        }
        let mut page = 1;
        let mut current_count = 0;
        loop {
            let response = self
                .cloud_get(
                    context,
                    &format!("/subtasks?task_id={id}&from_latest=false&page={page}&limit=100"),
                )
                .await?;
            let items = response["items"].as_array().ok_or_else(invalid_response)?;
            let total = response["total"].as_u64().ok_or_else(invalid_response)?;
            for item in items {
                let row_id = item["id"].as_i64().ok_or_else(invalid_response)?;
                if !seen.insert(row_id) {
                    return Err(invalid_response());
                }
                messages.push(cloud_message(item));
                current_count += 1;
            }
            if current_count >= total {
                break;
            }
            if items.is_empty() {
                return Err(invalid_response());
            }
            page += 1;
        }
        Ok(messages)
    }
}

fn cloud_message(item: &Value) -> Value {
    let role = item["role"].as_str().unwrap_or_default().to_lowercase();
    let content = if role == "user" {
        &item["prompt"]
    } else {
        &item["result"]
    };
    let mut message = json!({"id":item["id"],"role":role,"content":content,"created_at":item["created_at"],
        "message_id":item["message_id"],"attachments":item["contexts"],"subtask":item});
    redact_execution_profile_secrets(&mut message);
    message
}

fn cloud_view(task: &Value) -> Result<Value, AppIpcError> {
    let id = task["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(invalid_response)?;
    let timestamp = |key: &str| {
        task[key]
            .as_i64()
            .or_else(|| {
                task[key].as_str().and_then(|value| {
                    chrono::DateTime::parse_from_rfc3339(value)
                        .map(|time| time.timestamp_millis())
                        .or_else(|_| {
                            // Backend DATETIME fields are UTC without a zone,
                            // matching the desktop's parseBackendUTCDate.
                            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                                .map(|time| time.and_utc().timestamp_millis())
                        })
                        .ok()
                })
            })
            .unwrap_or_default()
    };
    let mut view = task.clone();
    view["conversation_id"] = json!(format!("cloudconv_{id}"));
    view["taskId"] = json!(id.to_string());
    view["source"] = json!("cloud_history");
    view["created_at"] = json!(timestamp("created_at"));
    view["updated_at"] = json!(timestamp("updated_at"));
    view["workspacePath"] = task["execution_workspace_path"].clone();
    redact_execution_profile_secrets(&mut view);
    Ok(view)
}

fn message_page(messages: Vec<Value>, args: &Value) -> Result<Value, AppIpcError> {
    let cursor = |name: &str| -> Result<Option<usize>, AppIpcError> {
        args[name]
            .as_str()
            .map(|cursor| {
                let id = cursor
                    .strip_prefix("cloudmsg_")
                    .and_then(|id| id.parse::<i64>().ok())
                    .ok_or_else(|| AppIpcError::new("bad_request", "Invalid history cursor"))?;
                messages
                    .iter()
                    .position(|item| item["id"] == id)
                    .ok_or_else(|| AppIpcError::new("bad_request", "Unknown history cursor"))
            })
            .transpose()
    };
    let before = cursor("before_cursor")?;
    let after = cursor("after_cursor")?;
    if before.is_some() && after.is_some() {
        return Err(AppIpcError::new("bad_request", "Use one history direction"));
    }
    let limit = args["limit"].as_u64().unwrap_or(50).clamp(1, 200) as usize;
    let end = before.unwrap_or(messages.len());
    let start = after
        .map(|index| index + 1)
        .unwrap_or_else(|| end.saturating_sub(limit));
    let end = if after.is_some() {
        (start + limit).min(messages.len())
    } else {
        end
    };
    let items = &messages[start..end];
    Ok(
        json!({"messages":items,"has_more_before":start > 0,"has_more_after":end < messages.len(),
        "before_cursor":items.first().map(|v|format!("cloudmsg_{}",v["id"])),"after_cursor":items.last().map(|v|format!("cloudmsg_{}",v["id"]))}),
    )
}

#[cfg(test)]
mod tests;
