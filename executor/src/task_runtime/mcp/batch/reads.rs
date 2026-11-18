use super::*;

pub(super) async fn call(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let entries = if name == "batch_get_assignment_candidates" {
        arguments["spaces"]
            .as_array()
            .ok_or("Missing spaces")?
            .iter()
            .enumerate()
            .map(|(index, space)| json!({"request_id":index.to_string(),"space":space}))
            .collect::<Vec<_>>()
    } else {
        arguments["items"]
            .as_array()
            .ok_or("Missing items")?
            .clone()
    };
    let action = match name {
        "batch_get_assignment_candidates" => "get_assignment_candidates",
        "batch_list_board_item_comments" => "list_board_item_comments",
        _ => "get_board_item",
    };
    let mut results = Vec::new();
    let mut remote = Vec::new();
    for entry in &entries {
        let target = entry.get("target").unwrap_or(&entry["space"]);
        if let Err(message) = authorize(runtime, context, target, action).await {
            results.push(error(entry, message));
            continue;
        }
        let space = target.get("space").unwrap_or(target);
        if space["project_store"] == "backend" {
            if name == "batch_get_board_items"
                && context
                    .grant
                    .as_ref()
                    .is_some_and(|grant| grant.role == Some(SpaceContextRole::Executor))
            {
                let mut allowed = Vec::new();
                let mut denied = Vec::new();
                for section in arguments["include"].as_array().into_iter().flatten() {
                    let action = match section.as_str() {
                        Some("attachment_metadata") => "list_item_attachments",
                        Some("delivery_summaries") => "list_deliveries",
                        _ => "get_board_item",
                    };
                    if authorize(runtime, context, target, action).await.is_ok() {
                        allowed.push(section.clone());
                    } else {
                        denied.push(section.clone());
                    }
                }
                if !denied.is_empty() {
                    match cloud(context, name, json!({"items":[entry],"include":allowed})).await {
                        Ok(response) => {
                            let mut result = remote_result(&response, entry, &entry["request_id"]);
                            if result["state"] == "succeeded" {
                                if !result["result"]["sections"].is_object() {
                                    results.push(unavailable(entry, "Invalid remote sections"));
                                    continue;
                                }
                                for section in denied {
                                    result["result"]["sections"]
                                        [section.as_str().ok_or("Invalid section")?] =
                                        json!({"state":"unavailable"});
                                }
                            }
                            results.push(result);
                        }
                        Err(message) => results.push(error(entry, message)),
                    }
                    continue;
                }
            }
            remote.push(entry.clone());
            continue;
        }
        let value = local(runtime, context, name, entry, arguments).await;
        results.push(match value{Ok(value)=>json!({"request_id":entry["request_id"],"target":entry.get("target"),"space":entry.get("space"),"state":"succeeded","result":value}),Err(message)=>error(entry,message)});
    }
    if !remote.is_empty() {
        let payload = if name == "batch_get_assignment_candidates" {
            json!({"spaces":remote.iter().map(|entry|&entry["space"]).collect::<Vec<_>>(),"types":arguments.get("types").cloned().unwrap_or_else(||json!(["user","agent","group"]))})
        } else {
            let mut value = json!({"items":remote});
            if let Some(include) = arguments.get("include") {
                value["include"] = include.clone();
            }
            value
        };
        match cloud(context, name, payload).await {
            Ok(response) => {
                for (index, entry) in remote.iter().enumerate() {
                    let request_id = if name == "batch_get_assignment_candidates" {
                        json!(index.to_string())
                    } else {
                        entry["request_id"].clone()
                    };
                    results.push(remote_result(&response, entry, &request_id));
                }
            }
            Err(message) => {
                results.extend(remote.iter().map(|entry| error(entry, message.clone())))
            }
        }
    }
    let by_id = results
        .into_iter()
        .map(|result| (result["request_id"].to_string(), result))
        .collect::<BTreeMap<_, _>>();
    let ordered = entries
        .iter()
        .map(|entry| {
            by_id
                .get(&entry["request_id"].to_string())
                .cloned()
                .unwrap_or_else(|| error(entry, "Missing batch result".into()))
        })
        .collect::<Vec<_>>();
    Ok(json!({"counts":counts(&ordered),"results":ordered}))
}

fn unavailable(entry: &Value, message: &str) -> Value {
    let mut result = error(entry, message.into());
    result["error"]["code"] = json!("source_unavailable");
    result["error"]["retryable"] = json!(true);
    if let Some(space) = entry.get("space") {
        result["space"] = space.clone();
    }
    result
}

