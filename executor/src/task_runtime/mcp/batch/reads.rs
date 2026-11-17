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
                            let mut result = response["results"][0].clone();
                            if result["request_id"] != entry["request_id"] {
                                return Err("Invalid remote identity".into());
                            }
                            if result["state"] == "succeeded" {
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
                let remote_results = response["results"]
                    .as_array()
                    .ok_or("Missing remote results")?;
                if remote_results.len() != remote.len() {
                    return Err("Incomplete remote batch receipt".into());
                }
                for (index, result) in remote_results.iter().enumerate() {
                    let mut result = result.clone();
                    if name == "batch_get_assignment_candidates" {
                        result["request_id"] = remote[index]["request_id"].clone();
                    }
                    results.push(result);
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
    let comments = runtime
        .list_comments(project, item, 0)
        .map_err(|error| error.to_string())?;
    let limit = entry["limit"].as_u64().unwrap_or(100) as usize;
    let eligible = comments
        .iter()
        .filter(|comment| comment.sequence_number > after)
        .collect::<Vec<_>>();
    let start = if mode == "latest" {
        eligible.len().saturating_sub(limit)
    } else {
        0
    };
    let page = eligible
        .iter()
        .skip(start)
        .take(limit)
        .copied()
        .collect::<Vec<_>>();
    let has_later = mode != "latest" && eligible.len() > limit;
    let cursor = page.last().map(|comment| {
        STANDARD.encode(json!({"binding":binding,"after":comment.sequence_number,"history_from_start":history_from_start,"expires_at":Local::now().timestamp()+600}).to_string())
    });
    Ok(
        json!({"comments":page.iter().map(|comment|json!({"id":comment.message_id,"body":comment.content,"author":comment.sender_name,"web_url":null,"created_at":comment.created_at,"updated_at":comment.updated_at,"sequence_number":comment.sequence_number})).collect::<Vec<_>>(),"has_earlier":start>0||after>0,"has_later":has_later,"history_complete":history_from_start&&!has_later,"next_cursor":cursor}),
    )
}
