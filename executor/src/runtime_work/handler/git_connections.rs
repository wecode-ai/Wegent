//! Authenticated cloud inbox operations use the selected Executor's account and device.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn bound_git_work_args(
        &self,
        identity: &crate::task_runtime::mcp::StandInMcpIdentity,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        if identity.device != self.device_id || identity.work.is_none() {
            return Err(AppIpcError::new(
                "permission_denied",
                "Source work required",
            ));
        }
        let actor = self
            .local_task_link(&identity.task_id)
            .ok_or_else(|| AppIpcError::new("permission_denied", "Work session unavailable"))?;
        if actor.runtime_handle["origin"]["userId"] != identity.user
            || actor.runtime_handle["executionRequest"]["user_id"].as_i64() != Some(identity.user)
        {
            return Err(AppIpcError::new("permission_denied", "Work owner changed"));
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let bound = crate::task_runtime::mcp::git_connections::bind(&store, identity, args)
            .map_err(|message| AppIpcError::new("permission_denied", message))?;
        if bound["subscriptionId"].is_string() {
            self.git_connection_webhook(json!({"operation":"boundary","subscriptionId":bound["subscriptionId"],"generation":bound["generation"]})).await?;
        }
        Ok(bound)
    }

    pub(super) async fn preflight_git_connections(
        &self,
        settings: &Value,
        previous: &Value,
    ) -> Result<(), AppIpcError> {
        let old = crate::task_runtime::personal_stand_in::stand_in_identities(previous);
        let mut subscriptions: Option<Value> = None;
        for identity in crate::task_runtime::personal_stand_in::stand_in_identities(settings) {
            let before = old.iter().find(|r| r["id"] == identity["id"]);
            for source in identity["connections"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|s| {
                    s["providerId"]
                        .as_str()
                        .is_some_and(|p| p.starts_with(super::super::git_connections::PACKAGE))
                })
            {
                if source["transport"] == "cli"
                    && (source["subscriptionId"].is_string()
                        || source["generation"].is_string()
                        || source["pendingTakeover"] == true)
                {
                    return Err(AppIpcError::new(
                        "git_connection_invalid",
                        "CLI sources cannot include webhook bindings",
                    ));
                }
                let unchanged = before
                    .and_then(|r| {
                        crate::task_runtime::personal_stand_in::stand_in_connection(r, source)
                    })
                    .is_some_and(|old| {
                        old["subscriptionId"] == source["subscriptionId"]
                            && old["generation"] == source["generation"]
                            && old["name"] == source["name"]
                            && old["transport"] == source["transport"]
                    });
                if unchanged && source["pendingTakeover"] != true {
                    continue;
                }
                let profile: Value =
                    serde_json::from_str(source["profile"].as_str().unwrap_or_default())
                        .map_err(|_| AppIpcError::new("git_account_changed", "Invalid account"))?;
                if source["pendingTakeover"] == true {
                    if subscriptions.is_none() {
                        subscriptions = Some(
                            self.git_connection_webhook(json!({"operation":"list"}))
                                .await?,
                        );
                    }
                    let row = subscriptions.as_ref().unwrap()["items"]
                        .as_array()
                        .and_then(|rows| rows.iter().find(|r| r["id"] == source["subscriptionId"]))
                        .ok_or_else(|| {
                            AppIpcError::new("git_binding_changed", "Subscription unavailable")
                        })?;
                    let platform = super::super::git_connections::provider(source)?;
                    if row["active"] != true
                        || row["source"]["provider"] != platform
                        || row["source"]["repositoryId"] != source["id"]
                        || row["source"]["accountId"] != profile[1]
                        || row["source"]["instance"] != profile[0]
                        || (row["generation"] != source["generation"]
                            && row["deviceId"] != self.device_id)
                    {
                        return Err(AppIpcError::new(
                            "git_binding_changed",
                            "Subscription source or generation changed",
                        ));
                    }
                }
                let repo = source["kind"] == "repository";
                let response=super::super::git_connections::read(json!({"providerId":source["providerId"],"profile":source["profile"],"instance":profile[0],"repository":source["name"],"operation":if repo{"repository"}else{"identity"}})).await?;
                if repo
                    && response["data"]["id"].to_string().trim_matches('"')
                        != source["id"].as_str().unwrap_or_default()
                {
                    return Err(AppIpcError::new(
                        "git_repository_changed",
                        "Repository identity changed",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) async fn prepare_git_connection(
        &self,
        source: &mut Value,
    ) -> Result<(), AppIpcError> {
        if source["subscriptionId"].is_string() && source["pendingTakeover"] != true {
            return Ok(());
        }
        let profile: Value = serde_json::from_str(source["profile"].as_str().unwrap_or(""))
            .map_err(|_| AppIpcError::new("git_connection_invalid", "Invalid Git account"))?;
        let mut args = json!({"providerId":source["providerId"],"profile":source["profile"],"instance":profile[0],"repository":source["name"],"operation":"repository"});
        let repository = super::super::git_connections::read(args.clone()).await?;
        if repository["data"]["id"].to_string().trim_matches('"')
            != source["id"].as_str().unwrap_or_default()
        {
            return Err(AppIpcError::new(
                "git_repository_changed",
                "Repository identity changed",
            ));
        }
        let result = if source["pendingTakeover"] == true {
            let subscriptions = self
                .git_connection_webhook(json!({"operation":"list"}))
                .await?;
            let row = subscriptions["items"]
                .as_array()
                .and_then(|rows| rows.iter().find(|r| r["id"] == source["subscriptionId"]))
                .ok_or_else(|| {
                    AppIpcError::new("git_binding_changed", "Subscription unavailable")
                })?;
            if row["source"]["repositoryId"] != source["id"]
                || row["source"]["accountId"] != profile[1]
                || row["source"]["instance"] != profile[0]
            {
                return Err(AppIpcError::new(
                    "git_binding_changed",
                    "Subscription source changed",
                ));
            }
            if row["deviceId"] == self.device_id && row["active"] == true {
                row.clone()
            } else {
                self.git_connection_webhook(json!({"operation":"takeover","subscriptionId":source["subscriptionId"],"generation":source["generation"]})).await?
            }
        } else {
            args["operation"] = json!("create");
            self.git_connection_webhook(args).await?
        };
        source["subscriptionId"] = result["id"].clone();
        source["generation"] = result["generation"].clone();
        source.as_object_mut().unwrap().remove("pendingTakeover");
        Ok(())
    }

    pub(super) async fn validate_git_source(&self, source: &Value) -> Result<(), AppIpcError> {
        let provider = source["providerId"].as_str().unwrap_or_default();
        if !provider.starts_with(super::super::git_connections::PACKAGE) {
            return Ok(());
        }
        let profile: Value = serde_json::from_str(source["profile"].as_str().unwrap_or(""))
            .map_err(|_| AppIpcError::new("git_account_changed", "Invalid Git account binding"))?;
        let operation = if source["kind"] == "repository" {
            "repository"
        } else {
            "identity"
        };
        let result=super::super::git_connections::read(json!({"providerId":provider,"profile":source["profile"],"instance":profile[0],"operation":operation,"repository":source["name"]})).await?;
        if source["kind"] == "repository" {
            if result["data"]["id"].to_string().trim_matches('"')
                != source["id"].as_str().unwrap_or_default()
            {
                return Err(AppIpcError::new(
                    "git_repository_changed",
                    "Repository identity changed",
                ));
            }
            if super::super::git_connections::uses_webhook(source) {
                self.git_connection_webhook(json!({"operation":"boundary","subscriptionId":source["subscriptionId"],"generation":source["generation"]})).await?;
            }
        }
        Ok(())
    }
    pub(super) async fn reconcile_git_disconnects(
        &self,
        store: &LocalTaskStore,
        user: i64,
    ) -> Result<(), AppIpcError> {
        let pending = store
            .pending_git_disconnects(user)
            .map_err(super::stand_in::settings_error)?;
        if pending.is_empty() {
            return Ok(());
        }
        let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
        let _guard = gate.lock().await;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let active: HashSet<String> =
            crate::task_runtime::personal_stand_in::stand_in_identities(&settings)
                .iter()
                .flat_map(|r| r["connections"].as_array().into_iter().flatten())
                .filter_map(|r| r["subscriptionId"].as_str().map(str::to_owned))
                .collect();
        let remote = match self
            .git_connection_webhook(json!({"operation":"list"}))
            .await
        {
            Ok(remote) => remote,
            Err(error) => {
                log_executor_event("Git receiver cleanup deferred", &[("code", error.code)]);
                return Ok(());
            }
        };
        let subscriptions = remote["items"].as_array().ok_or_else(|| {
            AppIpcError::new("git_connection_invalid", "Invalid subscription list")
        })?;
        for row in pending {
            let id = row["subscriptionId"].as_str().unwrap_or_default();
            let still_bound = subscriptions.iter().any(|s| {
                s["id"] == id
                    && s["deviceId"] == self.device_id
                    && s["generation"] == row["generation"]
                    && s["active"] == true
            });
            if active.contains(id) || !still_bound
                || self
                    .git_connection_webhook(json!({"operation":"remove","subscriptionId":id,"generation":row["generation"]}))
                    .await
                    .is_ok()
            {
                store
                    .finish_git_disconnect(row["id"].as_str().unwrap_or_default())
                    .map_err(super::stand_in::settings_error)?;
            }
        }
        Ok(())
    }
    pub(super) async fn git_connection_webhook(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let operation = payload["operation"].as_str().unwrap_or("");
        let base = "/v1/git-connections/subscriptions";
        if operation == "list" {
            return self.runtime_http(reqwest::Method::GET, base, None).await;
        }
        if operation == "boundary" {
            let result = self.runtime_http(reqwest::Method::GET, base, None).await?;
            let row = result["items"]
                .as_array()
                .and_then(|items| {
                    items.iter().find(|row| {
                        row["id"] == payload["subscriptionId"]
                            && row["generation"] == payload["generation"]
                            && row["deviceId"] == self.device_id
                            && row["active"] == true
                    })
                })
                .ok_or_else(|| {
                    AppIpcError::new("git_binding_changed", "Webhook binding is unavailable")
                })?;
            return Ok(
                json!({"partition":row["id"],"sequence":if payload["resumePending"]==true {&row["confirmedSequence"]}else{&row["latestSequence"]}}),
            );
        }
        if operation == "create" {
            let mut read = payload.clone();
            read["operation"] = json!("repository");
            let result = super::super::git_connections::read(read).await?;
            let provider = super::super::git_connections::provider(&payload)?;
            let instance = super::super::git_connections::instance(&payload, provider)?;
            let profile: Value = serde_json::from_str(result["profile"].as_str().unwrap_or(""))
                .map_err(|_| AppIpcError::new("git_connection_invalid", "Invalid profile"))?;
            let repository = &result["data"];
            let repository_id = repository["id"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| repository["id"].to_string());
            let path = repository["full_name"]
                .as_str()
                .or(repository["path_with_namespace"].as_str())
                .ok_or_else(|| {
                    AppIpcError::new("git_connection_invalid", "Missing repository path")
                })?;
            let mut response=self.runtime_http(reqwest::Method::POST,base,Some(&json!({"deviceId":self.device_id,"source":{"provider":provider,"instance":instance,"accountId":profile[1],"profile":result["profile"],"repositoryId":repository_id,"repositoryPath":path}}))).await?;
            let connection = self.backend_connection_snapshot()?.ok_or_else(|| {
                AppIpcError::new("cloud_unavailable", "Cloud connection unavailable")
            })?;
            response["callbackUrl"] = json!(format!(
                "{}{}",
                connection.backend_url.trim_end_matches('/'),
                response["callbackPath"].as_str().unwrap_or("")
            ));
            return Ok(response);
        }
        if operation == "setup" {
            let id = payload["subscriptionId"]
                .as_str()
                .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| AppIpcError::new("bad_request", "Invalid subscription ID"))?;
            let mut result=self.runtime_http(reqwest::Method::POST,&format!("{base}/{id}/configuration"),Some(&json!({"deviceId":self.device_id,"generation":payload["generation"],"reveal":true}))).await?;
            let connection = self
                .backend_connection_snapshot()?
                .ok_or_else(|| AppIpcError::new("cloud_unavailable", "Cloud unavailable"))?;
            result["callbackUrl"] = json!(format!(
                "{}{}",
                connection.backend_url.trim_end_matches('/'),
                result["callbackPath"].as_str().unwrap_or_default()
            ));
            return Ok(result);
        }
        let id = payload["subscriptionId"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| AppIpcError::new("bad_request", "Invalid subscription ID"))?;
        let mut body = payload.clone();
        body["deviceId"] = json!(self.device_id);
        let (method, path) = match operation {
            "events" => (reqwest::Method::POST, format!("{base}/{id}/events")),
            "ack" => (reqwest::Method::POST, format!("{base}/{id}/ack")),
            "takeover" | "pause" => (reqwest::Method::PUT, format!("{base}/{id}")),
            "remove" => (reqwest::Method::DELETE, format!("{base}/{id}")),
            _ => {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Unsupported subscription operation",
                ))
            }
        };
        self.runtime_http(method, &path, Some(&body)).await
    }
}
