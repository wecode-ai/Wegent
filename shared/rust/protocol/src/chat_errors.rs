// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Bounded chat-error classification for public error messages and metrics.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChatErrorInfo {
    pub code: &'static str,
    pub category: &'static str,
    pub retry_policy: &'static str,
}

const UNKNOWN: ChatErrorInfo = ChatErrorInfo {
    code: "generic_error",
    category: "unknown",
    retry_policy: "unknown",
};

/// Native business codes take precedence; legacy generic messages can be refined.
pub fn classify_chat_error(code: Option<&str>, message: Option<&str>) -> ChatErrorInfo {
    let Some(code) = code.filter(|code| !code.is_empty()) else {
        return classify_message(message.unwrap_or_default());
    };
    if code.eq_ignore_ascii_case("generic_error") {
        return classify_message(message.unwrap_or_default());
    }
    match known_error(code) {
        Some(info) if code.eq_ignore_ascii_case("llm_error") => {
            let classified = classify_message(message.unwrap_or_default());
            if classified == UNKNOWN {
                info
            } else {
                classified
            }
        }
        Some(info) => info,
        None => UNKNOWN,
    }
}

/// Infer only stages tied to a concrete error contract; transport needs context.
pub fn error_stage(code: &str) -> &'static str {
    match code {
        "skills_unmanaged_entries"
        | "skill_deploy_failed"
        | "executor_start_failed"
        | "workspace_unavailable"
        | "plugin_load_failed" => "prepare",
        "dispatch_error" => "dispatch",
        "stream_protocol_error" => "stream",
        "storage_error" => "persist",
        "rate_limit" | "quota_exceeded" | "server_overloaded" | "model_unavailable"
        | "provider_error" | "content_filter" => "model",
        "tool_execution_failed" | "connector_unavailable" => "tool",
        _ => "unknown",
    }
}

/// Structured, bounded details shared by live events and persisted failures.
pub fn error_info(code: Option<&str>, message: Option<&str>) -> serde_json::Value {
    let info = classify_chat_error(code, message);
    serde_json::json!({
        "code": info.code,
        "category": info.category,
        "retry_policy": info.retry_policy,
        "stage": error_stage(info.code),
    })
}

fn known_error(code: &str) -> Option<ChatErrorInfo> {
    let (code, category, retry_policy) = match code {
        "context_length_exceeded" => ("context_length_exceeded", "input", "after_change"),
        "quota_exceeded" | "insufficient_quota" | "billing_hard_limit_reached" => {
            ("quota_exceeded", "model", "after_change")
        }
        "rate_limit" | "rate_limit_exceeded" => ("rate_limit", "model", "after_backoff"),
        "server_overloaded" | "server_overloaded_retryable" => {
            ("server_overloaded", "model", "after_backoff")
        }
        "model_unavailable" | "llm_error" => ("model_unavailable", "model", "after_backoff"),
        "provider_error" => ("provider_error", "model", "after_backoff"),
        "container_oom" => ("container_oom", "runtime", "after_change"),
        "container_error" => ("container_error", "runtime", "after_change"),
        "network_error" => ("network_error", "transport", "after_backoff"),
        "timeout_error" => ("timeout_error", "transport", "after_backoff"),
        "llm_unsupported" => ("llm_unsupported", "input", "after_change"),
        "forbidden" | "authentication_error" => ("forbidden", "access", "after_change"),
        "permission_denied" => ("permission_denied", "access", "after_change"),
        "authentication_expired" => ("authentication_expired", "access", "after_change"),
        "payload_too_large" => ("payload_too_large", "input", "after_change"),
        "invalid_parameter" => ("invalid_parameter", "input", "after_change"),
        "content_filter" => ("content_filter", "policy", "after_change"),
        "image_too_large" => ("image_too_large", "input", "after_change"),
        "model_protocol_error" => ("model_protocol_error", "input", "after_change"),
        "invalid_role" => ("invalid_role", "input", "after_change"),
        "skills_unmanaged_entries" => ("skills_unmanaged_entries", "runtime", "after_change"),
        "skill_deploy_failed" => ("skill_deploy_failed", "runtime", "after_change"),
        "executor_start_failed" => ("executor_start_failed", "runtime", "unknown"),
        "workspace_unavailable" => ("workspace_unavailable", "runtime", "after_change"),
        "tool_execution_failed" => ("tool_execution_failed", "tool", "unknown"),
        "connector_unavailable" => ("connector_unavailable", "tool", "after_backoff"),
        "plugin_load_failed" => ("plugin_load_failed", "tool", "after_change"),
        "stream_protocol_error" => ("stream_protocol_error", "transport", "unknown"),
        "internal_error" => ("internal_error", "platform", "unknown"),
        "storage_error" => ("storage_error", "platform", "unknown"),
        "dispatch_error"
        | "EXECUTOR_DISPATCH_FAILED"
        | "task_queue_failure"
        | "task_queue_stalled" => ("dispatch_error", "platform", "unknown"),
        "generic_error" => return Some(UNKNOWN),
        _ => return None,
    };
    Some(ChatErrorInfo {
        code,
        category,
        retry_policy,
    })
}

