//! Federated reads. Mutations remain on their explicitly addressed owning Runtime.
use super::*;
use crate::workbench_control::read_budget::ReadBudget;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

mod cloud;
pub(super) mod remote;
use remote::history_request;

impl RuntimeWorkRpcHandler {
    pub(super) async fn control_runtime_reader(
        &self,
        context: &ControlContext,
        budget: ReadBudget,
    ) -> Result<crate::runtime_work::reader::RuntimeReader, AppIpcError> {
        let connection = self.backend_connection_snapshot()?.ok_or_else(|| {
            AppIpcError::new(
                "backend_connection_unavailable",
                "The desktop Runtime connection is not configured",
            )
        })?;
        crate::runtime_work::reader::RuntimeReader::connect(&context.request, &connection, budget)
            .await
    }

    pub(super) async fn control_query(
        &self,
        context: &ControlContext,
        operation: &str,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        let budget = ReadBudget::default();
        let local = budget.read(
            &self.device_id,
            operation,
            self.control_local_query(Some(context), operation, args.clone()),
        );
        if args["scope"] == "current_device" {
            if args["scope"] == "current_device"
                && args["device_id"]
                    .as_str()
                    .is_some_and(|id| id != self.device_id)
            {
                return Err(AppIpcError::new(
                    "bad_request",
                    "device_id conflicts with current_device scope",
                ));
            }
            return local.await;
        }
        if args["device_id"] == self.device_id {
            return merge_pages(
                vec![remote::source_result(
                    &self.device_id,
                    "current_device",
                    local.await,
                )],
                &args,
            );
        }
        let remote = self.control_other_sources(context, operation, args.clone(), budget);
        if args["device_id"].is_string() {
            return merge_pages(remote.await, &args);
        }
        let (local, remote) = tokio::join!(local, remote);
        let mut sources = vec![remote::source_result(
            &self.device_id,
            "current_device",
            local,
        )];
        sources.extend(remote);
        merge_pages(sources, &args)
    }

    pub(super) async fn control_remote_read(
        &self,
        context: &ControlContext,
        operation: &str,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        if args["conversation_id"]
            .as_str()
            .is_some_and(|id| id.starts_with("cloudconv_"))
        {
            return self.control_cloud_read(context, operation, &args).await;
        }
        let (device, task) = workbench_control::conversation_address(
            args["conversation_id"].as_str().unwrap_or_default(),
        )?;
        let reader = self
            .control_runtime_reader(context, ReadBudget::default())
            .await?;
        let result = if operation == "get_conversation" {
            remote::device_tasks(&reader, &device, true)
                .await
                .and_then(|(tasks, reasons)| {
                    tasks
                        .into_iter()
                        .find(|item| item["taskId"] == task)
                        .ok_or_else(|| {
                            AppIpcError::new(
                                reasons
                                    .keys()
                                    .next()
                                    .map(String::as_str)
                                    .unwrap_or("not_found"),
                                "Conversation could not be read from the device catalog",
                            )
                        })
                })
        } else {
            reader
                .transcript(&device, history_request(&args, &task))
                .await
        };
        reader.close().await;
        result
    }

    pub(super) async fn control_local_query(
        &self,
        context: Option<&ControlContext>,
        operation: &str,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        if matches!(operation, "get_conversation" | "read_conversation") {
            if args["before_cursor"].is_string() && args["after_cursor"].is_string() {
                return Err(AppIpcError::new("bad_request", "Use one history direction"));
            }
            let link = self.control_target(&args)?;
            if let Some(context) = context {
                self.authorize_control_target(context, &link).await?;
            }
            return if operation == "get_conversation" {
                Ok(self.control_task_view(link))
            } else {
                // MCP returns structured pages directly; keep full item text and history cursors.
                let mut result = self.read_transcript(json!({"taskId":link.local_task_id,"limit":args.get("limit").cloned().unwrap_or(json!(50)),"beforeCursor":args["before_cursor"],"afterCursor":args["after_cursor"],"transcriptProtocolVersion":2})).await?;
                if let Some(origin) = link.runtime_handle.get("origin") {
                    result["origin"] = origin.clone();
                }
                Ok(result)
            };
        }
        let (mut links, mut catalog_complete) = self.collect_query_links(false).await;
        if args["include_archived"].as_bool().unwrap_or(false) {
            let (archived, complete) = self.collect_query_links(true).await;
            append_unique_links(&mut links, archived);
            catalog_complete &= complete;
        }
        let index = CodexGlobalProjectIndex::load();
        let mut links = self.visible_links_for_projects(links, &index);
        let mut seen = HashSet::new();
        links.retain(|link| {
            !self.archived_link_is_deleted(link) && seen.insert(link.local_task_id.clone())
        });
        let mut filtered = Vec::new();
        for link in links {
            let item = self.control_task_view(link.clone());
            if matches_filters(&item, &args)? {
                filtered.push(link);
            }
        }
        let (links, mut reasons) = if let Some(context) = context {
            self.control_authorized_links(context, filtered).await
        } else {
            (filtered, BTreeMap::new())
        };
        if !catalog_complete {
            reasons.insert("native_catalog_unavailable".into(), 1);
        }
        let query = args["query"].as_str().map(str::to_owned);
        let mut checks = stream::iter(links.into_iter().map(|link| {
            let query = query.clone();
            async move {
                let mut item = self.control_task_view(link.clone());
                if let Some(query) = query {
                    if text_match(&link.title, &query).is_none()
                        && text_match(&link.workspace_path, &query).is_none()
                    {
                        match self
                            .search_transcript(
                                json!({"taskId":link.local_task_id,"query":query,"limit":1}),
                            )
                            .await
                        {
                            Ok(result)
                                if result["totalMatches"].as_u64().unwrap_or_default() > 0 =>
                            {
                                item["match"] = result["matches"]
                                    .as_array()
                                    .and_then(|matches| matches.first())
                                    .cloned()
                                    .unwrap_or(Value::Null);
                            }
                            Ok(_) => return Ok(None),
                            Err(error) => return Err(error),
                        }
                    }
                }
                Ok(Some(item))
            }
        }))
        .buffer_unordered(8);
        let mut items = Vec::new();
        while let Some(result) = checks.next().await {
            match result {
                Ok(Some(item)) => items.push(item),
                Ok(None) => {}
                Err(error) => *reasons.entry(error.code).or_insert(0) += 1,
            }
        }
        let unavailable: usize = reasons.values().sum();
        let mut result = page(items, &args)?;
        result["coverage"] = json!({"scope":"owning_device","device_id":self.device_id,"unavailable_count":unavailable,"unavailable_reasons":reasons,"authorized_index_complete":unavailable == 0});
        Ok(result)
    }
}

