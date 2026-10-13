// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `ExecutionRouter.route` / `supports_streaming` for the create flow
//! (`app/services/execution/router.py`).
//!
//! The non-SSE decision routes the recorded executor cases: the member bot's
//! `shell_type` selects the service, and only the `Chat` shell is SSE. The
//! recorded `queued` cases carry `shellRef: ClaudeCode`, so they take the
//! `http_callback` target; the recorded 500 cases carry `Chat`, so they wait on
//! the SSE sync path.
use serde_json::Value;

use super::dispatch::ExecutionRequest;
use super::executor_client::executor_target_url;

/// `settings.CHAT_SHELL_URL`.
pub const CHAT_SHELL_URL_ENV: &str = "CHAT_SHELL_URL";

/// `settings.CHAT_SHELL_URL` default.
pub const DEFAULT_CHAT_SHELL_URL: &str = "http://127.0.0.1:8100";

/// `CommunicationMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommunicationMode {
    Sse,
    HttpCallback,
    Websocket,
    Inprocess,
    Polling,
}

/// `ExecutionTarget`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionTarget {
    pub mode: CommunicationMode,
    /// The base URL for the SSE / HTTP+callback targets.
    pub url: Option<String>,
}

/// `_get_shell_type`: the first member bot's `shell_type`, default `Chat`.
pub fn shell_type(request: &ExecutionRequest) -> String {
    request
        .bot
        .as_array()
        .and_then(|bots| bots.first())
        .and_then(|bot| bot.get("shell_type"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "Chat".to_string())
}

/// `ExecutionRouter.route`'s inputs after settings resolution.
#[derive(Clone)]
pub struct RouteInputs<'a> {
    pub shell_type: &'a str,
    pub chat_shell_url: &'a str,
    pub executor_manager_url: &'a str,
    pub device_id: Option<&'a str>,
    /// `_get_model_type(request) == "video"`.
    pub model_is_video: bool,
    /// `request.model_config["protocol"]`.
    pub model_protocol: Option<&'a str>,
}

/// `ExecutionRouter.route`: the execution target for a request.
///
/// Implemented priorities: 0 (video → `POLLING`), 1
/// (`gemini-deep-research` → `POLLING`), 2 (a `device_id` → `WEBSOCKET`), 5
/// (shell lookup: `Chat` → `SSE` at `CHAT_SHELL_URL`; `ClaudeCode` / `Codex` /
/// `Agno` / `Dify` → `HTTP_CALLBACK` at `{EXECUTOR_MANAGER_URL}/executor-manager`),
/// and 6 (default `HTTP_CALLBACK` at the executor-manager URL). Priorities 3
/// (standalone Rust executor) and 4 (`chat_shell` package mode) are settings
/// this route's recordings do not enable and are left out; `mode` only depends
/// on the shell type, so `supports_streaming` is unaffected by them.
pub fn route(inputs: &RouteInputs<'_>) -> ExecutionTarget {
    if inputs.model_is_video && inputs.device_id.is_none() {
        return ExecutionTarget {
            mode: CommunicationMode::Polling,
            url: None,
        };
    }
    if inputs.model_protocol == Some("gemini-deep-research") && inputs.device_id.is_none() {
        return ExecutionTarget {
            mode: CommunicationMode::Polling,
            url: None,
        };
    }
    if inputs.device_id.is_some() {
        return ExecutionTarget {
            mode: CommunicationMode::Websocket,
            url: None,
        };
    }
    match inputs.shell_type {
        "Chat" => ExecutionTarget {
            mode: CommunicationMode::Sse,
            url: Some(inputs.chat_shell_url.to_string()),
        },
        "ClaudeCode" | "Codex" | "Agno" | "Dify" => ExecutionTarget {
            mode: CommunicationMode::HttpCallback,
            url: Some(executor_target_url(inputs.executor_manager_url)),
        },
        _ => ExecutionTarget {
            mode: CommunicationMode::HttpCallback,
            url: Some(executor_target_url(inputs.executor_manager_url)),
        },
    }
}

/// `supports_streaming`: only `SSE` targets stream.
pub fn supports_streaming(target: &ExecutionTarget) -> bool {
    target.mode == CommunicationMode::Sse
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request_with_shell(shell: &str) -> ExecutionRequest {
        serde_json::from_value(json!({"bot": [{"shell_type": shell}]})).expect("request")
    }

    #[test]
    fn shell_type_defaults_to_chat() {
        let request: ExecutionRequest = serde_json::from_value(json!({})).expect("request");
        assert_eq!(shell_type(&request), "Chat");
        assert_eq!(shell_type(&request_with_shell("ClaudeCode")), "ClaudeCode");
    }

    #[test]
    fn executor_shells_route_to_http_callback_and_chat_to_sse() {
        let base = RouteInputs {
            shell_type: "ClaudeCode",
            chat_shell_url: "http://chat-shell:8100",
            executor_manager_url: "http://host:8001/",
            device_id: None,
            model_is_video: false,
            model_protocol: None,
        };
        let target = route(&base);
        assert_eq!(target.mode, CommunicationMode::HttpCallback);
        assert_eq!(
            target.url.as_deref(),
            Some("http://host:8001/executor-manager")
        );
        assert!(!supports_streaming(&target));

        let chat = route(&RouteInputs {
            shell_type: "Chat",
            ..base
        });
        assert_eq!(chat.mode, CommunicationMode::Sse);
        assert_eq!(chat.url.as_deref(), Some("http://chat-shell:8100"));
        assert!(supports_streaming(&chat));
    }

    #[test]
    fn a_device_forces_websocket_and_a_video_model_polls() {
        let base = RouteInputs {
            shell_type: "Chat",
            chat_shell_url: "http://chat-shell:8100",
            executor_manager_url: "http://host:8001",
            device_id: None,
            model_is_video: false,
            model_protocol: None,
        };
        assert_eq!(
            route(&RouteInputs {
                device_id: Some("dev-1"),
                ..base.clone()
            })
            .mode,
            CommunicationMode::Websocket
        );
        assert_eq!(
            route(&RouteInputs {
                model_is_video: true,
                ..base.clone()
            })
            .mode,
            CommunicationMode::Polling
        );
        assert_eq!(
            route(&RouteInputs {
                model_protocol: Some("gemini-deep-research"),
                ..base.clone()
            })
            .mode,
            CommunicationMode::Polling
        );
    }
}
