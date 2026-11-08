//! Connection evidence uses existing provider reads and live saved source grants.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;
use crate::task_runtime::personal_stand_in::{
    connection_memory_scope, stand_in_collection_connection, stand_in_identities,
};

fn same_source(left: &Value, right: &Value) -> bool {
    ["providerId", "profile", "kind", "id"]
        .iter()
        .all(|key| left[*key] == right[*key] && left[*key].is_string())
}

fn collection_grant<'a>(collections: &'a [Value], reference: &Value) -> Option<&'a Value> {
    collections.iter().find(|grant| {
        same_source(grant, reference) && grant["collectionKey"] == reference["collectionKey"]
    })
}

fn concrete_collection_source(grant: &Value, reference: &Value) -> Option<Value> {
    let id = reference["id"]
        .as_str()
        .filter(|id| !id.trim().is_empty() && *id != "*" && id.len() <= 512)?;
    if !["providerId", "profile", "kind"]
        .iter()
        .all(|key| grant[*key] == reference[*key])
        || grant["collectionKey"] != reference["collectionKey"]
        || !reference["scope"].is_null()
    {
        return None;
    }
    let mut source = grant.clone();
    source.as_object_mut()?.remove("scope");
    source["id"] = json!(id);
    source["name"] = json!(reference["name"].as_str().unwrap_or(id));
    Some(source)
}

fn resolve_source(sources: &[Value], collections: &[Value], args: &Value) -> Option<Value> {
    if !args["collection"].is_null() {
        concrete_collection_source(
            collection_grant(collections, &args["collection"])?,
            &args["source"],
        )
    } else {
        sources
            .iter()
            .find(|source| same_source(source, &args["source"]))
            .cloned()
    }
}

#[cfg(test)]
#[path = "stand_in_memory_collections_tests.rs"]
mod tests;

fn contains_excerpt(value: &Value, excerpt: &str) -> bool {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::String(text) if text.contains(excerpt) => return true,
            Value::Object(fields) => pending.extend(fields.values()),
            Value::Array(items) => pending.extend(items),
            _ => {}
        }
    }
    false
}

fn connection_page_key(source: &Value, args: &Value) -> String {
    use sha2::{Digest, Sha256};
    // Include the host-resolved grant (including collection boundaries), not
    // caller-supplied labels. A completed search page is not a completed source.
    let mut page = json!([source, args["query"], args["cursor"]]);
    page.sort_all_objects();
    format!("connection-page:{:x}", Sha256::digest(page.to_string()))
}

