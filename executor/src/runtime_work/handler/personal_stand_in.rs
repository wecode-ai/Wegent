//! Personal settings are owned by the selected Executor, independent of project membership.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::personal_stand_in::{
    project_role, role_project_matches, stand_in_identities,
};

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
            let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
            let _guard = gate.lock().await;
            let previous = store
                .personal_stand_in(user, &self.device_id)
                .map_err(settings_error)?;
            let mut settings = payload["settings"].clone();
            store
                .validate_personal_stand_in_settings(user, &self.device_id, settings.clone())
                .map_err(settings_error)?;
            self.preflight_git_connections(&settings, &previous).await?;
            self.prepare_connection_boundaries(&mut settings, &previous)
                .await?;
            let saved = store
                .save_personal_stand_in(user, &self.device_id, settings)
                .map_err(settings_error)?;
            Ok(saved)
        } else {
            store
                .personal_stand_in(user, &self.device_id)
                .map_err(settings_error)
        }
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
}
