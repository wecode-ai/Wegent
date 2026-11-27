use super::*;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[cfg(test)]
#[path = "query_cursor_regressions.rs"]
mod query_cursor_regressions;

struct Query {
    owner: String,
    filters: Value,
    spaces: Vec<Value>,
    position: usize,
    items: Vec<Value>,
    sources: Vec<Value>,
    guards: Vec<(Value, BTreeMap<String, Value>)>,
    cursors: HashMap<String, usize>,
    expires: i64,
    bytes: usize,
}

static CACHED_BYTES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn reserve_cached_bytes(size: usize) -> bool {
    let mut current = CACHED_BYTES.load(Ordering::SeqCst);
    loop {
        let Some(next) = current
            .checked_add(size)
            .filter(|next| *next <= 64 * 1024 * 1024)
        else {
            return false;
        };
        match CACHED_BYTES.compare_exchange_weak(current, next, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => return true,
            Err(observed) => current = observed,
        }
    }
}

impl Drop for Query {
    fn drop(&mut self) {
        CACHED_BYTES.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}

type Queries = HashMap<String, Arc<tokio::sync::Mutex<Query>>>;
static QUERIES: OnceLock<Mutex<Queries>> = OnceLock::new();

pub(super) async fn discovery(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    arguments: &Value,
) -> Result<Value, String> {
    if context
        .grant
        .as_ref()
        .is_some_and(|grant| grant.role == Some(SpaceContextRole::Executor))
    {
        return Err("scope_violation: executor cannot enumerate projects".into());
    }
    let mut items = Vec::new();
    let mut sources = Vec::new();
    let local = runtime.list_projects().map_err(|error| error.to_string())?;
    let local = local
        .into_iter()
        .filter(|project| project.metadata["project_store"] != "backend")
        .collect::<Vec<_>>();
    if !local.is_empty() {
        match device(context) {
            Ok(device) => {
                for project in local {
                    let space =
                        json!({"project_store":"local","space_id":project.id,"device_id":device});
                    if authorize(runtime, context, &space, "list_spaces")
                        .await
                        .is_ok()
                    {
                        let mut value =
                            serde_json::to_value(project).map_err(|error| error.to_string())?;
                        value["space"] = space;
                        items.push(value);
                    }
                }
                sources.push(json!({"store":"local","state":"complete"}));
            }
            Err(_) => sources.push(json!({"store":"local","state":"unavailable"})),
        }
    }
    if let Some((backend_url, auth_token)) = context
        .backend_url
        .as_deref()
        .zip(context.auth_token.as_deref())
    {
        let backend = BackendToolContext {
            backend_url,
            auth_token,
            project_id: "",
            grant: context.grant.as_ref(),
            collaboration_dispatcher: None,
        };
        match call_backend_tool(&backend, "list_spaces", &json!({})).await {
            Ok(Value::Array(values)) => {
                for mut value in values {
                    let id = value["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value["id"].to_string());
                    value["space"] = json!({"project_store":"backend","space_id":id});
                    if authorize(runtime, context, &value["space"], "list_spaces")
                        .await
                        .is_ok()
                    {
                        items.push(value);
                    }
                }
                sources.push(json!({"store":"backend","state":"complete"}));
            }
            _ => sources.push(json!({"store":"backend","state":"unavailable"})),
        }
    }
    let needle = arguments["query"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase();
    items.retain(|item| {
        let name = item["name"]
            .as_str()
            .or_else(|| item["title"].as_str())
            .unwrap_or_default()
            .to_lowercase();
        name.contains(&needle)
            && arguments
                .get("workspace_id")
                .filter(|value| !value.is_null())
                .map_or(true, |workspace| {
                    item.get("workspace_id") == Some(workspace)
                })
    });
    items.sort_by_key(|item| hash(&item["space"]));
    Ok(
        json!({"items":items,"coverage":{"complete":sources.iter().all(|source|source["state"]=="complete"),"sources":sources}}),
    )
}

pub(super) async fn discover(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    arguments: &Value,
) -> Result<Value, String> {
    let mut result = discovery(runtime, context, arguments).await?;
    let values = result["items"].as_array().cloned().unwrap_or_default();
    let binding = hash(&json!([
        owner(runtime, context),
        arguments.get("query"),
        arguments.get("workspace_id")
    ]));
    let offset = if let Some(cursor) = arguments["cursor"].as_str() {
        let decoded = STANDARD
            .decode(cursor)
            .map_err(|_| "Invalid discovery cursor")?;
        let value: Value =
            serde_json::from_slice(&decoded).map_err(|_| "Invalid discovery cursor")?;
        if value["binding"] != binding {
            return Err("Discovery cursor does not match filters".into());
        }
        value["offset"].as_u64().ok_or("Invalid discovery cursor")? as usize
    } else {
        0
    };
    let limit = arguments["limit"].as_u64().unwrap_or(50) as usize;
    result["items"] = json!(values.iter().skip(offset).take(limit).collect::<Vec<_>>());
    result["matched_total"] = json!(values.len());
    result["next_cursor"] = if offset.saturating_add(limit) < values.len() {
        json!(STANDARD.encode(json!({"binding":binding,"offset":offset+limit}).to_string()))
    } else {
        Value::Null
    };
    Ok(result)
}

pub(super) async fn describe(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    space: &Value,
) -> Result<Value, String> {
    authorize(runtime, context, space, "list_board_items").await?;
    if space["project_store"] == "backend" {
        return cloud(context, "describe_space_board", json!({"space":space})).await;
    }
    let project = runtime
        .stand_in_store()
        .get_project(space["space_id"].as_str().ok_or("Missing project")?)
        .map_err(|error| error.to_string())?;
    let internal = crate::task_runtime::store::task_provider(&project)
        .map_err(|error| error.to_string())?
        == crate::task_runtime::TaskProviderKind::Local;
    Ok(
        json!({"space":space,"board_config":runtime.stand_in_store().project_board_config(space["space_id"].as_str().ok_or("Missing project")?).map_err(|error|error.to_string())?,"status_categories":null,"capabilities":{"read":true,"history":internal,"conditional_write":internal,"idempotent_write":internal,"structured_mentions":false,"archive_filter":false},"limits":{"read_batch":100,"write_batch":50,"items_page":200,"comments_page":500}}),
    )
}

fn normalize(mut item: Value, space: &Value) -> Value {
    item["target"] = json!({"space":space,"item_id":item["id"]});
    if !item.get("tags").is_some_and(Value::is_array) {
        item["tags"] = item["metadata"]["tags"]
            .as_array()
            .map(|tags| json!(tags))
            .unwrap_or_else(|| json!([]));
    }
    if item["due_at"].is_null() {
        item["due_at"] = item["metadata"]["due_at"].clone();
    }
    let mut assigned = Value::Null;
    for (kind, key) in [
        ("user", "assignee_user_id"),
        ("agent", "assignee_agent_id"),
        ("group", "assignee_group_id"),
        ("team", "assignee_team_id"),
    ] {
        if let Some(value) = item.get(key).filter(|value| !value.is_null()) {
            assigned = json!({"type":kind,"id":value.as_str().map(str::to_owned).unwrap_or_else(||value.to_string())});
            break;
        }
    }
    if assigned.is_null() {
        if let Some(id) = item["metadata"]["collaboration_group"]["id"].as_str() {
            assigned = json!({"type":"group","id":id});
        }
    }
    item["assignee"] = assigned;
    item
}

fn source_timestamp(value: &str) -> Result<chrono::DateTime<chrono::Utc>, chrono::ParseError> {
    if let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(timestamp.with_timezone(&chrono::Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(timestamp) = chrono::NaiveDateTime::parse_from_str(value, format) {
            return Ok(timestamp.and_utc());
        }
    }
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|date| date.and_time(chrono::NaiveTime::MIN).and_utc())
}

fn sort_items(mut items: Vec<Value>, sorts: &Value) -> Result<Vec<Value>, String> {
    items.sort_by_key(|item| hash(&item["target"]));
    for sort in sorts.as_array().into_iter().flatten().rev() {
        let field = sort["field"].as_str().ok_or("Invalid sort")?;
        let direction = |order: std::cmp::Ordering| {
            if sort["direction"] == "desc" {
                order.reverse()
            } else {
                order
            }
        };
        if matches!(field, "created_at" | "updated_at" | "due_at") {
            let mut keyed = items
                .into_iter()
                .map(|item| {
                    let timestamp = if item[field].is_null() {
                        None
                    } else {
                        let value = item[field]
                            .as_str()
                            .ok_or("unsupported_sort: invalid source timestamp")?;
                        Some(
                            source_timestamp(value)
                                .map_err(|_| "unsupported_sort: invalid source timestamp")?,
                        )
                    };
                    Ok((timestamp, item))
                })
                .collect::<Result<Vec<_>, String>>()?;
            keyed.sort_by(|left, right| direction(left.0.cmp(&right.0)));
            items = keyed.into_iter().map(|(_, item)| item).collect();
        } else {
            items.sort_by(|left, right| {
                direction(
                    left[field]
                        .as_str()
                        .unwrap_or_default()
                        .to_lowercase()
                        .cmp(&right[field].as_str().unwrap_or_default().to_lowercase()),
                )
            });
        }
    }
    Ok(items)
}

fn matches(item: &Value, filters: &Value, parents: &HashSet<String>) -> Result<bool, String> {
    let text = ["id", "title", "description"]
        .into_iter()
        .filter_map(|field| item[field].as_str())
        .chain(
            item["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str),
        )
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if !text.contains(
        &filters["query"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_lowercase(),
    ) {
        return Ok(false);
    }
    for (filter, field) in [
        ("statuses", "status"),
        ("priorities", "priority"),
        ("creator_user_ids", "created_by_user_id"),
    ] {
        if let Some(values) = filters[filter].as_array() {
            let value = item[field]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| item[field].to_string());
            if !values.iter().any(|option| option.as_str() == Some(&value)) {
                return Ok(false);
            }
        }
    }
    if filters["exclude_statuses"]
        .as_array()
        .is_some_and(|values| values.contains(&item["status"]))
    {
        return Ok(false);
    }
    if filters["assignees"]
        .as_array()
        .is_some_and(|values| !values.contains(&item["assignee"]))
    {
        return Ok(false);
    }
    if filters["unassigned"] == true && !item["assignee"].is_null() {
        return Ok(false);
    }
    if let Some(parent) = filters.get("parent") {
        if parent["space"] != item["target"]["space"] || parent["item_id"] != item["parent_id"] {
            return Ok(false);
        }
    }
    if let Some(expected) = filters["has_children"].as_bool() {
        if parents.contains(item["id"].as_str().unwrap_or_default()) != expected {
            return Ok(false);
        }
    }
    if let Some(tags) = filters.get("tags") {
        let selected = tags["values"].as_array().ok_or("Invalid tags")?;
        let actual = item["tags"].as_array().ok_or("Invalid Issue tags")?;
        let pass = if tags["mode"] == "all" {
            selected.iter().all(|tag| actual.contains(tag))
        } else {
            selected.iter().any(|tag| actual.contains(tag))
        };
        if !pass {
            return Ok(false);
        }
    }
    for field in ["created_at", "updated_at", "due_at"] {
        if let Some(range) = filters.get(field) {
            let Some(timestamp) = item[field].as_str() else {
                return Ok(false);
            };
            let timestamp = source_timestamp(timestamp)
                .map_err(|_| "unsupported_filter: invalid source timestamp")?;
            if let Some(from) = range["from"].as_str() {
                if timestamp
                    < chrono::DateTime::parse_from_rfc3339(from).map_err(|_| "Invalid interval")?
                {
                    return Ok(false);
                }
            }
            if let Some(to) = range["to"].as_str() {
                if timestamp
                    >= chrono::DateTime::parse_from_rfc3339(to).map_err(|_| "Invalid interval")?
                {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

async fn list(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    space: &Value,
    participating: bool,
) -> Result<Vec<Value>, String> {
    authorize(runtime, context, space, "list_board_items").await?;
    let items = if space["project_store"] == "backend" {
        if participating {
            let result = cloud(
                context,
                "list_board_items",
                json!({"space_id":space["space_id"],"participating":true}),
            )
            .await?;
            if result["participation"] != "mine" {
                return Err("source_unavailable: backend has no participation filter".into());
            }
            return result["items"]
                .as_array()
                .cloned()
                .ok_or_else(|| "Invalid Issue list".into());
        }
        let backend = BackendToolContext {
            backend_url: context
                .backend_url
                .as_deref()
                .ok_or("Backend unavailable")?,
            auth_token: context.auth_token.as_deref().ok_or("Backend unavailable")?,
            project_id: space["space_id"].as_str().ok_or("Missing project")?,
            grant: context.grant.as_ref(),
            collaboration_dispatcher: None,
        };
        call_backend_tool(
            &backend,
            "list_board_items",
            &json!({"space_id":space["space_id"]}),
        )
        .await?
    } else {
        individual(
            runtime,
            context,
            "list_board_items",
            json!({"space_id":space["space_id"]}),
        )
        .await?
    };
    let mut items = items.as_array().cloned().ok_or("Invalid Issue list")?;
    if participating {
        let project_id = space["space_id"].as_str().ok_or("Missing project")?;
        let mut viewers = vec![0];
        if let Some(user) = context
            .principal_id
            .as_deref()
            .and_then(|id| id.parse::<i64>().ok())
            .filter(|id| *id > 0)
        {
            viewers.push(user);
        }
        let ids = runtime
            .stand_in_store()
            .participating_issue_ids(project_id, &viewers)
            .map_err(|error| error.to_string())?;
        items.retain(|item| item["id"].as_str().is_some_and(|id| ids.contains(id)));
    }
    Ok(items)
}

fn registry() -> &'static Mutex<Queries> {
    QUERIES.get_or_init(Mutex::default)
}

fn issue_cursor(id: &str, state: &mut Query, offset: usize) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    state.cursors.insert(token.clone(), offset);
    STANDARD.encode(json!({"query_id":id,"token":token}).to_string())
}

async fn existing(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    id: &str,
) -> Result<Arc<tokio::sync::Mutex<Query>>, String> {
    let query = registry()
        .lock()
        .map_err(|_| "Query cache unavailable")?
        .get(id)
        .cloned()
        .ok_or("cursor_expired")?;
    {
        let state = query.lock().await;
        if state.owner != owner(runtime, context) || state.expires < Local::now().timestamp() {
            return Err("cursor_expired".into());
        }
        for (space, visible) in &state.guards {
            let current = list(runtime, context, space, false)
                .await
                .map_err(|_| "query_scope_changed")?;
            let current = current
                .iter()
                .map(|item| {
                    (
                        item["id"].as_str().unwrap_or_default().to_owned(),
                        item["permissions"].clone(),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            if visible
                .iter()
                .any(|(id, permissions)| current.get(id) != Some(permissions))
            {
                return Err("query_scope_changed".into());
            }
        }
    }
    Ok(query)
}

pub(super) async fn search(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    values: &Value,
) -> Result<Value, String> {
    if context
        .grant
        .as_ref()
        .is_some_and(|grant| grant.role == Some(SpaceContextRole::Executor))
    {
        return Err("scope_violation: executor cannot enumerate Issues".into());
    }
    if values.get("query_id").is_some()
        && values
            .as_object()
            .ok_or("Invalid request")?
            .keys()
            .any(|key| {
                !matches!(
                    key.as_str(),
                    "query_id" | "cursor" | "continuation_cursor" | "limit"
                )
            })
    {
        return Err("Query ID cannot change filters".into());
    }
    if values.get("statuses").is_some() && values.get("exclude_statuses").is_some()
        || values.get("assignees").is_some() && values["unassigned"] == true
    {
        return Err("Conflicting filters".into());
    }
    let mut id = values["query_id"].as_str().map(str::to_owned);
    let mut offset = 0;
    let mut cursor_token = None;
    if let Some(cursor) = values["cursor"]
        .as_str()
        .or_else(|| values["continuation_cursor"].as_str())
    {
        if values
            .as_object()
            .ok_or("Invalid request")?
            .keys()
            .any(|key| {
                !matches!(
                    key.as_str(),
                    "query_id" | "cursor" | "continuation_cursor" | "limit"
                )
            })
        {
            return Err("Cursor cannot change filters".into());
        }
        let decoded = STANDARD.decode(cursor).map_err(|_| "cursor_expired")?;
        let decoded: Value = serde_json::from_slice(&decoded).map_err(|_| "cursor_expired")?;
        let key = decoded["query_id"].as_str().ok_or("cursor_expired")?;
        let token = decoded["token"].as_str().ok_or("cursor_expired")?;
        if id.as_deref().is_some_and(|id| id != key) {
            return Err("Query cursor mismatch".into());
        }
        id = Some(key.to_owned());
        cursor_token = Some(token.to_owned());
    }
    if id.is_none() {
        let discovery = if values["scope"]["kind"] == "projects" {
            json!({"items":values["scope"]["spaces"].as_array().ok_or("Missing projects")?.iter().map(|space|json!({"space":space})).collect::<Vec<_>>(),"coverage":{"complete":true,"sources":[]}})
        } else {
            discovery(
                runtime,
                context,
                &json!({"workspace_id":values["scope"].get("workspace_id")}),
            )
            .await?
        };
        let mut seen = HashSet::new();
        let spaces = discovery["items"]
            .as_array()
            .ok_or("Invalid discovery")?
            .iter()
            .map(|item| item["space"].clone())
            .filter(|space| seen.insert(hash(space)))
            .collect::<Vec<_>>();
        let key = uuid::Uuid::new_v4().to_string();
        let query = Query {
            owner: owner(runtime, context),
            filters: values.clone(),
            spaces,
            position: 0,
            items: Vec::new(),
            sources: if discovery["coverage"]["complete"] == false {
                vec![json!({"state":"unavailable","phase":"discovery"})]
            } else {
                Vec::new()
            },
            guards: Vec::new(),
            cursors: HashMap::new(),
            expires: Local::now().timestamp() + 600,
            bytes: 0,
        };
        {
            let mut cache = registry().lock().map_err(|_| "Query cache unavailable")?;
            cache.retain(|_, state| {
                state
                    .try_lock()
                    .map_or(true, |state| state.expires >= Local::now().timestamp())
            });
            if cache.len() >= 128 {
                return Err("Query capacity exceeded".into());
            }
            cache.insert(key.clone(), Arc::new(tokio::sync::Mutex::new(query)));
        }
        id = Some(key);
    }
    let id = id.ok_or("Missing query")?;
    let query = existing(runtime, context, &id).await?;
    let mut state = query.lock().await;
    if let Some(token) = cursor_token {
        offset = *state.cursors.get(&token).ok_or("cursor_expired")?;
    }
    let started = std::time::Instant::now();
    while state.position < state.spaces.len() && started.elapsed().as_secs() < 40 {
        let space = state.spaces[state.position].clone();
        let result = async {
            if state.filters.get("include_archived").is_some() {
                return Err("unsupported_filter: archive selection".into());
            }
            let participating = state.filters["participation"] == "mine";
            let items = list(runtime, context, &space, participating).await?;
            let board;
            let visible = if participating && state.filters.get("has_children").is_some() {
                board = list(runtime, context, &space, false).await?;
                &board
            } else {
                &items
            };
            let guard = visible
                .iter()
                .map(|item| {
                    (
                        item["id"].as_str().unwrap_or_default().to_owned(),
                        item["permissions"].clone(),
                    )
                })
                .collect();
            let parents = visible
                .iter()
                .filter_map(|item| item["parent_id"].as_str().map(str::to_owned))
                .collect::<HashSet<_>>();
            let mut selected = Vec::new();
            for item in items {
                let item = normalize(item, &space);
                if matches(&item, &state.filters, &parents)? {
                    selected.push(item);
                }
            }
            let complete = if space["project_store"] == "backend" {
                cloud(context, "describe_space_board", json!({"space":space}))
                    .await
                    .map(|description| {
                        matches!(
                            description["task_provider"].as_str(),
                            Some("local" | "dingtalk_aitable")
                        )
                    })
                    .unwrap_or(false)
            } else {
                runtime
                    .stand_in_store()
                    .get_project(space["space_id"].as_str().ok_or("Missing project")?)
                    .and_then(|project| crate::task_runtime::store::task_provider(&project))
                    .map(|provider| provider == crate::task_runtime::TaskProviderKind::Local)
                    .unwrap_or(false)
            };
            Ok::<_, String>((selected, guard, complete))
        }
        .await;
        match result {
            Ok((items, guard, complete)) => {
                let size = items
                    .iter()
                    .map(|item| item.to_string().len())
                    .sum::<usize>()
                    + serde_json::to_string(&guard)
                        .map_err(|error| error.to_string())?
                        .len();
                if !reserve_cached_bytes(size) {
                    state.expires = 0;
                    state.items.clear();
                    state.guards.clear();
                    CACHED_BYTES.fetch_sub(state.bytes, Ordering::SeqCst);
                    state.bytes = 0;
                    return Err("Query cache budget exceeded; narrow scope or projection".into());
                }
                state.bytes += size;
                state.items.extend(items);
                state.guards.push((space.clone(), guard));
                state
                    .sources
                    .push(json!({"space":space,"state":if complete {"complete"} else {"partial"},"reason":if complete {Value::Null} else {json!("provider_snapshot_incomplete")}}));
            }
            Err(error) => state
                .sources
                .push(json!({"space":space,"state":"unavailable","error":{"message":error}})),
        }
        state.position += 1;
        if state
            .items
            .iter()
            .map(|item| item.to_string().len())
            .sum::<usize>()
            > 64 * 1024 * 1024
        {
            return Err("Query response budget exceeded".into());
        }
    }
    let ready = state.position == state.spaces.len();
    let complete = ready
        && state
            .sources
            .iter()
            .all(|source| source["state"] == "complete");
    let mut result = json!({"query_id":id,"state":if complete{"ready"}else if ready{"partial"}else{"collecting"},"coverage":{"complete":complete,"sources":state.sources},"consistency":"materialized_scan","expires_at":chrono::DateTime::from_timestamp(state.expires,0).ok_or("Invalid expiry")?.to_rfc3339()});
    if !ready {
        result["continuation_cursor"] = json!(issue_cursor(&id, &mut state, 0));
        result["matched_so_far"] = json!(state.items.len());
        result["items"] = json!([]);
        return Ok(result);
    }
    let items = sort_items(state.items.clone(), &state.filters["sort"])?;
    let limit = values["limit"].as_u64().unwrap_or(50) as usize;
    let mut page = items
        .iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    if state.filters["projection"] != "detail" {
        for item in &mut page {
            item.as_object_mut()
                .expect("Issue object")
                .retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "id" | "target"
                            | "title"
                            | "status"
                            | "priority"
                            | "assignee"
                            | "version"
                            | "updated_at"
                            | "created_by_user_id"
                    )
                });
        }
    }
    result["items"] = json!(page);
    result["matched_total"] = json!(items.len());
    result["next_cursor"] = if offset.saturating_add(limit) < items.len() {
        json!(issue_cursor(&id, &mut state, offset + limit))
    } else {
        Value::Null
    };
    Ok(result)
}

pub(super) async fn aggregate(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    values: &Value,
) -> Result<Value, String> {
    if values.get("query_id").is_some() == values.get("search").is_some() {
        return Err("Provide query_id or search exclusively".into());
    }
    let search_input = values
        .get("search")
        .cloned()
        .unwrap_or_else(|| json!({"query_id":values["query_id"]}));
    let mut response = search(runtime, context, &search_input).await?;
    if response["state"] == "collecting" {
        return Ok(response);
    }
    let id = response["query_id"].as_str().ok_or("Missing query")?;
    let query = existing(runtime, context, id).await?;
    let mut query = query.lock().await;
    let dimensions = values["group_by"].as_array().ok_or("Missing grouping")?;
    let binding = hash(&json!([id, dimensions]));
    let mut buckets: BTreeMap<String, Value> = BTreeMap::new();
    for item in &query.items {
        let mut combinations = vec![json!({})];
        for dimension in dimensions {
            let field = dimension.as_str().ok_or("Invalid grouping")?;
            let entries = match field {
                "tag" => item["tags"]
                    .as_array()
                    .filter(|tags| !tags.is_empty())
                    .cloned()
                    .unwrap_or_else(|| vec![Value::Null]),
                "space" => vec![item["target"]["space"].clone()],
                "creator" => vec![item["created_by_user_id"].clone()],
                _ => vec![item[field].clone()],
            };
            combinations = combinations
                .into_iter()
                .flat_map(|combination| {
                    entries.iter().map(move |entry| {
                        let mut value = combination.clone();
                        value[field] = entry.clone();
                        value
                    })
                })
                .collect();
        }
        for group in combinations {
            let bucket = buckets
                .entry(hash(&group))
                .or_insert_with(|| json!({"group":group,"count":0}));
            bucket["count"] = json!(bucket["count"].as_u64().unwrap_or(0) + 1);
        }
    }
    let offset = if let Some(cursor) = values["cursor"].as_str() {
        *query
            .cursors
            .get(&format!("{binding}:{cursor}"))
            .ok_or("Invalid aggregation cursor")?
    } else {
        0
    };
    let limit = values["limit"].as_u64().unwrap_or(50) as usize;
    let next = if offset.saturating_add(limit) < buckets.len() {
        let cursor = uuid::Uuid::new_v4().to_string();
        query
            .cursors
            .insert(format!("{binding}:{cursor}"), offset + limit);
        json!(cursor)
    } else {
        Value::Null
    };
    response.as_object_mut().expect("response").remove("items");
    response["buckets"] = json!(buckets
        .values()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>());
    response["next_cursor"] = next;
    response["count_mode"] = json!(if dimensions.iter().any(|dimension| dimension == "tag") {
        "memberships"
    } else {
        "distinct_items"
    });
    Ok(response)
}
