// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::protocol::ExecutionRequest;

pub(crate) const TASK_SOURCE_WEGENT: &str = "wegent";
pub(crate) const TASK_SOURCE_WEWORK: &str = "wework";
pub(crate) const TASK_SOURCE_UNKNOWN: &str = "unknown";

pub(crate) fn stamp_execution_context(
    request: &mut ExecutionRequest,
    device_type: &str,
    task_source: Option<&str>,
) {
    request.execution_device_type = normalize_device_type(device_type).to_owned();
    request.task_source =
        normalize_task_source(task_source.unwrap_or(&request.task_source)).to_owned();
}

pub(crate) fn authoritative_headers(
    request: &ExecutionRequest,
    executor: &str,
) -> Option<Vec<(String, String)>> {
    if request.task_source.trim().is_empty() {
        return None;
    }

    let executor = match executor.trim().to_ascii_lowercase().as_str() {
        "claude" | "claudecode" | "claude_code" => "claudecode",
        "codex" => "codex",
        _ => return None,
    };
    let device_source = format!(
        "wegent-{}",
        normalize_device_type(&request.execution_device_type)
    );
    let task_source = normalize_task_source(&request.task_source);
    let mut headers = vec![
        ("wecode-executor".to_owned(), executor.to_owned()),
        ("wecode-source".to_owned(), device_source),
        ("wecode-task-source".to_owned(), task_source.to_owned()),
    ];

    if uses_wegent_llm_proxy(&request.model_config) {
        headers.extend(
            headers
                .clone()
                .into_iter()
                .map(|(key, value)| (format!("X-Wegent-Upstream-Header-{key}"), value)),
        );
    }
    Some(headers)
}

pub(crate) fn apply_authoritative_headers(
    mut headers: Vec<(String, String)>,
    request: &ExecutionRequest,
    executor: &str,
) -> Vec<(String, String)> {
    let Some(authoritative) = authoritative_headers(request, executor) else {
        return headers;
    };
    for (key, value) in authoritative {
        headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(&key));
        headers.push((key, value));
    }
    headers
}

fn normalize_device_type(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "local" => "local",
        "app" => "app",
        "remote" => "remote",
        "cloud" => "cloud",
        _ => "unknown",
    }
}

fn normalize_task_source(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        TASK_SOURCE_WEGENT => TASK_SOURCE_WEGENT,
        TASK_SOURCE_WEWORK => TASK_SOURCE_WEWORK,
        _ => TASK_SOURCE_UNKNOWN,
    }
}

fn uses_wegent_llm_proxy(model_config: &Value) -> bool {
    ["base_url", "baseUrl"]
        .into_iter()
        .filter_map(|key| model_config.get(key).and_then(Value::as_str))
        .any(|url| url.contains("/llm-responses-proxy") || url.contains("/llm-proxy"))
        || ["default_headers", "DEFAULT_HEADERS"]
            .into_iter()
            .filter_map(|key| model_config.get(key))
            .any(has_wegent_gateway_header)
}

fn has_wegent_gateway_header(value: &Value) -> bool {
    match value {
        Value::Object(headers) => headers.keys().any(|key| {
            let key = key.to_ascii_lowercase();
            key.starts_with("x-wegent-model-") || key.starts_with("x-wegent-upstream-header-")
        }),
        Value::String(headers) => serde_json::from_str::<Value>(headers)
            .ok()
            .as_ref()
            .is_some_and(has_wegent_gateway_header),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_executor_device_and_task_source_headers() {
        for executor in ["claudecode", "codex"] {
            for device_type in ["local", "app", "remote", "cloud", "unknown"] {
                for task_source in ["wegent", "wework", "unknown"] {
                    let request = ExecutionRequest {
                        task_source: task_source.to_owned(),
                        execution_device_type: device_type.to_owned(),
                        ..ExecutionRequest::default()
                    };
                    let headers = authoritative_headers(&request, executor).unwrap();
                    assert!(headers.contains(&("wecode-executor".to_owned(), executor.to_owned())));
                    assert!(headers
                        .contains(&("wecode-source".to_owned(), format!("wegent-{device_type}"))));
                    assert!(headers
                        .contains(&("wecode-task-source".to_owned(), task_source.to_owned())));
                }
            }
        }
    }

    #[test]
    fn mirrors_attribution_headers_only_for_wegent_gateway_routes() {
        let direct = ExecutionRequest {
            task_source: "wegent".to_owned(),
            execution_device_type: "local".to_owned(),
            model_config: json!({"base_url": "https://api.example.com/v1"}),
            ..ExecutionRequest::default()
        };
        let gateway = ExecutionRequest {
            model_config: json!({
                "base_url": "https://wegent.example.com/api/runtime-work/llm-responses-proxy",
                "default_headers": {"X-Wegent-Model-Type": "public"}
            }),
            ..direct.clone()
        };

        assert_eq!(authoritative_headers(&direct, "codex").unwrap().len(), 3);
        let gateway_headers = authoritative_headers(&gateway, "codex").unwrap();
        assert_eq!(gateway_headers.len(), 6);
        assert!(gateway_headers.contains(&(
            "X-Wegent-Upstream-Header-wecode-task-source".to_owned(),
            "wegent".to_owned()
        )));
    }

    #[test]
    fn overwrites_conflicting_headers_case_insensitively() {
        let request = ExecutionRequest {
            task_source: "invalid".to_owned(),
            execution_device_type: "invalid".to_owned(),
            ..ExecutionRequest::default()
        };
        let headers = apply_authoritative_headers(
            vec![
                ("Wecode-Source".to_owned(), "caller".to_owned()),
                ("x-custom".to_owned(), "preserved".to_owned()),
            ],
            &request,
            "claude_code",
        );

        assert!(!headers.iter().any(|(key, value)| {
            key.eq_ignore_ascii_case("wecode-source") && value == "caller"
        }));
        assert!(headers.contains(&("wecode-source".to_owned(), "wegent-unknown".to_owned())));
        assert!(headers.contains(&("wecode-task-source".to_owned(), "unknown".to_owned())));
        assert!(headers.contains(&("x-custom".to_owned(), "preserved".to_owned())));
    }

    #[test]
    fn empty_task_source_disables_auxiliary_request_attribution() {
        assert!(authoritative_headers(&ExecutionRequest::default(), "codex").is_none());
    }
}
