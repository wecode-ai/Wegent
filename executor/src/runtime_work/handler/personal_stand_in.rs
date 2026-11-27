//! Personal settings are owned by the selected Executor, independent of project membership.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::personal_stand_in::{
    collaboration_scope_tags, project_role, role_project_matches,
    role_receives_participating_issues, stand_in_connection, stand_in_identities,
    IssueIntakeTrigger, VerifiedPersonalSettings, DINGTALK_PROVIDER,
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

pub(super) fn issue_role_config(
    role: &Value,
    user: i64,
    project: &str,
    kind: &str,
    participant: bool,
    trigger: Option<IssueIntakeTrigger>,
) -> Option<Value> {
    let allows = |scope| trigger.map_or(true, |trigger| trigger.matches(role, scope));
    let project_matches = role_project_matches(role, project, kind) && allows("projectTrigger");
    let participation = participant
        && role_receives_participating_issues(role)
        && allows("participatingTrigger")
        && role["participatingIssuesEnabledAfter"].is_string();
    if !project_matches && !participation {
        return None;
    }
    let mut config = project_role(role, user, project, kind);
    let boundary = |scope: &str, base: &'_ Value| {
        let added =
            trigger.and_then(|event| role["issueTriggerBoundaries"][scope][event.key()].as_str());
        base.as_str()
            .into_iter()
            .chain(added)
            .max()
            .map(str::to_owned)
    };
    let project_since = project_matches
        .then(|| boundary("projectTrigger", &config["enabledAfter"]))
        .flatten();
    let participation_since = participation
        .then(|| {
            boundary(
                "participatingTrigger",
                &role["participatingIssuesEnabledAfter"],
            )
        })
        .flatten();
    if role["collaboration"]["tagFilters"].is_object()
        || role["collaboration"]["projectTagFilters"].is_array()
    {
        let scopes = [
            (project_matches, &config["tags"], &project_since),
            (
                participation,
                collaboration_scope_tags(role, "participating"),
                &participation_since,
            ),
        ]
        .into_iter()
        .filter(|(matched, _, _)| *matched)
        .map(|(_, tags, enabled_after)| json!({"tags": tags, "enabledAfter": enabled_after}))
        .collect::<Vec<_>>();
        config["issueScopeTags"] = json!(scopes);
    }
    if let Some(since) = project_since.into_iter().chain(participation_since).min() {
        config["enabledAfter"] = json!(since);
    }
    Some(config)
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn issue_intake_roles(
        &self,
        roles: &[Value],
        user: i64,
        project: &str,
        kind: &str,
        issue_id: &str,
        trigger: Option<IssueIntakeTrigger>,
    ) -> Result<Vec<Value>, AppIpcError> {
        let participant = if roles.iter().any(|role| {
            role_receives_participating_issues(role)
                && trigger.map_or(true, |event| event.matches(role, "participatingTrigger"))
        }) {
            if kind == "local" {
                let store =
                    LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
                store
                    .participating_issue_ids(project, &[0, user])
                    .map_err(settings_error)?
                    .contains(issue_id)
            } else {
                self.verify_runtime_user(&json!({"userId":user})).await?;
                let members = self
                    .runtime_http(
                        reqwest::Method::GET,
                        &format!("/v1/loop-items/{issue_id}/collaborators"),
                        None,
                    )
                    .await?;
                members
                    .as_array()
                    .ok_or_else(|| {
                        AppIpcError::new(
                            "cloud_response_invalid",
                            "Issue participants are not a list",
                        )
                    })?
                    .iter()
                    .any(|row| row["user_id"] == user)
            }
        } else {
            false
        };
        Ok(roles
            .iter()
            .filter_map(|role| issue_role_config(role, user, project, kind, participant, trigger))
            .collect())
    }

    pub(super) async fn cloud_issue_intake_configs(
        &self,
        settings: &[Value],
        user: i64,
        project: &str,
        issue_id: &str,
        trigger: IssueIntakeTrigger,
    ) -> Result<Vec<Value>, AppIpcError> {
        let roles = settings
            .iter()
            .filter(|settings| {
                settings["userId"] == user
                    && settings["executionDeviceId"] == self.device_id
                    && settings["lifecycle"]["status"].is_null()
            })
            .flat_map(stand_in_identities)
            .collect::<Vec<_>>();
        self.issue_intake_roles(&roles, user, project, "cloud", issue_id, Some(trigger))
            .await
    }

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
            .flat_map(|project| {
                personal
                    .iter()
                    .filter(|settings| settings["executionDeviceId"] == self.device_id)
                    .flat_map(stand_in_identities)
                    .filter(|role| {
                        role_project_matches(role, &project.id, "local")
                            || role_receives_participating_issues(role)
                    })
                    .map(|role| {
                        project_role(
                            &role,
                            role["userId"].as_i64().unwrap_or_default(),
                            &project.id,
                            "local",
                        )
                    })
                    .collect::<Vec<_>>()
            })
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
    pub(super) async fn stand_in_share_definition(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(&payload)?;
        self.verify_runtime_user(&payload).await?;
        let kind = super::stand_in_tasks::required(&payload, "kind")?;
        let id = super::stand_in_tasks::required(&payload, "id")?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let settings = store
            .read_personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        let definition =
            crate::task_runtime::personal_stand_in::assistant_share_definition(&settings, kind, id)
                .ok_or_else(|| {
                    AppIpcError::new(
                        "not_found",
                        "Assistant or team is unavailable on this device",
                    )
                })?;
        Ok(json!(definition))
    }

    pub(super) async fn copy_stand_in_share(&self, payload: Value) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(&payload)?;
        let connection = self.require_runtime_connection()?;
        if Self::connected_runtime_user(&connection).await? != user {
            return Err(AppIpcError::new(
                "permission_denied",
                "Share recipient must match the connected account",
            ));
        }
        let owner = payload["ownerUserId"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "Share owner is required"))?;
        let (kind, source) = assistant_share_ref(&payload)?;
        let share = Self::assistant_share_request_on(
            &connection,
            reqwest::Method::GET,
            &format!("/v1/assistant-shares/{owner}/{kind}/{source}/snapshot/copy"),
            None,
        )
        .await?;
        let snapshot = serde_json::from_value::<
            wegent_protocol::assistant_share::AssistantShareSnapshot,
        >(share)
        .map_err(|_| AppIpcError::new("server_error", "Invalid assistant share snapshot"))?;
        if i64::from(snapshot.owner_user_id) != owner
            || snapshot.root.definition.key() != (kind, source)
        {
            return Err(AppIpcError::new(
                "server_error",
                "Assistant share identity mismatch",
            ));
        }
        if payload["expectedRevision"]
            .as_u64()
            .is_some_and(|version| version != snapshot.root.revision)
        {
            return Err(AppIpcError::new(
                "version_conflict",
                "Review the latest shared version before copying",
            ));
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        store
            .copy_assistant_share(
                user,
                &self.device_id,
                &connection.backend_url,
                &snapshot,
                payload["update"] == true,
            )
            .map_err(settings_error)
    }

    pub(super) async fn share_stand_in_cloud(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(&payload)?;
        let connection = self.require_runtime_connection()?;
        if Self::connected_runtime_user(&connection).await? != user {
            return Err(AppIpcError::new(
                "permission_denied",
                "Share account must match the connected account",
            ));
        }
        use reqwest::Method;
        match method {
            "runtime.stand_in.share.list" => {
                let mut response =
                    Self::runtime_http_on(&connection, Method::GET, "/v1/assistant-shares", None)
                        .await?;
                let store =
                    LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
                let settings = store
                    .read_personal_stand_in(user, &self.device_id)
                    .map_err(settings_error)?;
                for entry in response["received"].as_array_mut().into_iter().flatten() {
                    let revision = entry["owner_user_id"]
                        .as_i64()
                        .and_then(|owner| i32::try_from(owner).ok())
                        .and_then(|owner| {
                            crate::task_runtime::personal_stand_in::assistant_share_copy_revision(
                                &settings,
                                &connection.backend_url,
                                owner,
                                entry["resource_kind"].as_str()?,
                                entry["source_id"].as_str()?,
                            )
                        });
                    entry["local_revision"] = json!(revision);
                }
                Ok(response)
            }
            "runtime.stand_in.share.search_users" => {
                let query = super::stand_in_tasks::required(&payload, "query")?;
                let query = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("q", query)
                    .append_pair("limit", "20")
                    .finish();
                Self::runtime_http_on(
                    &connection,
                    Method::GET,
                    &format!("/users/search?{query}"),
                    None,
                )
                .await
            }
            "runtime.stand_in.share.publish" => {
                Self::runtime_http_on(
                    &connection,
                    Method::POST,
                    "/v1/assistant-shares",
                    Some(&payload["share"]),
                )
                .await
            }
            "runtime.stand_in.share.direct" => {
                let (kind, source) = assistant_share_ref(&payload)?;
                let owner = payload["ownerUserId"]
                    .as_i64()
                    .filter(|id| *id > 0)
                    .ok_or_else(|| AppIpcError::new("bad_request", "Share owner is required"))?;
                Self::assistant_share_request_on(
                    &connection,
                    Method::PATCH,
                    &format!("/v1/assistant-shares/{owner}/{kind}/{source}"),
                    Some(&json!({"enabled":true})),
                )
                .await
            }
            "runtime.stand_in.share.revoke" => {
                let (kind, source) = assistant_share_ref(&payload)?;
                let recipient = payload["recipientUserId"]
                    .as_i64()
                    .filter(|id| *id > 0)
                    .ok_or_else(|| {
                        AppIpcError::new("bad_request", "Share recipient is required")
                    })?;
                Self::runtime_http_on(
                    &connection,
                    Method::DELETE,
                    &format!("/v1/assistant-shares/{kind}/{source}/recipients/{recipient}"),
                    None,
                )
                .await
            }
            _ => Err(AppIpcError::new(
                "bad_request",
                "Unknown assistant share operation",
            )),
        }
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
        let workspace_owner = self
            .backend_connection_snapshot()?
            .as_ref()
            .and_then(|c| c.authenticated_user_id)
            == Some(user);
        if save {
            if let Some(route) = payload.get("delegationRoute") {
                if payload.get("transferRoleId").is_some() {
                    return Err(AppIpcError::new(
                        "bad_request",
                        "A role transfer cannot save a delegation route",
                    ));
                }
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
            if let Some(fields) = settings.as_object_mut() {
                fields.remove("transferredTeamDefinition");
                fields.remove("portableTeam");
            }
            if let Some(transfer) = payload.get("transferRoleId") {
                let invalid =
                    || AppIpcError::new("bad_request", "Invalid transferred stand-in role");
                let id = transfer
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(invalid)?;
                let role = settings["roles"]
                    .as_array_mut()
                    .and_then(|roles| roles.iter_mut().find(|role| role["id"] == id))
                    .filter(|role| {
                        role["migrationSource"]
                            .as_str()
                            .is_some_and(|source| !source.is_empty())
                            && self.stand_in_role_runs_here(role)
                    })
                    .and_then(Value::as_object_mut)
                    .ok_or_else(invalid)?;
                role.remove("taskPermissions");
                if let Some(definition) = payload.get("portableTeam") {
                    self.verify_local_stand_in_owner(user)?;
                    role.remove("teamRef");
                    settings["transferredTeamDefinition"] =
                        json!({"roleId":id,"definition":definition});
                }
            }
            let owned_team = payload.get("ownedTeam");
            if owned_team.is_some() {
                self.verify_local_stand_in_owner(user)?;
                if user != 0 && !workspace_owner {
                    return Err(AppIpcError::new(
                        "permission_denied",
                        "Connect the Team owner account to configure local grants",
                    ));
                }
                if payload.get("transferRoleId").is_some() {
                    return Err(AppIpcError::new(
                        "bad_request",
                        "Configure local grants after the Team transfer",
                    ));
                }
            }
            let normalized = store
                .validate_personal_settings_for_device_owner(
                    user,
                    &self.device_id,
                    settings.clone(),
                    workspace_owner,
                )
                .map_err(settings_error)?;
            let verified_account = self
                .preflight_dingtalk_delegation(user, &mut settings, &normalized, &previous)
                .await?;
            self.preflight_git_connections(&settings, &previous).await?;
            self.prepare_connection_boundaries(&mut settings, &previous)
                .await?;
            let connection = self.backend_connection_snapshot()?;
            let saved = store
                .save_verified_personal_settings(
                    user,
                    &self.device_id,
                    connection.as_ref().map(|entry| entry.backend_url.as_str()),
                    settings,
                    VerifiedPersonalSettings {
                        account: verified_account.as_ref(),
                        workspace_owner,
                        owned_team,
                    },
                )
                .map_err(settings_error)?;
            Ok(saved)
        } else {
            let mut settings = store
                .read_personal_stand_in(user, &self.device_id)
                .map_err(settings_error)?;
            settings["teamImportVersion"] = json!(1);
            if let Some(role_id) = payload["exportTeamRoleId"].as_str() {
                // A stopped installation-local identity can migrate to its connected account.
                let stopped_local_source =
                    user == 0 && settings["lifecycle"]["status"] == "stopped" && {
                        let binding = store
                            .stand_in_binding("get", -1, Value::Null)
                            .map_err(settings_error)?;
                        binding["status"] == "stopped"
                            && binding["target"]["userId"] == 0
                            && binding["target"]["deviceId"].as_str()
                                == Some(self.device_id.as_str())
                    };
                if !stopped_local_source {
                    self.verify_local_stand_in_owner(user)?;
                }
                settings["portableTeam"] = store
                    .portable_personal_team(user, &self.device_id, role_id)
                    .map_err(settings_error)?;
            }
            if payload["includeTeams"] == true {
                self.verify_local_stand_in_owner(user)?;
                settings["bindableTeams"] = json!(store
                    .bindable_personal_teams(user, workspace_owner)
                    .map_err(settings_error)?);
            }
            Ok(settings)
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
        if primary["dingTalkConnectionMode"] == "confirmed" {
            return Ok(None);
        }
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
        .filter(|role| match role["issueScopeTags"].as_array() {
            Some(scopes) => scopes.iter().any(|scope| issue_tags_match(scope, issue)),
            None => issue_tags_match(role, issue),
        })
        .collect()
}

pub(super) fn issue_tags_match(config: &Value, issue: &Value) -> bool {
    config["tags"].as_array().map_or(true, |wanted| {
        wanted.is_empty()
            || issue["tags"]
                .as_array()
                .is_some_and(|actual| wanted.iter().any(|tag| actual.contains(tag)))
    })
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
            let tagged = |scope: &Value| {
                scope["tags"]
                    .as_array()
                    .is_some_and(|tags| !tags.is_empty())
                    && issue_tags_match(scope, issue)
            };
            if role["issueScopeTags"]
                .as_array()
                .map_or_else(|| tagged(role), |scopes| scopes.iter().any(tagged))
            {
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

fn assistant_share_ref(payload: &Value) -> Result<(&str, &str), AppIpcError> {
    let kind = super::stand_in_tasks::required(payload, "kind")?;
    let source = super::stand_in_tasks::required(payload, "id")?;
    if !matches!(kind, "assistant" | "team")
        || source.len() > 64
        || !source
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"@-_".contains(&byte))
    {
        return Err(AppIpcError::new(
            "bad_request",
            "Invalid assistant share reference",
        ));
    }
    Ok((kind, source))
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
