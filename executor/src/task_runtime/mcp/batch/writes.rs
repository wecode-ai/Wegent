use super::*;
use crate::task_runtime::store::board_receipts::BoardWriteReceipt;
use crate::task_runtime::{LocalCommentCreate, TaskCreate, TaskProviderKind};

fn action(name: &str) -> &str {
    match name {
        "batch_update_board_items" => "update_board_item",
        "batch_assign_board_items" => "assign_board_item",
        "batch_create_board_items" => "create_board_item",
        _ => "add_board_item_comment",
    }
}

fn target(entry: &Value) -> &Value {
    entry.get("target").unwrap_or(&entry["space"])
}

fn key(runtime: &TaskRuntime, context: &SpaceMcpRequestContext, values: &Value) -> String {
    hash(&json!([owner(runtime, context), values["operation_key"]]))
}

async fn check(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    entry: &Value,
) -> Result<Value, String> {
    let target = target(entry);
    authorize(runtime, context, target, action(name)).await?;
    let space = target.get("space").unwrap_or(target);
    if space["project_store"] == "backend" {
        return Ok(Value::Null);
    }
    let project = space["space_id"].as_str().ok_or("Missing project")?;
    let project_value = runtime
        .stand_in_store()
        .get_project(project)
        .map_err(|error| error.to_string())?;
    if crate::task_runtime::store::task_provider(&project_value)
        .map_err(|error| error.to_string())?
        != TaskProviderKind::Local
    {
        return Err("unsupported_operation: source lacks atomic receipt support".into());
    }
    if name == "batch_create_board_items" {
        let _: TaskCreate =
            serde_json::from_value(entry["item"].clone()).map_err(|error| error.to_string())?;
        return Ok(Value::Null);
    }
    let item = individual(
        runtime,
        context,
        "get_board_item",
        json!({"space_id":project,"item_id":target["item_id"]}),
    )
    .await?;
    if let Some(version) = entry.get("expected_version") {
        if item["version"] != *version {
            return Err("version_conflict: Issue changed".into());
        }
    }
    if name == "batch_add_board_item_comments"
        && entry["mentions"]
            .as_array()
            .is_some_and(|mentions| !mentions.is_empty())
    {
        return Err(
            "unsupported_operation: structured mentions require a shared Backend project".into(),
        );
    }
    Ok(item)
}