// Keep the legacy message rules aligned with shared/utils/error_classifier.py.
// Specific reasons precede status-only classification and broad runtime wrappers.
const MESSAGE_RULES: &[(&str, &[&str])] = &[
    (
        "context_length_exceeded",
        &[
            "prompt is too long",
            "context_length_exceeded",
            "context length exceeded",
            "maximum context length",
            "token limit exceeded",
            "tokens exceeds the model",
            "input is too long",
            "maximum number of tokens",
        ],
    ),
    (
        "content_filter",
        &[
            "data_inspection_failed",
            "inappropriate content",
            "content filter",
            "content management",
            "content_policy",
            "contentfilter",
            "risky content",
            "content_filtering_policy",
            "responsibleaipolicy",
            "resp_safety_modify_answer",
        ],
    ),
    (
        "image_too_large",
        &["image exceeds", "image too large", "image size exceeds"],
    ),
    ("invalid_role", &["invalid role"]),
    (
        "model_protocol_error",
        &[
            "invalid model id",
            "only claude",
            "only thudm",
            "only moonshot",
        ],
    ),
    (
        "skills_unmanaged_entries",
        &["agent skills directory contains unmanaged entries"],
    ),
    (
        "skill_deploy_failed",
        &[
            "refusing to replace unmanaged agent skill",
            "required skills are missing from the deployment plan",
            "required skills cannot be deployed",
            "required skill deployment failed",
        ],
    ),
    (
        "container_oom",
        &["out of memory", "oom killed", "memory allocation"],
    ),
    (
        "quota_exceeded",
        &[
            "商业付费模型额度已用完",
            "quota exceeded",
            "billing limit",
            "billing quota",
            "billing_hard_limit_reached",
            "credit balance",
            "payment required",
            "account balance",
            "insufficient funds",
            "exceeded your current quota",
        ],
    ),
    (
        "authentication_expired",
        &[
            "authentication expired",
            "credentials expired",
            "token expired",
        ],
    ),
    (
        "rate_limit",
        &["rate limit", "rate_limit", "too many requests", "throttl"],
    ),
    (
        "permission_denied",
        &[
            "无权限调用此模型",
            "禁止使用外部模型",
            "permission_denied",
            "permission denied",
            "permission_error",
        ],
    ),
    (
        "forbidden",
        &[
            "forbidden",
            "not allowed",
            "unauthorized",
            "403 forbidden",
            "403 client error",
            "not logged in",
        ],
    ),
    (
        "server_overloaded",
        &["server overloaded", "server_overloaded", "overloaded"],
    ),
    (
        "timeout_error",
        &["timeout", "timed out", "504 gateway", "超时"],
    ),
    (
        "connector_unavailable",
        &["connector unavailable", "connector not connected"],
    ),
    (
        "network_error",
        &[
            "network",
            "connection refused",
            "connection reset",
            "connection error",
            "not connected",
            "peer closed connection",
            "upstream connection interrupted",
        ],
    ),
    (
        "provider_error",
        &["error from provider", "upstream error", "502 bad gateway"],
    ),
    (
        "llm_unsupported",
        &[
            "multi-modal",
            "multimodal",
            "do not support",
            "does not support",
            "not support image",
        ],
    ),
    (
        "model_unavailable",
        &[
            "model not found",
            "model unavailable",
            "model_not_found",
            "model error",
            "llm request failed",
            "llm api error",
            "llm call failed",
            "llm service error",
        ],
    ),
    (
        "invalid_parameter",
        &["invalid parameter", "invalid_parameter"],
    ),
    (
        "payload_too_large",
        &[
            "413 request entity too large",
            "payload too large",
            "request too large",
        ],
    ),
    (
        "executor_start_failed",
        &["executor failed to start", "failed to start executor"],
    ),
    (
        "workspace_unavailable",
        &["workspace unavailable", "workspace not found"],
    ),
    (
        "plugin_load_failed",
        &["failed to load plugin", "plugin load failed"],
    ),
    (
        "stream_protocol_error",
        &[
            "invalid sse event",
            "malformed sse event",
            "stream protocol error",
        ],
    ),
    ("tool_execution_failed", &["tool execution failed"]),
];

