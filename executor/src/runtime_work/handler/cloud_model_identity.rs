// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) struct CloudModelIdentity {
    pub name: String,
    pub model_type: String,
    pub namespace: String,
    pub resource_user_id: String,
    pub upstream_api_format: String,
}

impl CloudModelIdentity {
    pub fn from_request(request: &ExecutionRequest) -> Result<Option<Self>, String> {
        let Some(selection) = request
            .extra
            .get("modelSelection")
            .or_else(|| request.extra.get("model_selection"))
            .filter(|value| value.is_object())
        else {
            return Ok(None);
        };
        Self::from_selection(selection)
    }

    fn from_selection(selection: &Value) -> Result<Option<Self>, String> {
        let model_type = string_field(selection, "modelType")
            .or_else(|| string_field(selection, "model_type"))
            .unwrap_or_default();
        if !matches!(model_type.as_str(), "public" | "user" | "group") {
            return Ok(None);
        }
        let name = string_field(selection, "modelName")
            .or_else(|| string_field(selection, "model_name"))
            .or_else(|| string_field(selection, "model"))
            .ok_or_else(|| "cloud model name is required".to_owned())?;
        let options = selection
            .get("options")
            .and_then(Value::as_object)
            .ok_or_else(|| "cloud model options are required".to_owned())?;
        let namespace = required_option(options, "weworkCloudModelNamespace", "namespace")?;
        let owner = required_option(
            options,
            "weworkCloudModelResourceUserId",
            "resource user ID",
        )?;
        let resource_user_id = owner
            .parse::<i64>()
            .ok()
            .filter(|value| *value >= 0)
            .map(|value| value.to_string())
            .ok_or_else(|| {
                "cloud model resource user ID must be a non-negative integer".to_owned()
            })?;
        let upstream_api_format = options
            .get("weworkCloudModelUpstreamApiFormat")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("openai-responses")
            .to_owned();
        Ok(Some(Self {
            name,
            model_type,
            namespace,
            resource_user_id,
            upstream_api_format,
        }))
    }

    pub fn vision_sidecar_from_request(request: &ExecutionRequest) -> Result<Option<Self>, String> {
        let Some(raw) = request
            .extra
            .get("modelSelection")
            .or_else(|| request.extra.get("model_selection"))
            .and_then(|selection| selection.get("options"))
            .and_then(|options| options.get("weworkCloudVisionSidecar"))
        else {
            return Ok(None);
        };
        let reference: Value =
            serde_json::from_str(raw.as_str().ok_or_else(|| {
                "cloud vision sidecar reference must be a JSON string".to_owned()
            })?)
            .map_err(|_| "cloud vision sidecar reference is invalid".to_owned())?;
        let api_format = string_field(&reference, "apiFormat")
            .ok_or_else(|| "cloud vision sidecar API format is required".to_owned())?;
        if !matches!(
            api_format.as_str(),
            "openai-responses" | "openai-chat-completions" | "anthropic-messages"
        ) {
            return Err("cloud vision sidecar API format is invalid".to_owned());
        }
        let owner = reference
            .get("resourceUserId")
            .and_then(Value::as_u64)
            .ok_or_else(|| "cloud vision sidecar resource user ID is invalid".to_owned())?;
        Self::from_selection(&json!({
            "modelName": reference.get("modelName"), "modelType": reference.get("modelType"),
            "options": {"weworkCloudModelNamespace": reference.get("namespace"),
                "weworkCloudModelResourceUserId": owner.to_string(),
                "weworkCloudModelUpstreamApiFormat": api_format},
        }))?
        .map(Some)
        .ok_or_else(|| "cloud vision sidecar model type is invalid".to_owned())
    }

    pub fn apply_headers(
        &self,
        headers: &mut Map<String, Value>,
        executor: &str,
        source: &str,
        task_id: &str,
    ) {
        for (key, value) in [
            ("X-Wegent-Model-Type", self.model_type.as_str()),
            ("X-Wegent-Model-Namespace", self.namespace.as_str()),
            ("X-Wegent-Model-User-Id", self.resource_user_id.as_str()),
            ("X-Wegent-Upstream-Header-wecode-executor", executor),
            ("X-Wegent-Upstream-Header-wecode-source", source),
        ] {
            headers.insert(key.to_owned(), Value::String(value.to_owned()));
        }
        if !task_id.trim().is_empty() {
            headers.insert(
                "X-Wegent-Upstream-Header-wecode-session-id".to_owned(),
                Value::String(task_id.trim().to_owned()),
            );
        }
    }
}

fn required_option(options: &Map<String, Value>, key: &str, label: &str) -> Result<String, String> {
    options
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("cloud model {label} is required"))
}

pub(super) fn cloud_model_gateway_base_url(backend_url: &str) -> String {
    let base_url = backend_url.trim().trim_end_matches('/');
    let api_root = if base_url.ends_with("/api") {
        base_url.to_owned()
    } else {
        format!("{base_url}/api")
    };
    format!("{api_root}/runtime-work/llm-responses-proxy")
}