fn patch(entry: &Value, current: &Value) -> Result<TaskUpdate, String> {
    let mut values = entry.get("patch").cloned().unwrap_or_else(|| json!({}));
    values["version"] = entry["expected_version"].clone();
    if let Some(tags) = values.get("tags").cloned() {
        if let Some(replace) = tags.get("replace") {
            values["tags"] = replace.clone();
        } else {
            let mut selected = current["metadata"]["tags"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for added in tags["add"].as_array().into_iter().flatten() {
                if !selected.contains(added) {
                    selected.push(added.clone());
                }
            }
            selected.retain(|tag| {
                !tags["remove"]
                    .as_array()
                    .is_some_and(|removed| removed.contains(tag))
            });
            values["tags"] = json!(selected);
        }
    }
    if let Some(assignee) = entry.get("assignee") {
        let field = match assignee["type"].as_str() {
            Some("user") => "assignee_user_id",
            Some("agent") => "assignee_agent_id",
            Some("group") => "assignee_group_id",
            _ => return Err("unsupported_operation: assignee type".into()),
        };
        values[field] = if field == "assignee_user_id" {
            json!(assignee["id"]
                .as_str()
                .ok_or("Missing assignee")?
                .parse::<i64>()
                .map_err(|_| "Invalid user ID")?)
        } else {
            assignee["id"].clone()
        };
    }
    serde_json::from_value(values).map_err(|error| error.to_string())
}

fn schedule(value: Option<&Value>) -> Option<Option<String>> {
    value.map(|value| value.as_str().map(str::to_owned))
}

fn local(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    entry: &Value,
    current: &Value,
    operation: &str,
) -> Result<Value, String> {
    let target = target(entry);
    let space = target.get("space").unwrap_or(target);
    let project = space["space_id"].as_str().ok_or("Missing project")?;
    let receipt = BoardWriteReceipt {
        id: hash(&json!([operation, entry["request_id"]])),
        owner: owner(runtime, context),
        payload: hash(&json!([name, entry])),
    };
    let store = runtime.stand_in_store();
    let result = if name == "batch_create_board_items" {
        let input: TaskCreate =
            serde_json::from_value(entry["item"].clone()).map_err(|error| error.to_string())?;
        serde_json::to_value(
            store
                .create_task_with_receipt(
                    project,
                    input,
                    entry["item"]["start_at"].as_str().map(str::to_owned),
                    entry["item"]["due_at"].as_str().map(str::to_owned),
                    Some(&receipt),
                )
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?
    } else if name == "batch_add_board_item_comments" {
        let comment = store
            .create_comment_with_receipt(
                &LocalCommentCreate {
                    project_id: project.into(),
                    task_id: target["item_id"].as_str().ok_or("Missing Issue")?.into(),
                    client_message_id: Some(receipt.id.clone()),
                    sender_type: "system".into(),
                    sender_id: "wework_space".into(),
                    sender_name: "Wework".into(),
                    content: entry["body"].as_str().ok_or("Missing comment")?.into(),
                    metadata: json!({"activity_type":"mcp_comment"}),
                    reply_to_message_id: None,
                },
                Some(&receipt),
            )
            .map_err(|error| error.to_string())?;
        json!({"id":comment.message_id,"body":comment.content,"author":comment.sender_name,"created_at":comment.created_at,"updated_at":comment.updated_at})
    } else {
        let input = patch(entry, current)?;
        serde_json::to_value(
            store
                .update_task_with_receipt(
                    project,
                    target["item_id"].as_str().ok_or("Missing Issue")?,
                    input,
                    schedule(entry["patch"].get("start_at")),
                    schedule(entry["patch"].get("due_at")),
                    Some(&receipt),
                )
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?
    };
    Ok(
        json!({"request_id":entry["request_id"],"target":entry.get("target").cloned().unwrap_or_else(||json!({"space":space,"item_id":result["id"]})),"state":"succeeded","committed":true,"item_version":result.get("version"),"result":result}),
    )
}

fn outcome(entry: &Value, space: &Value, value: Value) -> Value {
    json!({"request_id":entry["request_id"],"target":entry.get("target").cloned().unwrap_or_else(||json!({"space":space,"item_id":value["id"]})),"state":"succeeded","committed":true,"item_version":value.get("version"),"result":value})
}

fn merge_remote(state: &mut Value, response: &Value) -> Result<(), String> {
    let indexes = state["remote"]["indexes"]
        .as_array()
        .ok_or("Missing remote intent")?
        .clone();
    let results = response["results"]
        .as_array()
        .ok_or("Missing remote receipt")?;
    if results.len() != indexes.len() {
        return Err("Incomplete remote receipt".into());
    }
    for (index, result) in indexes.iter().zip(results) {
        let index = index.as_u64().ok_or("Invalid result index")? as usize;
        if state["request"]["items"][index]["request_id"] != result["request_id"] {
            return Err("Remote request identity mismatch".into());
        }
        state["results"][index] = result.clone();
    }
    state["remote"]["operation_id"] = response["operation_id"].clone();
    state["remote"]["state"] = response["state"].clone();
    Ok(())
}

async fn preview(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    values: &Value,
) -> Result<Value, String> {
    let mut results = Vec::new();
    let mut remote = Vec::new();
    for entry in values["items"].as_array().ok_or("Missing items")? {
        let checked = check(runtime, context, name, entry).await;
        match checked {
            Err(message) => results.push(error(entry, message)),
            Ok(current) => {
                let target = target(entry);
                if target.get("space").unwrap_or(target)["project_store"] == "backend" {
                    remote.push(entry.clone());
                } else if matches!(
                    name,
                    "batch_update_board_items" | "batch_assign_board_items"
                ) && patch(entry, &current).is_err()
                {
                    results.push(error(entry, "Invalid mutation".into()));
                } else {
                    results.push(json!({"request_id":entry["request_id"],"state":"validated","committed":false,"observed_version":current.get("version"),"requested_change":entry,"business_validation":"revalidated_at_commit"}));
                }
            }
        }
    }
    if !remote.is_empty() {
        match cloud(
            context,
            name,
            json!({"operation_key":values["operation_key"],"preview":true,"items":remote}),
        )
        .await
        {
            Ok(response) => results.extend(
                response["results"]
                    .as_array()
                    .ok_or("Missing preview")?
                    .iter()
                    .cloned(),
            ),
            Err(message) => {
                results.extend(remote.iter().map(|entry| error(entry, message.clone())))
            }
        }
    }
    let by_id = results
        .into_iter()
        .map(|result| (result["request_id"].to_string(), result))
        .collect::<BTreeMap<_, _>>();
    let ordered = values["items"]
        .as_array()
        .ok_or("Missing items")?
        .iter()
        .map(|entry| {
            by_id
                .get(&entry["request_id"].to_string())
                .cloned()
                .ok_or_else(|| "Missing preview result".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"preview":true,"results":ordered}))
}

pub(super) async fn call(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    values: &Value,
) -> Result<Value, String> {
    if values["preview"] == true {
        return preview(runtime, context, name, values).await;
    }
    let items = values["items"].as_array().ok_or("Missing items")?;
    let operation = key(runtime, context, values);
    let principal = owner(runtime, context);
    let store = runtime.stand_in_store();
    let payload = hash(&json!([name, values]));
    let results = items.iter().map(|entry| json!({"request_id":entry["request_id"],"target":entry.get("target"),"state":"not_executed","committed":false})).collect::<Vec<_>>();
    let mut state = json!({"payload":payload,"tool":name,"request":values,"results":results,"state":"running","expires_at":Local::now().timestamp()+30*24*60*60});
    if !store
        .claim_board_operation(&operation, &principal, &state)
        .map_err(|error| error.to_string())?
    {
        let existing = store
            .board_operation(&operation, &principal)
            .map_err(|error| error.to_string())?
            .ok_or("Operation unavailable")?;
        if existing["payload"] != payload {
            return Err("idempotency_conflict".into());
        }
        return read(runtime, context, &json!({"operation_id":operation})).await;
    }
    let mut blocked = HashSet::new();
    let mut remote = Vec::new();
    let mut indexes = Vec::new();
    let started = std::time::Instant::now();
    for (index, entry) in items.iter().enumerate() {
        let identity = entry.get("target").map(hash);
        if identity
            .as_ref()
            .is_some_and(|identity| blocked.contains(identity))
            || started.elapsed().as_secs() > 8
        {
            continue;
        }
        let result = match check(runtime, context, name, entry).await {
            Ok(current) => {
                let target = target(entry);
                if target.get("space").unwrap_or(target)["project_store"] == "backend" {
                    remote.push(entry.clone());
                    indexes.push(index);
                    continue;
                }
                local(runtime, context, name, entry, &current, &operation)
            }
            Err(message) => Err(message),
        };
        let result = result.unwrap_or_else(|message| error(entry, message));
        if result["state"] != "succeeded" {
            if let Some(identity) = identity {
                blocked.insert(identity);
            }
        }
        state["results"][index] = result;
        store
            .save_board_operation(&operation, &principal, &state)
            .map_err(|error| error.to_string())?;
    }
    if !remote.is_empty() {
        let child_key = hash(&json!([operation, "backend"]));
        state["remote"] = json!({"operation_key":child_key,"indexes":indexes,"state":"unknown"});
        for index in &indexes {
            state["results"][*index]["state"] = json!("unknown");
            state["results"][*index]["committed"] = Value::Null;
        }
        store
            .save_board_operation(&operation, &principal, &state)
            .map_err(|error| error.to_string())?;
        if let Ok(response) = cloud(
            context,
            name,
            json!({"operation_key":child_key,"items":remote}),
        )
        .await
        {
            merge_remote(&mut state, &response)?;
        }
    }
    state["state"] = json!(if state["results"]
        .as_array()
        .ok_or("Missing results")?
        .iter()
        .any(|result| result["state"] == "unknown")
    {
        "unknown"
    } else {
        "completed"
    });
    store
        .save_board_operation(&operation, &principal, &state)
        .map_err(|error| error.to_string())?;
    view(runtime, context, &operation, state).await
}

async fn view(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    operation: &str,
    mut state: Value,
) -> Result<Value, String> {
    if state["expires_at"].as_i64().unwrap_or(0) < Local::now().timestamp() {
        return Err("operation_expired".into());
    }
    let principal = owner(runtime, context);
    let store = runtime.stand_in_store();
    let name = state["tool"]
        .as_str()
        .ok_or("Invalid operation")?
        .to_owned();
    let items = state["request"]["items"]
        .as_array()
        .ok_or("Invalid operation")?
        .clone();
    let mut hidden = HashSet::new();
    for (index, entry) in items.iter().enumerate() {
        let target = target(entry);
        let space = target.get("space").unwrap_or(target);
        if space["project_store"] != "local" {
            continue;
        }
        let leaf = hash(&json!([operation, entry["request_id"]]));
        if state["results"][index]["state"] != "succeeded" {
            if let Some(receipt) = store
                .board_operation(&leaf, &principal)
                .map_err(|error| error.to_string())?
            {
                let mut value = receipt["result"].clone();
                if name == "batch_add_board_item_comments" {
                    value = json!({"id":value["message_id"],"body":value["content"],"author":value["sender_name"],"created_at":value["created_at"],"updated_at":value["updated_at"]});
                }
                state["results"][index] = outcome(entry, space, value);
            }
        }
        if state["results"][index]["state"] == "succeeded" {
            let current_target = &state["results"][index]["target"];
            // Revoked session/project authority still hides the complete operation.
            authorize(runtime, context, current_target, "get_board_item").await?;
            if individual(
                runtime,
                context,
                "get_board_item",
                json!({"space_id":space["space_id"],"item_id":current_target["item_id"]}),
            )
            .await
            .is_err()
            {
                hidden.insert(index);
            }
        }
    }
    let results = state["results"].as_array().ok_or("Invalid receipts")?;
    if state["state"] == "running"
        && (state["remote"].is_null() || state["remote"]["state"] == "completed")
        && results
            .iter()
            .all(|result| matches!(result["state"].as_str(), Some("succeeded" | "failed")))
    {
        state["state"] = json!("completed");
        store
            .save_board_operation(operation, &principal, &state)
            .map_err(|error| error.to_string())?;
    }
    // Redaction is a response projection; keep the original durable commit snapshots intact.
    let mut results = state["results"]
        .as_array()
        .ok_or("Invalid receipts")?
        .clone();
    for index in hidden {
        let result = &results[index];
        results[index] = json!({
            "request_id":result["request_id"], "state":result["state"],
            "committed":result["committed"],
            "error":{"code":"result_unavailable",
                "message":"Committed result is unavailable under current access",
                "retryable":false}
        });
    }
    Ok(
        json!({"operation_id":operation,"state":state["state"],"counts":counts(&results),"results":results,"expires_at":chrono::DateTime::from_timestamp(state["expires_at"].as_i64().ok_or("Missing expiration")?,0).ok_or("Invalid expiration")?.to_rfc3339()}),
    )
}

pub(super) async fn read(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    values: &Value,
) -> Result<Value, String> {
    let operation = values["operation_id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| key(runtime, context, values));
    let principal = owner(runtime, context);
    let store = runtime.stand_in_store();
    let mut state = store
        .board_operation(&operation, &principal)
        .map_err(|error| error.to_string())?
        .ok_or("Operation unavailable")?;
    if state["expires_at"].as_i64().unwrap_or(0) < Local::now().timestamp() {
        return Err("operation_expired".into());
    }
    if !state["remote"].is_null() {
        let key = state["remote"]["operation_key"].clone();
        match cloud(context, "get_board_operation", json!({"operation_key":key})).await {
            Ok(response) => {
                merge_remote(&mut state, &response)?;
                if state["remote"]["state"] == "completed" {
                    state["state"] = json!("completed");
                }
            }
            Err(message) => {
                if state["results"]
                    .as_array()
                    .ok_or("Missing results")?
                    .iter()
                    .enumerate()
                    .any(|(index, result)| {
                        let entry = &state["request"]["items"][index];
                        let requested = target(entry);
                        result["state"] == "succeeded"
                            && requested.get("space").unwrap_or(requested)["project_store"]
                                == "backend"
                    })
                {
                    return Err(message);
                }
            }
        }
    }
    view(runtime, context, &operation, state).await
}
