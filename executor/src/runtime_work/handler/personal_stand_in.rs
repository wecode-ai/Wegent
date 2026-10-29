//! Personal settings are owned by the selected Executor, independent of project membership.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::personal_stand_in::{
    project_role, role_project_matches, stand_in_identities,
};

impl RuntimeWorkRpcHandler {
    pub(super) async fn personal_stand_in_agents(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        self.verify_stand_in_user(&payload).await?;
        let resources = self
            .stand_in_http(reqwest::Method::GET, "/v1/resources", None)
            .await?;
        let items: Vec<Value> = resources["agents"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|agent| {
                agent["owner_type"] == "user"
                    && agent["owner_id"].as_str()
                        == payload["userId"]
                            .as_i64()
                            .map(|id| id.to_string())
                            .as_deref()
                    && agent["status"] == "available"
            })
            .map(|agent| json!({"id":agent["team_id"],"name":agent["name"]}))
            .collect();
        Ok(json!({"items":items}))
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
                .stand_in_http(reqwest::Method::GET, "/v1/cloud-projects", None)
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

    pub(super) async fn stand_in_text_decision(
        &self,
        selected_model: Option<&Value>,
        prompt: String,
        schema: Value,
    ) -> Result<Value, AppIpcError> {
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
        let mut payload = json!({"taskId":format!("stand-in-grouping-{}",uuid::Uuid::new_v4()),"message":prompt,"runnerPolicy":{"runtime":"codex","execution_policy":{"mode":"fixed","environment_id":self.device_id},"model_policy":{"mode":"user_select"}},"runnerSelection":{"model":model}});
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
        let response = tokio::time::timeout(
            Duration::from_secs(60),
            self.generate_text(json!({"executionRequest":request})),
        )
        .await
        .map_err(|_| {
            AppIpcError::new("stand_in_grouping_failed", "Message grouping timed out")
        })??;
        serde_json::from_str(response["content"].as_str().unwrap_or_default()).map_err(|_| {
            AppIpcError::new(
                "stand_in_grouping_failed",
                "The model returned an invalid message grouping",
            )
        })
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
            store
                .save_personal_stand_in(user, &self.device_id, payload["settings"].clone())
                .map_err(settings_error)
        } else {
            store
                .personal_stand_in(user, &self.device_id)
                .map_err(settings_error)
        }
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
