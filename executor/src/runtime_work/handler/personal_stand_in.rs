//! Personal settings are owned by the selected Executor, independent of project membership.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::personal_stand_in::{
    project_role, role_project_matches, stand_in_connection, stand_in_identities, DINGTALK_PROVIDER,
};

fn active_dingtalk_delegation(primary: &Value) -> bool {
    primary["enabled"] == true
        && primary["delegation"]["authorized"] == true
        && primary["delegation"]["paused"] == false
}

fn enabled_dingtalk_sources(primary: &Value) -> impl Iterator<Item = &Value> {
    primary["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|source| {
            source["providerId"] == DINGTALK_PROVIDER
                && source["delegated"] == true
                && source["paused"] != true
        })
}

fn needs_dingtalk_read_preflight(primary: &Value, previous: &Value) -> bool {
    if !active_dingtalk_delegation(primary) {
        return false;
    }
    let delegation = &primary["delegation"];
    let before = &previous["delegation"];
    !active_dingtalk_delegation(previous)
        || primary["model"] != previous["model"]
        || ["profile", "accountId", "organizationId"]
            .into_iter()
            .any(|key| delegation[key] != before[key])
        || ["document", "schedule", "process"]
            .into_iter()
            .any(|key| delegation["templates"][key] == true && before["templates"][key] != true)
        || enabled_dingtalk_sources(primary).any(|source| {
            !stand_in_connection(previous, source)
                .is_some_and(|row| row["delegated"] == true && row["paused"] == false)
        })
}

pub(super) fn verified_dingtalk_readiness<'a>(
    readiness: &'a Value,
    expected: &Value,
    read: bool,
) -> Result<&'a Value, AppIpcError> {
    let identity = &readiness["identity"];
    let organization = &identity["organizationId"];
    if readiness["status"] == "permissions_required" {
        return Err(AppIpcError::new(
            "dingtalk_permissions_required",
            "Check the message permissions for the selected DingTalk conversations",
        ));
    }
    if readiness["status"] == "auth_required" {
        return Err(AppIpcError::new(
            "connector_auth_required",
            "Reconnect the selected DingTalk account",
        ));
    }
    if readiness["status"] == "identity_required"
        || (readiness["status"] == "ready"
            && (identity["profile"] != expected["profile"]
                || identity["accountId"] != expected["accountId"]
                || organization.as_str().map_or(true, str::is_empty)
                || (!expected["organizationId"].is_null()
                    && organization != &expected["organizationId"])))
    {
        return Err(AppIpcError::new(
            "dingtalk_identity_changed",
            "Confirm the DingTalk account and organization again",
        ));
    }
    if readiness["status"] != "ready" || (read && readiness["permissions"]["read"] != "verified") {
        return Err(AppIpcError::new(
            "dingtalk_not_ready",
            "Check the DingTalk authorization and message permissions before enabling",
        ));
    }
    Ok(identity)
}