fn key(item: &Value) -> (i64, String) {
    (
        item["updated_at"]
            .as_i64()
            .or_else(|| item["updatedAt"].as_i64())
            .unwrap_or_default(),
        item["conversation_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    )
}
fn page(mut items: Vec<Value>, args: &Value) -> Result<Value, AppIpcError> {
    items.sort_by_key(|item| std::cmp::Reverse(key(item)));
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(item["conversation_id"].clone().to_string()));
    if let Some(after) = args["after"].as_str() {
        let bound: (i64, String) = URL_SAFE_NO_PAD
            .decode(after)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .ok_or_else(|| AppIpcError::new("bad_request", "Invalid conversation cursor"))?;
        items.retain(|item| key(item) < bound);
    }
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let more = items.len() > limit;
    items.truncate(limit);
    let cursor = if more {
        items.last().map(|item| {
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&key(item)).expect("conversation key"))
        })
    } else {
        None
    };
    Ok(json!({"items":items,"has_more":more,"next_cursor":cursor}))
}
fn matches_filters(item: &Value, args: &Value) -> Result<bool, AppIpcError> {
    if args["workspace_path"]
        .as_str()
        .is_some_and(|path| item["workspacePath"] != path)
    {
        return Ok(false);
    }
    if args["project_key"]
        .as_str()
        .is_some_and(|project| item["project_key"] != project)
    {
        return Ok(false);
    }
    for (name, lower) in [("updated_after", true), ("updated_before", false)] {
        if let Some(time) = args[name].as_str() {
            let time = chrono::DateTime::parse_from_rfc3339(time)
                .map_err(|_| AppIpcError::new("bad_request", "Invalid time filter"))?
                .timestamp_millis();
            if (lower && key(item).0 < time) || (!lower && key(item).0 >= time) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
fn merge_pages(mut sources: Vec<Value>, args: &Value) -> Result<Value, AppIpcError> {
    let mut items = Vec::new();
    let mut reasons = BTreeMap::<String, usize>::new();
    let mut source_has_more = false;
    for source in &mut sources {
        if source["status"] != "available" {
            *reasons
                .entry(
                    source["code"]
                        .as_str()
                        .unwrap_or("source_unavailable")
                        .to_owned(),
                )
                .or_default() += 1;
            continue;
        }
        let result = source
            .as_object_mut()
            .and_then(|source| source.remove("result"))
            .unwrap_or(Value::Null);
        let Some(page_items) = result["items"].as_array() else {
            source["status"] = json!("unavailable");
            source["code"] = json!("invalid_response");
            *reasons.entry("invalid_response".into()).or_default() += 1;
            continue;
        };
        items.extend(page_items.iter().cloned());
        source_has_more |= result["has_more"].as_bool().unwrap_or(false);
        if let Some(unavailable) = result["coverage"]["unavailable_reasons"].as_object() {
            for (code, count) in unavailable {
                *reasons.entry(code.clone()).or_default() +=
                    count.as_u64().unwrap_or_default() as usize;
            }
        }
        source["coverage"] = result["coverage"].clone();
    }
    let mut result = page(items, args)?;
    if source_has_more && result["has_more"] != true {
        if let Some(last) = result["items"].as_array().and_then(|items| items.last()) {
            result["next_cursor"] =
                json!(URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&key(last)).expect("conversation key")));
            result["has_more"] = json!(true);
        }
    }
    let unavailable: usize = reasons.values().sum();
    result["coverage"] = json!({"scope":"all","sources":sources,"unavailable_count":unavailable,"unavailable_reasons":reasons,"authorized_index_complete":unavailable == 0});
    if args["device_id"].is_string() {
        result["coverage"]["scope"] = json!("device");
        result["coverage"]["device_id"] = args["device_id"].clone();
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