impl RuntimeWorkRpcHandler {
    async fn memory_connection_sources(
        &self,
        identity: &StandInMcpIdentity,
    ) -> Result<(Vec<Value>, Vec<Value>), AppIpcError> {
        if !identity.memory_review || identity.review || identity.readonly_worker {
            return Err(AppIpcError::new(
                "permission_denied",
                "Memory review identity required",
            ));
        }
        self.read_stand_in_conversations(identity, "list_tasks", &json!({"limit":1}))
            .await?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(identity.user, &identity.device)
            .map_err(super::stand_in::settings_error)?;
        let roles = stand_in_identities(&settings);
        let mut exact = Vec::new();
        let mut collections = Vec::new();
        for role in &roles {
            for source in role["connections"].as_array().into_iter().flatten() {
                if source["scope"] == "all" {
                    collections.push(source.clone());
                } else if !exact.iter().any(|saved| same_source(saved, source)) {
                    exact.push(source.clone());
                }
            }
        }
        // Existing collected work supplies concrete resource identities for an
        // authorized collection; never invent wildcard expansion or account IDs.
        for work in store
            .list_stand_in_work(identity.user, None)
            .map_err(super::stand_in::settings_error)?
        {
            let source = &work["source"];
            if source["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && id != "*")
                && roles
                    .iter()
                    .any(|role| stand_in_collection_connection(role, source).is_some())
                && !exact.iter().any(|saved| same_source(saved, source))
            {
                exact.push(source.clone());
            }
        }
        Ok((exact, collections))
    }

    pub(super) async fn memory_connection_operation(
        &self,
        identity: &StandInMcpIdentity,
        name: &str,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let (sources, collections) = self.memory_connection_sources(identity).await?;
        if name == "list_memory_connections" {
            if sources.is_empty() && collections.is_empty() {
                return Ok(json!({"sources":[],"collections":[],"providers":[]}));
            }
            let catalog =
                crate::runtime_work::connection_host::call("catalog", None, json!({})).await?;
            let (current_sources, current_collections) =
                self.memory_connection_sources(identity).await?;
            if current_sources != sources || current_collections != collections {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Source grants changed during discovery",
                ));
            }
            let providers: Vec<_> = catalog["items"].as_array().into_iter().flatten()
                .filter(|provider| sources.iter().chain(&collections).any(|source| source["providerId"] == provider["id"]))
                .map(|provider| json!({"id":provider["id"],"name":provider["name"],"read":provider["read"],"resourceQuerySchema":provider["resourceQuerySchema"],"availability":provider["availability"]})).collect();
            return Ok(
                json!({"sources":sources,"collections":collections,"providers":providers,
                "coverageNote":"Use list_memory_connection_resources for authorized collections. Search-based discovery is not proof of exhaustive coverage; report unenumerated resources."}),
            );
        }
        if name == "list_memory_connection_resources" {
            return self
                .memory_collection_resources(identity, &collections, args)
                .await;
        }
        let source = resolve_source(&sources, &collections, args).ok_or_else(|| {
            AppIpcError::new(
                "permission_denied",
                "Source is no longer authorized for memory review",
            )
        })?;
        let mut read = json!({"source":args["source"]});
        for field in ["query", "cursor"] {
            if let Some(value) = args.get(field) {
                read[field] = value.clone();
            }
        }
        let input = crate::task_runtime::mcp::source_read_input(source.clone(), &read)
            .map_err(|error| AppIpcError::new("bad_request", error))?;
        let page = crate::runtime_work::connection_host::call(
            "readSource",
            source["providerId"].as_str(),
            input,
        )
        .await?;
        // A revoked grant must prevent both exposing and saving in-flight reads.
        let (current, current_collections) = self.memory_connection_sources(identity).await?;
        if resolve_source(&current, &current_collections, args).as_ref() != Some(&source) {
            return Err(AppIpcError::new(
                "permission_denied",
                "Source changed during evidence reading",
            ));
        }
        if matches!(
            name,
            "remember_from_connection" | "complete_memory_connection"
        ) && !args["contentHash"].is_string()
        {
            return Err(AppIpcError::new(
                "evidence_changed",
                "Saving or completing requires the previously read contentHash",
            ));
        }
        let chunk = crate::task_runtime::memory_evidence::chunk(&page, args)
            .map_err(|message| AppIpcError::new("evidence_changed", message))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let key = connection_page_key(&source, args);
        if name == "complete_memory_connection" {
            let hash = super::stand_in_tasks::required(args, "contentHash")?;
            store
                .complete_memory_evidence(identity.user, &key, &identity.task_id, hash)
                .map_err(super::stand_in::settings_error)?;
            return Ok(json!({"completed":true,"contentHash":hash}));
        }
        if name == "read_memory_connection" {
            let progress = store
                .memory_review_progress(identity.user, &key)
                .map_err(super::stand_in::settings_error)?;
            if crate::task_runtime::memory_evidence::review_completed(&progress, &chunk) {
                return Ok(json!({"unchanged":true,"reviewCompleted":true,
                    "contentHash":chunk["contentHash"],"nextCursor":page["nextCursor"],
                    "hasMore":page["hasMore"],"availability":page["availability"]}));
            }
            store
                .record_memory_attachment_read(
                    identity.user,
                    &key,
                    &identity.task_id,
                    "evidence",
                    &chunk,
                )
                .map_err(super::stand_in::settings_error)?;
            return Ok(chunk);
        }
        let item_id = super::stand_in_tasks::required(args, "itemId")?;
        let excerpt = super::stand_in_tasks::required(args, "excerpt")?;
        if excerpt.len() > 2000 {
            return Err(AppIpcError::new(
                "bad_request",
                "Evidence excerpt exceeds 2000 bytes",
            ));
        }
        let item = page["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|item| item["id"] == item_id && contains_excerpt(item, excerpt))
            .ok_or_else(|| {
                AppIpcError::new(
                    "evidence_changed",
                    "The exact source evidence was not returned; read the current record again",
                )
            })?;
        let scope = connection_memory_scope(&source);
        if let Some(id) = args["id"].as_str() {
            if !store
                .stand_in_memories(identity.user)
                .map_err(super::stand_in::settings_error)?
                .iter()
                .any(|row| row["id"] == id && row["scope"] == scope)
            {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Memory belongs to another source scope",
                ));
            }
        }
        use sha2::{Digest, Sha256};
        let source_key = format!("connection:{:x}", Sha256::digest(scope.to_string()));
        let record_version = format!("{item_id}:{:x}", Sha256::digest(item.to_string()));
        let write_id = format!(
            "{:x}",
            Sha256::digest(
                json!([
                    args["id"],
                    args["content"],
                    item_id,
                    excerpt,
                    chunk["contentHash"]
                ])
                .to_string()
            )
        );
        store
            .record_memory_review_write(identity.user, &key, &identity.task_id, &write_id, true)
            .map_err(super::stand_in::settings_error)?;
        let saved = super::stand_in_memory_review::memory_review_save_result(store.save_stand_in_memory(identity.user, &identity.device, json!({
            "id":args["id"],"version":args["version"],"content":args["content"],"scope":scope,"sourceTaskId":identity.task_id,
            "evidence":{"taskId":source_key,"messageId":record_version,"source":source,"itemId":item_id,"excerpt":excerpt,"readAt":chrono::Utc::now()}
        })))?;
        store
            .record_memory_review_write(identity.user, &key, &identity.task_id, &write_id, false)
            .map_err(super::stand_in::settings_error)?;
        Ok(saved)
    }

    async fn memory_collection_resources(
        &self,
        identity: &StandInMcpIdentity,
        collections: &[Value],
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let denied = || {
            AppIpcError::new(
                "permission_denied",
                "Collection is no longer authorized for memory review",
            )
        };
        let grant = collection_grant(collections, &args["collection"]).ok_or_else(denied)?;
        let query = args["query"]
            .as_str()
            .filter(|query| query.len() <= 8192)
            .ok_or_else(|| {
                AppIpcError::new(
                    "bad_request",
                    "Supply the provider's discovery query string",
                )
            })?;
        let mut input = json!({"kind":grant["kind"],"query":query});
        if let Some(cursor) = args.get("cursor") {
            if !cursor
                .as_str()
                .is_some_and(|cursor| !cursor.is_empty() && cursor.len() <= 8192)
            {
                return Err(AppIpcError::new("bad_request", "Invalid discovery cursor"));
            }
            input["cursor"] = cursor.clone();
        }
        // Omit scope=all: that operation selects a wildcard subscription rather
        // than enumerating concrete resources. Discovery never saves a grant.
        let page = crate::runtime_work::connection_host::call(
            "listResources",
            grant["providerId"].as_str(),
            input,
        )
        .await?;
        let (_, current) = self.memory_connection_sources(identity).await?;
        if collection_grant(&current, &args["collection"]) != Some(grant) {
            return Err(denied());
        }
        let rows = page["items"]
            .as_array()
            .filter(|rows| rows.len() <= 1000)
            .ok_or_else(|| {
                AppIpcError::new(
                    "invalid_provider_response",
                    "Invalid resource discovery page",
                )
            })?;
        if page["hasMore"] == true
            && !page["nextCursor"]
                .as_str()
                .is_some_and(|cursor| !cursor.is_empty())
        {
            return Err(AppIpcError::new(
                "invalid_provider_response",
                "Missing resource discovery cursor",
            ));
        }
        let items: Vec<_> = rows
            .iter()
            .filter_map(|row| concrete_collection_source(grant, row))
            .collect();
        crate::task_runtime::memory_evidence::chunk(
            &json!({"items":items,"hasMore":page["hasMore"],"nextCursor":page["nextCursor"],"availability":page["availability"],
            "coverageNote":"Follow nextCursor even when this authorized page is empty. A provider search may not enumerate every resource."}),
            args,
        ).map_err(|message| AppIpcError::new("invalid_memory_evidence", message))
    }
}