fn unique_native_codex_default(catalog: &Value) -> Option<Value> {
    let mut defaults = catalog["models"].as_array()?.iter().filter(|model| {
        model["runtime"] == "codex" && model["is_default"] == true && model["source"] != "cloud"
    });
    let model = defaults.next()?;
    if defaults.next().is_some() {
        return None;
    }
    Some(json!({
        "runtime": "codex",
        "provider": model["provider"],
        "model_id": model["model_id"],
    }))
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn personal_stand_in_projects(&self) -> Result<Vec<Value>, AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let personal = store
            .all_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?;
        let local = store.list_projects().map_err(settings_error)?;
        let cloud = if personal.iter().any(|settings| {
            stand_in_identities(settings).iter().any(|role| {
                role["collaboration"]["enabled"] == true
                    && (role["collaboration"]["allProjects"] == true
                        || role["collaboration"]["projects"]
                            .as_array()
                            .is_some_and(|projects| {
                                projects.iter().any(|project| project["store"] == "cloud")
                            }))
            })
        }) && self.backend_connection_snapshot()?.is_some()
        {
            match self
                .runtime_http(reqwest::Method::GET, "/v1/cloud-projects", None)
                .await
            {
                Ok(value) => value["items"].as_array().cloned().unwrap_or_default(),
                Err(error) => {
                    log_executor_event(
                        "stand-in cloud project discovery failed",
                        &[("error", error.message)],
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        let mut projects = std::collections::BTreeSet::new();
        projects.extend(
            local
                .into_iter()
                .map(|project| (project.id, "local".to_owned())),
        );
        projects.extend(cloud.iter().filter_map(|project| {
            project["id"]
                .as_str()
                .map(|id| (id.to_owned(), "cloud".to_owned()))
        }));
        for settings in &personal {
            for role in stand_in_identities(settings).iter() {
                for project in role["collaboration"]["projects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if let (Some(id), Some(kind)) =
                        (project["id"].as_str(), project["store"].as_str())
                    {
                        projects.insert((id.to_owned(), kind.to_owned()));
                    }
                }
            }
        }
        Ok(projects
            .into_iter()
            .flat_map(|(id, kind)| self.stand_in_project_configs(&personal, &id, &kind))
            .collect())
    }

    pub(super) fn local_stand_in_projects(&self) -> Result<Vec<Value>, AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let personal = store
            .all_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?;
        Ok(store
            .list_projects()
            .map_err(settings_error)?
            .into_iter()
            .flat_map(|project| self.stand_in_project_configs(&personal, &project.id, "local"))
            .collect())
    }

    pub(super) fn stand_in_project_configs(
        &self,
        personal: &[Value],
        project: &str,
        kind: &str,
    ) -> Vec<Value> {
        let mut configs = Vec::new();
        for settings in personal {
            if settings["executionDeviceId"] != self.device_id {
                continue;
            }
            for role in stand_in_identities(settings).iter() {
                if !role_project_matches(role, project, kind) {
                    continue;
                }
                let config = project_role(
                    role,
                    settings["userId"].as_i64().unwrap_or_default(),
                    project,
                    kind,
                );
                configs.push(config);
            }
        }
        configs
    }

    pub(super) async fn prepare_coordination_text_request(
        &self,
        selected_model: Option<&Value>,
        prompt: String,
        schema: Value,
        task: String,
    ) -> Result<ExecutionRequest, AppIpcError> {
        let catalog = self.runner_catalog().await?;
        let model = selected_model
            .filter(|model| model["runtime"] == "codex")
            .cloned()
            .or_else(|| {
                catalog["models"]
                    .as_array()
                    .and_then(|models| {
                        models.iter().find(|model| {
                            model["runtime"] == "codex" && model["is_default"] == true
                        })
                    })
                    .cloned()
            })
            .ok_or_else(|| {
                AppIpcError::new(
                    "stand_in_grouping_failed",
                    "Choose an available Codex model for message grouping",
                )
            })?;
        let mut payload = json!({"taskId":task,"message":prompt,"runnerPolicy":{"runtime":"codex","execution_policy":{"mode":"fixed","environment_id":self.device_id},"model_policy":{"mode":"user_select"}},"runnerSelection":{"model":model}});
        crate::task_runtime::runner_routing::resolve_pending(
            &mut payload,
            Some(&catalog),
            &self.device_id,
        )
        .map_err(settings_error)?;
        self.materialize_runner_cloud_models(&mut payload).await?;
        let mut request = execution_request(&payload).ok_or_else(|| {
            AppIpcError::new(
                "stand_in_grouping_failed",
                "Cannot prepare message grouping",
            )
        })?;
        request.ephemeral = true;
        request.extra.insert("enable_tools".into(), json!(false));
        request
            .extra
            .insert("runtime_permission_profile".into(), json!(":read-only"));
        request.extra.insert("output_schema".into(), schema);
        self.apply_backend_connection(&mut request);
        Ok(request)
    }
    pub(super) async fn personal_stand_in_settings(
        &self,
        payload: Value,
        save: bool,
    ) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        if save {
            if let Some(route) = payload.get("delegationRoute") {
                return store
                    .save_stand_in_delegation_route(user, &self.device_id, route)
                    .map_err(settings_error);
            }
            let git_settings = self.task_send_gate(&format!("stand-in-git-settings:{user}"));
            let _git_settings = git_settings.lock().await;
            let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
            let _guard = gate.lock().await;
            let previous = store
                .personal_stand_in(user, &self.device_id)
                .map_err(settings_error)?;
            let mut settings = payload["settings"].clone();
            let normalized = store
                .validate_personal_stand_in_settings(user, &self.device_id, settings.clone())
                .map_err(settings_error)?;
            let verified_account = self
                .preflight_dingtalk_delegation(user, &mut settings, &normalized, &previous)
                .await?;
            self.preflight_git_connections(&settings, &previous).await?;
            self.prepare_connection_boundaries(&mut settings, &previous)
                .await?;
            let saved = store
                .save_personal_stand_in_with_verified_dingtalk_account(
                    user,
                    &self.device_id,
                    settings,
                    verified_account.as_ref(),
                )
                .map_err(settings_error)?;
            Ok(saved)
        } else {
            store
                .read_personal_stand_in(user, &self.device_id)
                .map_err(settings_error)
        }
    }

    pub(super) async fn preflight_dingtalk_delegation(
        &self,
        user: i64,
        settings: &mut Value,
        normalized: &Value,
        previous: &Value,
    ) -> Result<Option<Value>, AppIpcError> {
        let primary = &normalized["primary"];
        let before = &previous["primary"];
        let delegation = &primary["delegation"];
        let preparing = settings["primary"]["delegation"]["action"] == "prepare";
        let verify_read = needs_dingtalk_read_preflight(primary, before);
        if preparing || delegation != &before["delegation"] || verify_read {
            self.verify_local_stand_in_owner(user)?;
        }
        if !preparing && !verify_read {
            return Ok(None);
        }
        if !self.stand_in_role_runs_here(primary) {
            return Err(AppIpcError::new(
                "dingtalk_device_mismatch",
                "Select the local executor to configure DingTalk delegation",
            ));
        }
        let mut input = json!({"readiness":true,"profile":delegation["profile"]});
        if verify_read {
            input["sources"] = json!(enabled_dingtalk_sources(primary)
                .map(|source| json!({"id":source["id"],"kind":source["kind"]}))
                .collect::<Vec<_>>());
        }
        let readiness = self
            .connection_call("check", Some(DINGTALK_PROVIDER), input)
            .await?;
        let identity = verified_dingtalk_readiness(&readiness, delegation, verify_read)?;
        if verify_read {
            let selected_model = primary
                .get("model")
                .filter(|model| !model.is_null())
                .unwrap_or(&before["model"]);
            settings["primary"]["model"] = self.preflight_dingtalk_model(selected_model).await?;
        }
        Ok(Some(identity.clone()))
    }

    async fn preflight_dingtalk_model(&self, selection: &Value) -> Result<Value, AppIpcError> {
        let catalog = self.runner_catalog().await?;
        let model = if selection.is_null() {
            unique_native_codex_default(&catalog).unwrap_or(Value::Null)
        } else {
            selection.clone()
        };
        if model["runtime"] != "codex" {
            return Err(AppIpcError::new(
                "dingtalk_model_unavailable",
                "Select an available Codex model for DingTalk delegation",
            ));
        }
        let environment = json!({"mode":"fixed","environment_id":self.device_id});
        let policy = json!({"mode":"fixed","model":model});
        crate::task_runtime::runner_routing::validate_policies(Some(&environment), Some(&policy))
            .map_err(settings_error)?;
        let mut routing = json!({"runnerPolicy":{
            "runtime":"codex","execution_policy":environment,"model_policy":policy
        }});
        crate::task_runtime::runner_routing::resolve_pending(
            &mut routing,
            Some(&catalog),
            &self.device_id,
        )
        .map_err(settings_error)?;
        self.materialize_runner_cloud_models(&mut routing).await?;
        Ok(model)
    }

    pub(super) async fn prepare_connection_boundaries(
        &self,
        settings: &mut Value,
        previous: &Value,
    ) -> Result<(), AppIpcError> {
        self.prepare_connection_boundaries_inner(settings, previous)
            .await
            .map_err(|error| {
                let has_git = stand_in_identities(settings).iter().any(|role| {
                    role["connections"].as_array().into_iter().flatten().any(|source| {
                        source["providerId"].as_str().is_some_and(|provider| {
                            provider.starts_with(super::super::git_connections::PACKAGE)
                        })
                    })
                });
                if has_git {
                    AppIpcError::new("git_connection_save_incomplete", format!("Cloud connection changes may be partially applied; retry this draft or recover existing receivers ({})", error.code))
                } else {
                    error
                }
            })
    }

    async fn prepare_connection_boundaries_inner(
        &self,
        settings: &mut Value,
        previous: &Value,
    ) -> Result<(), AppIpcError> {
        let previous_identities =
            crate::task_runtime::personal_stand_in::stand_in_identities(previous);
        let mut identities = settings["roles"]
            .as_array()
            .cloned()
            .ok_or_else(|| AppIpcError::new("bad_request", "Personal roles must be an array"))?;
        let has_primary = settings["primary"].is_object();
        if has_primary {
            identities.push(settings["primary"].clone());
        }
        let count = identities.len();
        for (index, identity) in identities.iter_mut().enumerate() {
            if !self.stand_in_role_runs_here(identity) {
                continue;
            }
            let id = if has_primary && index + 1 == count {
                json!("@primary")
            } else {
                identity["id"].clone()
            };
            let before = previous_identities.iter().find(|row| row["id"] == id);
            let preserve = before.is_some_and(|row| row["enabled"] == identity["enabled"]);
            let enabled = identity["enabled"] == true;
            for source in identity
                .get_mut("connections")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if crate::task_runtime::personal_stand_in::source_provider(source)
                    != crate::task_runtime::personal_stand_in::EMAIL_PROVIDER
                    && !(crate::task_runtime::personal_stand_in::source_provider(source)
                        .starts_with(super::super::git_connections::PACKAGE)
                        && super::super::git_connections::uses_webhook(source))
                {
                    continue;
                }
                if crate::task_runtime::personal_stand_in::source_provider(source)
                    .starts_with(super::super::git_connections::PACKAGE)
                {
                    self.prepare_git_connection(source).await?;
                }
                let existing = before.and_then(|row| {
                    crate::task_runtime::personal_stand_in::stand_in_collection_connection(
                        row, source,
                    )
                });
                let boundary = existing
                    .filter(|row| {
                        preserve
                            && row["generation"] == source["generation"]
                            && row["subscriptionId"] == source["subscriptionId"]
                    })
                    .map(|row| row["boundary"].clone())
                    .filter(Value::is_object);
                source.as_object_mut().unwrap().remove("boundary");
                if let Some(boundary) = boundary {
                    source["boundary"] = boundary;
                } else if enabled {
                    let boundary = self
                        .connection_call(
                            "initialize",
                            source["providerId"].as_str(),
                            source.clone(),
                        )
                        .await?;
                    if !boundary["partition"].is_string() || !boundary["sequence"].is_u64() {
                        return Err(AppIpcError::new(
                            "connection_response_invalid",
                            "Missing ordered connection boundary",
                        ));
                    }
                    source["boundary"] = boundary;
                }
            }
        }
        if has_primary {
            settings["primary"] = identities.pop().unwrap();
        }
        settings["roles"] = json!(identities);
        Ok(())
    }
}

