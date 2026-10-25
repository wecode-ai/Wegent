//! Resolve personal resource references and enforce their execution policies at dispatch time.
use super::stand_in::settings_error;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn stand_in_agent(
        &self,
        config: &Value,
    ) -> Result<Option<Value>, AppIpcError> {
        if let Some(id) = config["agentResourceId"].as_i64() {
            let allowed = self
                .personal_stand_in_agents(json!({"userId":config["userId"]}))
                .await?;
            if !allowed["items"]
                .as_array()
                .is_some_and(|agents| agents.iter().any(|agent| agent["id"] == id))
            {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "The personal agent is no longer available to this user",
                ));
            }
            let team = self
                .stand_in_http(reqwest::Method::GET, &format!("/teams/{id}"), None)
                .await?;
            let entries = team["bots"].as_array().ok_or_else(|| {
                AppIpcError::new("agent_unavailable", "The personal agent has no bots")
            })?;
            let entry = entries
                .iter()
                .find(|entry| entry["role"] == "leader")
                .or_else(|| entries.first())
                .ok_or_else(|| {
                    AppIpcError::new("agent_unavailable", "The personal agent is empty")
                })?;
            let bot = &entry["bot"];
            let runtime = match bot["shell_name"].as_str() {
                Some("Codex") => "codex",
                Some("ClaudeCode") => "claude_code",
                _ => {
                    return Err(AppIpcError::new(
                        "unsupported_runtime",
                        "Choose a Codex or Claude Code agent",
                    ))
                }
            };
            if team["is_active"] == false {
                return Err(AppIpcError::new(
                    "agent_unavailable",
                    "The personal agent is inactive",
                ));
            }
            let agent = json!({"id":id.to_string(),"name":team["displayName"].as_str().unwrap_or_else(|| team["name"].as_str().unwrap_or("Agent")),
                "runtime":runtime,"execution_policy":bot["execution_policy"],
                "model_policy":bot["model_policy"],
                "system_prompt":bot["system_prompt"].as_str().unwrap_or_default(),
                "additional_skills":bot["skills"].as_array().cloned().unwrap_or_default(),
                "plugins":bot["plugins"].as_array().cloned().unwrap_or_default(),
                "mcp_servers":bot["mcp_servers"].as_object().cloned().unwrap_or_default()});
            return self.normalize_stand_in_agent(agent).await.map(Some);
        }
        let Some(id) = config["agentId"].as_str().filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let project = config["projectId"].as_str().unwrap_or_default();
        if config["agentProject"].is_object()
            && (config["agentProject"]["id"] != config["projectId"]
                || config["agentProject"]["store"] != config["projectStore"])
        {
            return Err(AppIpcError::new(
                "agent_project_mismatch",
                "This role handles tasks only in the selected agent's project",
            ));
        }
        let rows = if config["projectStore"] == "local" {
            let agents = LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(settings_error)?
                .list_chat_agents(project)
                .map_err(settings_error)?;
            serde_json::to_value(agents)
                .map_err(|error| AppIpcError::new("invalid_agent", error.to_string()))?
        } else {
            self.stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/cloud-projects/{project}/chat-agents"),
                None,
            )
            .await?
        };
        let rows = if config["projectStore"] == "cloud" {
            json!(rows.as_array().into_iter().flatten().map(|row| json!({
                "id":row["id"],"name":row["name"],"runtime":row["runtime"],"status":row["status"],"can_use":row["canUse"],
                "execution_policy":row["executionPolicy"],"model_policy":row["modelPolicy"],"system_prompt":row["systemPrompt"],
                "additional_skills":row["additionalSkills"],"plugins":row["plugins"],"mcp_servers":row["mcpServers"]
            })).collect::<Vec<_>>())
        } else {
            rows
        };
        let agent = rows
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == id && row["status"] == "active" && row["can_use"] != false)
            .ok_or_else(|| {
                AppIpcError::new(
                    "agent_unavailable",
                    "The selected agent is unavailable in this project",
                )
            })?;
        self.normalize_stand_in_agent(agent.clone()).await.map(Some)
    }

    async fn normalize_stand_in_agent(&self, mut agent: Value) -> Result<Value, AppIpcError> {
        if !matches!(agent["runtime"].as_str(), Some("codex" | "claude_code")) {
            return Err(AppIpcError::new(
                "unsupported_runtime",
                "Choose a Codex or Claude Code agent",
            ));
        }
        if !agent["execution_policy"].is_object() || !agent["model_policy"].is_object() {
            return Err(AppIpcError::new(
                "agent_configuration_required",
                "Configure the agent environment and model before enabling Stand-in",
            ));
        }
        if agent["execution_policy"]["mode"] == "fixed"
            && agent["execution_policy"]["environment_id"] != self.device_id
        {
            // Cloud policies identify a Device resource; local routing uses its Executor id.
            let devices = self
                .stand_in_http(reqwest::Method::GET, "/devices/online", None)
                .await?;
            let matches = devices["items"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|device| {
                    device["id"].to_string().trim_matches('"')
                        == agent["execution_policy"]["environment_id"]
                            .to_string()
                            .trim_matches('"')
                        && ["device_id", "app_device_id"]
                            .iter()
                            .any(|key| device[key] == self.device_id)
                });
            if !matches {
                return Err(AppIpcError::new(
                    "agent_device_conflict",
                    "The selected agent requires another device",
                ));
            }
            agent["execution_policy"]["environment_id"] = json!(self.device_id);
        }
        Ok(agent)
    }
}

pub(super) fn apply_stand_in_agent(
    payload: &mut Value,
    agent: &Value,
    catalog: &Value,
    device: &str,
    selected_model: Option<&Value>,
) -> Result<(), AppIpcError> {
    if let Some(model) = selected_model {
        let fixed = &agent["model_policy"];
        if fixed["mode"] == "fixed"
            && ["runtime", "provider", "model_id", "cloud_model"]
                .iter()
                .any(|key| model[*key] != fixed["model"][*key])
        {
            return Err(AppIpcError::new(
                "agent_model_conflict",
                "The selected agent requires its fixed model",
            ));
        }
    }
    let runtime = agent["runtime"].as_str().unwrap_or("codex");
    let default_model = catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|model| model["runtime"] == runtime && model["is_default"] == true)
        .cloned()
        .unwrap_or(Value::Null);
    payload["runtime"] = json!(runtime);
    payload["runnerPolicy"] = json!({"runtime":runtime,"execution_policy":agent["execution_policy"],"model_policy":agent["model_policy"]});
    payload["runnerSelection"] = json!({"execution_policy":{"mode":"fixed","environment_id":device},"model":selected_model.unwrap_or(&default_model)});
    payload["projectInstructions"] = agent["system_prompt"].clone();
    payload["additionalSkills"] = agent["additional_skills"].clone();
    payload["projectPlugins"] = agent["plugins"].clone();
    payload["bot"] = json!([{"id":agent["id"],"name":agent["name"],"shell_type":if runtime == "claude_code" {"ClaudeCode"} else {"Codex"},"mcp_servers":agent["mcp_servers"]}]);
    crate::task_runtime::runner_routing::resolve_pending(payload, Some(catalog), device)
        .map_err(settings_error)
}