const RUNTIME_WRAPPERS: &[&str] = &[
    "container",
    "executor",
    "docker",
    "disappeared unexpectedly",
    "no ports mapped",
    "crashed unexpectedly",
    "exit code",
    "device disconnected",
];

fn classify_message(message: &str) -> ChatErrorInfo {
    let lower = message.to_lowercase();
    if contains_delimited_token(&lower, "insufficient_quota")
        || contains_delimited_token(&lower, "billing_hard_limit_reached")
    {
        return known_error("quota_exceeded").unwrap_or(UNKNOWN);
    }
    for (code, patterns) in MESSAGE_RULES {
        if patterns.iter().any(|pattern| lower.contains(pattern)) {
            return known_error(code).unwrap_or(UNKNOWN);
        }
    }
    if let Some(code) = message_http_status(&lower).and_then(status_error) {
        return known_error(code).unwrap_or(UNKNOWN);
    }
    if RUNTIME_WRAPPERS
        .iter()
        .any(|pattern| lower.contains(pattern))
    {
        return known_error("container_error").unwrap_or(UNKNOWN);
    }
    UNKNOWN
}

fn contains_delimited_token(message: &str, token: &str) -> bool {
    message.match_indices(token).any(|(index, _)| {
        let before = message[..index].chars().next_back();
        let after = message[index + token.len()..].chars().next();
        !before.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            && !after.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    })
}

fn message_http_status(message: &str) -> Option<u16> {
    let (_, status) = message.split_once("error code:")?;
    let status = status.trim_start();
    let digits: String = status.chars().take_while(char::is_ascii_digit).collect();
    if digits.len() != 3 {
        return None;
    }
    let boundary = status[digits.len()..].chars().next();
    (!boundary.is_some_and(|ch| ch.is_alphanumeric() || ch == '_'))
        .then(|| digits.parse().ok())
        .flatten()
}