pub(super) fn matching_personal_roles<'a>(configs: &'a [Value], issue: &Value) -> Vec<&'a Value> {
    configs
        .iter()
        .filter(|role| {
            role["tags"].as_array().map_or(true, Vec::is_empty)
                || role["tags"].as_array().is_some_and(|tags| {
                    tags.iter().any(|tag| {
                        issue["tags"]
                            .as_array()
                            .is_some_and(|tags| tags.contains(tag))
                    })
                })
        })
        .collect()
}

pub(super) fn automatic_assignment_roles<'a>(
    configs: &'a [Value],
    issue: &Value,
) -> Vec<&'a Value> {
    matching_personal_roles(configs, issue)
        .into_iter()
        .filter(|role| dispatch_authorizes_role(role, issue))
        // One automatic assignment selects one role; explicit role dispatch is separate.
        .min_by_key(|role| {
            if role["tags"].as_array().is_some_and(|tags| !tags.is_empty()) {
                0
            } else {
                1
            }
        })
        .into_iter()
        .collect()
}

fn dispatch_authorizes_role(role: &Value, issue: &Value) -> bool {
    let metadata = &issue["metadata"];
    let policy = metadata.get("assistant_autonomy_policy");
    if policy
        .and_then(|value| value.get("automatic"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return false;
    }
    if policy
        .and_then(|value| value.get("ask_before_act"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return false;
    }
    let Some(endpoint) = metadata
        .get("assistant_endpoint_ref")
        .and_then(Value::as_str)
    else {
        return true;
    };
    endpoint
        .rsplit_once(':')
        .map(|(_, role_id)| role["id"].as_str() == Some(role_id))
        .unwrap_or(true)
}

#[cfg(test)]
mod delegation_preflight_tests {
    use super::*;

    #[test]
    fn only_activation_or_widening_requires_read_preflight() {
        let active = json!({
            "enabled": true,
            "delegation": {
                "authorized": true, "paused": false, "profile": "org:user", "accountId": "account",
                "templates": {"document": true, "schedule": false, "process": true}
            },
            "connections": [{
                "providerId": DINGTALK_PROVIDER, "delegated": true, "paused": false,
                "profile": "org:user", "kind": "group", "id": "selected"
            }]
        });
        let mut draft = active.clone();
        draft["delegation"]["paused"] = json!(true);
        assert!(!needs_dingtalk_read_preflight(&draft, &active));
        assert!(needs_dingtalk_read_preflight(&active, &draft));
        draft = active.clone();
        draft["delegation"]["templates"]["document"] = json!(false);
        assert!(!needs_dingtalk_read_preflight(&draft, &active));
        draft["delegation"]["templates"]["schedule"] = json!(true);
        assert!(needs_dingtalk_read_preflight(&draft, &active));
        draft = active.clone();
        draft["connections"][0]["id"] = json!("another");
        assert!(needs_dingtalk_read_preflight(&draft, &active));
    }

    #[test]
    fn account_verification_does_not_supply_message_access() {
        let account = json!({"profile":"org:user","accountId":"account","organizationId":"org"});
        let mut readiness =
            json!({"status":"ready","identity":account,"permissions":{"read":"unchecked"}});
        assert!(verified_dingtalk_readiness(&readiness, &account, false).is_ok());
        assert_eq!(
            verified_dingtalk_readiness(&readiness, &account, true)
                .unwrap_err()
                .code,
            "dingtalk_not_ready"
        );
        readiness["permissions"]["read"] = json!("verified");
        assert!(verified_dingtalk_readiness(&readiness, &account, true).is_ok());
        readiness["identity"]["organizationId"] = json!("other");
        assert_eq!(
            verified_dingtalk_readiness(&readiness, &account, true)
                .unwrap_err()
                .code,
            "dingtalk_identity_changed"
        );
    }
}

#[cfg(test)]
mod automatic_role_selection_tests {
    use super::*;

    #[test]
    fn one_assignment_selects_one_role_with_specific_tags_before_general_roles() {
        let roles = vec![
            json!({"id":"general"}),
            json!({"id":"review","tags":["review"]}),
            json!({"id":"second","tags":["review"]}),
        ];
        assert_eq!(
            automatic_assignment_roles(&roles, &json!({"tags":["review"]}))[0]["id"],
            "review"
        );
        assert_eq!(automatic_assignment_roles(&roles, &json!({})).len(), 1);
        assert_eq!(
            automatic_assignment_roles(&roles, &json!({}))[0]["id"],
            "general"
        );
        assert!(automatic_assignment_roles(&roles[1..], &json!({"tags":["other"]})).is_empty());
    }

    #[test]
    fn dispatch_limits_automatic_intake_to_the_authorized_roster_endpoint_and_policy() {
        let roles = vec![json!({"id":"review"}), json!({"id":"general"})];
        let issue = json!({
            "metadata": {
                "assistant_endpoint_ref": "local_wework:7:review",
                    "assistant_autonomy_policy": {"automatic": true, "ask_before_act": false}
            }
        });
        assert_eq!(
            automatic_assignment_roles(&roles, &issue)[0]["id"],
            "review"
        );
        assert!(automatic_assignment_roles(
            &roles,
            &json!({
                "metadata": {
                    "assistant_endpoint_ref": "local_wework:7:review",
                    "assistant_autonomy_policy": {"automatic": false, "ask_before_act": false}
                }
            })
        )
        .is_empty());
        assert!(automatic_assignment_roles(
            &roles,
            &json!({
                "metadata": {
                    "assistant_endpoint_ref": "local_wework:7:review",
                    "assistant_autonomy_policy": {"automatic": true, "ask_before_act": true}
                }
            })
        )
        .is_empty());
    }
}
