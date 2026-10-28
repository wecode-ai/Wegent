//! Model credentials enter only through the authenticated desktop IPC channel.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(in super::super) fn sync_creation_model_profiles(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let profiles = payload["profiles"]
            .as_array()
            .ok_or_else(|| creation_error("Model profiles must be an array"))?;
        let mut identities = HashSet::new();
        for profile in profiles {
            let runtime = profile["runtime"].as_str().unwrap_or_default();
            let name = profile["modelName"].as_str().unwrap_or_default();
            if !matches!(runtime, "codex" | "claude_code")
                || name.trim().is_empty()
                || !profile["modelConfig"].is_object()
                || !identities.insert((runtime, name))
            {
                return Err(creation_error(
                    "Invalid or duplicate creation model profile",
                ));
            }
        }
        *self
            .creation_model_profiles
            .lock()
            .map_err(|_| creation_error("Model registry unavailable"))? = profiles.clone();
        Ok(json!({"success":true,"count":profiles.len()}))
    }

    pub(in super::super) fn creation_profile_catalog(&self) -> Vec<Value> {
        self.creation_model_profiles
            .lock()
            .map(|profiles| {
                profiles.iter().map(|profile| json!({
            "runtime":profile["runtime"],"modelName":profile["modelName"],"modelType":"runtime",
            "label":profile["label"],"source":"model_interface"
        })).collect()
            })
            .unwrap_or_default()
    }

    pub(super) async fn creation_model_config(
        &self,
        runtime: &str,
        selection: &Value,
        inherited: &Value,
    ) -> Result<Value, AppIpcError> {
        let name = selection["modelName"]
            .as_str()
            .ok_or_else(|| creation_error("Model name is required"))?;
        let model_type = selection["modelType"].as_str().unwrap_or("runtime");
        if ["public", "user", "group"].contains(&model_type) {
            let options = &selection["options"];
            let owner = &options["weworkCloudModelResourceUserId"];
            let owner = owner
                .as_u64()
                .or_else(|| owner.as_str().and_then(|value| value.parse().ok()))
                .ok_or_else(|| creation_error("Cloud model owner is required"))?;
            let namespace = options["weworkCloudModelNamespace"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| creation_error("Cloud model namespace is required"))?;
            if inherited["model_id"] == name
                && inherited.pointer("/default_headers/X-Wegent-Model-Type")
                    == Some(&json!(model_type))
                && inherited.pointer("/default_headers/X-Wegent-Model-Namespace")
                    == Some(&json!(namespace))
                && inherited.pointer("/default_headers/X-Wegent-Model-User-Id")
                    == Some(&json!(owner.to_string()))
            {
                return Ok(inherited.clone());
            }
            let mut payload = json!({"runnerRouting":{"model":{"runtime":runtime,"source":"cloud","cloud_model":{
                "name":name,"type":model_type,"namespace":namespace,"resource_user_id":owner}}},"executionRequest":{"model_config":{}}});
            self.materialize_runner_cloud_models(&mut payload).await?;
            return Ok(payload["executionRequest"]["model_config"].clone());
        }
        if model_type != "runtime" {
            return Err(creation_error("Unsupported model type"));
        }
        if let Some(config) = self
            .creation_model_profiles
            .lock()
            .map_err(|_| creation_error("Model registry unavailable"))?
            .iter()
            .find(|profile| profile["runtime"] == runtime && profile["modelName"] == name)
            .map(|profile| profile["modelConfig"].clone())
        {
            return Ok(config);
        }
        let catalog = self.runner_catalog().await?;
        let provider = selection
            .pointer("/options/runnerModelProvider")
            .or_else(|| selection.pointer("/options/codexProviderId"))
            .and_then(Value::as_str);
        let models = catalog["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|model| {
                model["runtime"] == runtime
                    && model["model_id"] == name
                    && provider.is_none_or(|provider| model["provider"] == provider)
            })
            .collect::<Vec<_>>();
        if models.len() != 1 {
            return Err(creation_error(if models.len() > 1 {
                "Model provider is ambiguous; select an exact provider"
            } else {
                "Selected model is unavailable on this device; refresh the Wework model catalog"
            }));
        }
        Ok(
            json!({"model_id":name,"model_provider":models[0]["provider"],
            "runtime_config":{"codex":{"use_user_config":true,"configured":true}}}),
        )
    }
}