fn status_error(status: u16) -> Option<&'static str> {
    match status {
        401 | 403 => Some("forbidden"),
        408 | 504 => Some("timeout_error"),
        413 => Some("payload_too_large"),
        429 => Some("rate_limit"),
        500 | 502 | 503 => Some("provider_error"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_protection_has_an_actionable_preparation_error() {
        let error = classify_chat_error(
            None,
            Some("Agent Skills directory contains unmanaged entries"),
        );
        assert_eq!(error.code, "skills_unmanaged_entries");
        assert_eq!(error.category, "runtime");
        assert_eq!(error.retry_policy, "after_change");
    }

    #[test]
    fn native_codes_win_and_unregistered_codes_stay_bounded() {
        assert_eq!(
            classify_chat_error(Some("server_overloaded"), Some("disconnected")),
            known_error("server_overloaded").unwrap(),
        );
        assert_eq!(
            classify_chat_error(Some("llm_error"), Some("timeout")),
            known_error("timeout_error").unwrap(),
        );
        assert_eq!(
            classify_chat_error(Some("provider-customer-unique-code"), Some("timeout")),
            UNKNOWN,
        );
        assert_eq!(
            classify_chat_error(None, Some("unclassified failure")),
            UNKNOWN
        );
        for code in [
            "EXECUTOR_DISPATCH_FAILED",
            "task_queue_failure",
            "task_queue_stalled",
        ] {
            assert_eq!(classify_chat_error(Some(code), None).code, "dispatch_error");
        }
        assert_eq!(
            classify_chat_error(Some("container_error"), None).code,
            "container_error",
        );
    }

    #[test]
    fn informative_causes_precede_generic_runtime_and_provider_wrappers() {
        for (message, expected) in [
            (
                "executor failed: insufficient_quota; rate limit",
                "quota_exceeded",
            ),
            ("container request: permission denied", "permission_denied"),
            ("executor authentication expired", "authentication_expired"),
            ("upstream error: connection reset", "network_error"),
            ("connector not connected", "connector_unavailable"),
            ("executor request timed out", "timeout_error"),
            ("502 Bad Gateway", "provider_error"),
            ("请求超时，请稍后重试", "timeout_error"),
            ("Error code: 429 - executor request failed", "rate_limit"),
            ("Error code: 429 - insufficient_quota", "quota_exceeded"),
        ] {
            assert_eq!(classify_chat_error(None, Some(message)).code, expected);
        }
    }

    #[test]
    fn error_identifiers_and_parameter_names_do_not_fabricate_a_cause() {
        for message in [
            "Reference 403913 is unavailable",
            "Error code: 4299",
            "max_tokens parameter is invalid",
            "Error code: 429abc",
        ] {
            assert_eq!(classify_chat_error(None, Some(message)), UNKNOWN);
        }
        assert_eq!(
            classify_chat_error(
                None,
                Some(r#"Error code: 500 - {"code":"not_insufficient_quota"}"#),
            )
            .code,
            "provider_error",
        );
    }

    #[test]
    fn generic_error_can_refine_a_legacy_message_without_relabeling_native_codes() {
        assert_eq!(
            classify_chat_error(Some("generic_error"), Some("executor request timed out")).code,
            "timeout_error",
        );
        assert_eq!(
            classify_chat_error(Some("container_error"), Some("executor request timed out")).code,
            "container_error",
        );
        assert_eq!(
            classify_chat_error(
                Some("llm_error"),
                Some("Agent Skills directory contains unmanaged entries"),
            )
            .code,
            "skills_unmanaged_entries",
        );
        assert_eq!(
            classify_chat_error(Some("llm_error"), Some("opaque failure")).code,
            "model_unavailable",
        );
    }

    #[test]
    fn transport_stage_is_not_inferred_without_origin_context() {
        assert_eq!(error_stage("skills_unmanaged_entries"), "prepare");
        assert_eq!(error_stage("timeout_error"), "unknown");
        assert_eq!(error_stage("network_error"), "unknown");
    }

    #[test]
    fn every_message_rule_resolves_to_a_registered_code() {
        for (code, _) in MESSAGE_RULES {
            assert_ne!(known_error(code), Some(UNKNOWN));
            assert!(known_error(code).is_some(), "missing code: {code}");
        }
        for code in ["internal_error", "storage_error", "dispatch_error"] {
            assert_eq!(classify_chat_error(Some(code), None).category, "platform");
        }
    }
}