fn remote_result(response: &Value, entry: &Value, request_id: &Value) -> Value {
    let Some(results) = response["results"].as_array() else {
        return unavailable(entry, "Missing remote results");
    };
    let mut matching = results
        .iter()
        .filter(|result| result["request_id"] == *request_id);
    let Some(result) = matching.next() else {
        return unavailable(entry, "Missing remote entry result");
    };
    if matching.next().is_some() {
        return unavailable(entry, "Duplicate remote entry result");
    }
    let succeeded = result["state"] == "succeeded";
    let valid_state = if succeeded {
        result["result"].is_object()
    } else {
        result["state"] == "failed" && result["error"].is_object()
    };
    if !valid_state
        || entry
            .get("target")
            .is_some_and(|target| result["target"] != *target)
        || entry.get("space").is_some_and(|space| {
            (succeeded || result.get("space").is_some()) && result["space"] != *space
        })
    {
        return unavailable(entry, "Invalid remote entry result");
    }
    let mut result = result.clone();
    result["request_id"] = entry["request_id"].clone();
    if let Some(space) = entry.get("space") {
        result["space"] = space.clone();
    }
    result
}

async fn local(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    entry: &Value,
    arguments: &Value,
) -> Result<Value, String> {
    let target = entry.get("target").unwrap_or(&entry["space"]);
    let space = target.get("space").unwrap_or(target);
    let project = space["space_id"].as_str().ok_or("Missing project")?;
    if name == "batch_get_assignment_candidates" {
        let mut value = individual(
            runtime,
            context,
            "get_assignment_candidates",
            json!({"space_id":project}),
        )
        .await?;
        if let Some(types) = arguments["types"].as_array() {
            value
                .as_object_mut()
                .ok_or("Invalid candidates")?
                .retain(|key, _| {
                    types.iter().any(|kind| {
                        kind == match key.as_str() {
                            "members" => "user",
                            "robots" => "agent",
                            "groups" => "group",
                            _ => "team",
                        }
                    })
                });
        }
        return Ok(value);
    }
    let item = target["item_id"].as_str().ok_or("Missing Issue")?;
    let details = individual(
        runtime,
        context,
        "get_board_item",
        json!({"space_id":project,"item_id":item}),
    )
    .await?;
    if name == "batch_list_board_item_comments" {
        return comments(runtime, context, entry, project, item);
    }
    let mut sections = json!({});
    for section in arguments["include"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let action = match section {
            "attachment_metadata" => "list_item_attachments",
            "delivery_summaries" => "list_deliveries",
            _ => "get_board_item",
        };
        let value = if section == "permissions" {
            details
                .get("permissions")
                .cloned()
                .ok_or_else(|| "Permissions are not reported by this source".into())
        } else {
            individual(
                runtime,
                context,
                action,
                json!({"space_id":project,"item_id":item}),
            )
            .await
        };
        sections[section] = match value {
            Ok(value) => json!({"state":"complete","value":value}),
            Err(_) => json!({"state":"unavailable"}),
        };
    }
    Ok(json!({"item":details,"sections":sections}))
}

fn comments(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    entry: &Value,
    project: &str,
    item: &str,
) -> Result<Value, String> {
    let record = runtime
        .stand_in_store()
        .get_project(project)
        .map_err(|error| error.to_string())?;
    if crate::task_runtime::store::task_provider(&record).map_err(|error| error.to_string())?
        != crate::task_runtime::TaskProviderKind::Local
    {
        return Err(
            "unsupported_operation: source does not provide complete local comment history".into(),
        );
    }
    let mode = entry["mode"].as_str().ok_or("Missing comment mode")?;
    let binding = hash(&json!([owner(runtime, context), entry["target"]]));
    let (after, history_from_start) = if mode == "after" {
        let value = STANDARD
            .decode(
                entry["cursor"]
                    .as_str()
                    .ok_or("Comment continuation requires a cursor")?,
            )
            .map_err(|_| "Invalid comment cursor")?;
        let value: Value = serde_json::from_slice(&value).map_err(|_| "Invalid comment cursor")?;
        if value["binding"] != binding {
            return Err("Invalid comment cursor binding".into());
        }
        if value["expires_at"].as_i64().unwrap_or(0) < Local::now().timestamp() {
            return Err("Comment cursor expired".into());
        }
        let after = value["after"]
            .as_i64()
            .filter(|value| *value >= 0)
            .ok_or("Invalid comment cursor")?;
        let history_from_start = value["history_from_start"]
            .as_bool()
            .ok_or("Invalid comment history coverage")?;
        (after, history_from_start)
    } else {
        if entry.get("cursor").is_some() {
            return Err("Cursor requires after mode".into());
        }
        (0, mode == "oldest")
    };
    let limit = entry["limit"].as_u64().unwrap_or(100) as usize;
    let (page, has_earlier, has_later) = runtime
        .stand_in_store()
        .list_comment_page(project, item, after, limit, mode == "latest")
        .map_err(|error| error.to_string())?;
    let cursor = page.last().map(|comment| {
        STANDARD.encode(json!({"binding":binding,"after":comment.sequence_number,"history_from_start":history_from_start,"expires_at":Local::now().timestamp()+600}).to_string())
    });
    Ok(
        json!({"comments":page.iter().map(|comment|json!({"id":comment.message_id,"body":comment.content,"author":comment.sender_name,"web_url":null,"created_at":comment.created_at,"updated_at":comment.updated_at,"sequence_number":comment.sequence_number})).collect::<Vec<_>>(),"has_earlier":has_earlier,"has_later":has_later,"history_complete":history_from_start&&!has_later,"next_cursor":cursor}),
    )
}
