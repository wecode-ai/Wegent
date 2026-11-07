//! Model environment and context-budget negotiation.
use super::*;

pub(super) fn apply_model_environment(
    mut spec: CommandSpec,
    request: &ExecutionRequest,
    context_budget: Option<&ClaudeContextBudget>,
) -> CommandSpec {
    let env_values = model_env(request);
    for (key, value) in &env_values {
        if key != CLAUDE_MAX_CONTEXT_TOKENS_ENV && is_process_env_key(key) {
            spec = spec.env(key, value);
        }
    }

    if !env_values.contains_key("ANTHROPIC_API_KEY") {
        if let Some(api_key) = env_values.get("api_key") {
            spec = spec.env("ANTHROPIC_API_KEY", api_key);
        }
    }

    if !env_values.contains_key("ANTHROPIC_BASE_URL") {
        if let Some(base_url) = env_values.get("base_url") {
            spec = spec.env("ANTHROPIC_BASE_URL", base_url);
        }
    }

    spec = apply_claude_context_budget(spec, request, context_budget);
    spec = apply_default_model_environment(spec, request);

    spec
}

/// Resolved Claude Code context budget for the request's model.
///
/// A model that declares a long-context window (`>= 1M`) is addressed through
/// the `[1m]` alias and receives the auto-compact trio that keeps requests
/// below the upstream hard cap. Smaller windows keep the legacy behavior of
/// only exporting `CLAUDE_CODE_MAX_CONTEXT_TOKENS`; Claude Code then applies
/// its own 200k assumptions and no behavior regresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ClaudeContextBudget {
    model_window: u64,
    source: &'static str,
    max_output_tokens: u64,
    auto_compact_window: u64,
    long_context: bool,
    pub(super) model_alias: Option<String>,
}

pub(super) fn claude_context_budget(
    request: &ExecutionRequest,
    model_id: Option<&str>,
) -> Option<ClaudeContextBudget> {
    let (model_window, source) = resolved_claude_context_window(request)?;
    let max_output_tokens = claude_max_output_tokens(request).min((model_window / 2).max(1));
    let long_context = model_window >= LONG_CONTEXT_MODEL_WINDOW && model_id.is_some();
    let auto_compact_window = LONG_CONTEXT_AUTO_COMPACT_WINDOW.min(
        UPSTREAM_CONTEXT_HARD_CAP
            .saturating_sub(max_output_tokens)
            .max(1),
    );
    let model_alias = if long_context {
        model_id.map(long_context_model_alias)
    } else {
        None
    };

    Some(ClaudeContextBudget {
        model_window,
        source,
        max_output_tokens,
        auto_compact_window,
        long_context,
        model_alias,
    })
}

pub(super) fn apply_claude_context_budget(
    mut spec: CommandSpec,
    request: &ExecutionRequest,
    budget: Option<&ClaudeContextBudget>,
) -> CommandSpec {
    let Some(budget) = budget else {
        return spec;
    };

    let mut fields = task_fields(&request.task_id, &request.subtask_id);
    fields.push(("context_window_tokens", budget.model_window.to_string()));
    fields.push(("context_window_source", budget.source.to_owned()));
    fields.push(("long_context", budget.long_context.to_string()));
    if budget.long_context {
        fields.push((
            "auto_compact_window",
            budget.auto_compact_window.to_string(),
        ));
        fields.push(("max_output_tokens", budget.max_output_tokens.to_string()));
    }
    if let Some(model_alias) = &budget.model_alias {
        fields.push(("model_alias", model_alias.clone()));
    }
    log_executor_event("claude context window configured", &fields);

    spec = spec.env(
        CLAUDE_MAX_CONTEXT_TOKENS_ENV,
        budget.model_window.to_string(),
    );
    if budget.long_context {
        spec = set_env_if_unset(
            spec,
            CLAUDE_AUTO_COMPACT_WINDOW_ENV,
            budget.auto_compact_window.to_string(),
        );
        spec = set_env_if_unset(
            spec,
            CLAUDE_MAX_OUTPUT_TOKENS_ENV,
            budget.max_output_tokens.to_string(),
        );
        if let Some(model_alias) = &budget.model_alias {
            spec = set_env_if_unset(spec, CLAUDE_MODEL_ENV, model_alias.clone());
        }
    }
    spec
}

pub(super) fn set_env_if_unset(mut spec: CommandSpec, key: &str, value: String) -> CommandSpec {
    if !spec.envs().contains_key(key) {
        spec = spec.env(key, value);
    }
    spec
}

pub(super) fn resolved_claude_context_window(
    request: &ExecutionRequest,
) -> Option<(u64, &'static str)> {
    if let Some(context_window) = model_string(request, CLAUDE_MAX_CONTEXT_TOKENS_ENV)
        .and_then(|value| positive_count(&Value::String(value)))
    {
        return Some((context_window, "explicit_env"));
    }

    if let Some(context_window) = claude_model_context_window(&request.model_config) {
        return Some((context_window, "model_config"));
    }

    process_model_environment(CLAUDE_MAX_CONTEXT_TOKENS_ENV)
        .and_then(|value| positive_count(&Value::String(value)))
        .map(|context_window| (context_window, "process_env"))
}

pub(super) fn claude_model_context_window(model_config: &Value) -> Option<u64> {
    model_config
        .get("model_context_window")
        .or_else(|| model_config.get("context_window"))
        .or_else(|| model_config.get("contextWindow"))
        .and_then(positive_count)
}

pub(super) fn claude_max_output_tokens(request: &ExecutionRequest) -> u64 {
    model_string(request, CLAUDE_MAX_OUTPUT_TOKENS_ENV)
        .and_then(|value| positive_count(&Value::String(value)))
        .or_else(|| claude_model_max_output_tokens(&request.model_config))
        .or_else(|| {
            process_model_environment(CLAUDE_MAX_OUTPUT_TOKENS_ENV)
                .and_then(|value| positive_count(&Value::String(value)))
        })
        .unwrap_or(DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS)
        .min(DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS)
}

pub(super) fn claude_model_max_output_tokens(model_config: &Value) -> Option<u64> {
    model_config
        .get("max_output_tokens")
        .or_else(|| model_config.get("maxOutputTokens"))
        .and_then(positive_count)
}

pub(super) fn positive_count(value: &Value) -> Option<u64> {
    let count = match value {
        Value::Number(value) => value.as_u64(),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }?;
    (count > 0).then_some(count)
}

pub(super) fn long_context_model_alias(model_id: &str) -> String {
    let model_id = model_id.trim();
    if has_long_context_suffix(model_id) {
        model_id.to_owned()
    } else {
        format!("{model_id}[1m]")
    }
}

pub(super) fn has_long_context_suffix(model_id: &str) -> bool {
    let model_id = model_id.trim().to_ascii_lowercase();
    LONG_CONTEXT_MODEL_SUFFIXES
        .iter()
        .any(|suffix| model_id.ends_with(suffix))
}

pub(super) fn apply_default_model_environment(
    mut spec: CommandSpec,
    request: &ExecutionRequest,
) -> CommandSpec {
    for key in DEFAULT_CLAUDE_MODEL_ENV {
        if spec.envs().contains_key(*key) {
            continue;
        }

        let value = model_string(request, key)
            .or_else(|| process_model_environment(key))
            .or_else(|| model_id(request));

        if let Some(value) = value {
            spec = spec.env(*key, value);
        }
    }

    spec
}

pub(super) fn process_model_environment(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_context_budget_caps_output_tokens_at_half_the_window() {
        let request = ExecutionRequest {
            model_config: json!({
                "model_id": "small-window-model",
                "context_window": 100_000,
                "max_output_tokens": 90_000,
            }),
            ..ExecutionRequest::default()
        };

        let budget = claude_context_budget(&request, Some("small-window-model"))
            .expect("context budget for a positive window");

        assert_eq!(budget.max_output_tokens, 50_000);
        assert!(!budget.long_context);
        assert!(budget.auto_compact_window > 0);
    }

    #[test]
    fn claude_context_budget_requires_a_model_for_long_context() {
        let request = ExecutionRequest {
            model_config: json!({"context_window": 1_000_000}),
            ..ExecutionRequest::default()
        };

        let budget = claude_context_budget(&request, None).expect("context budget");

        assert_eq!(budget.model_window, 1_000_000);
        assert!(!budget.long_context);
        assert!(budget.model_alias.is_none());
    }

    #[test]
    fn claude_context_budget_leaves_output_room_below_the_upstream_cap() {
        let request = ExecutionRequest {
            model_config: json!({
                "model_id": "long-context-model",
                "context_window": 1_000_000,
                "max_output_tokens": 96_000,
            }),
            ..ExecutionRequest::default()
        };

        let budget = claude_context_budget(&request, Some("long-context-model"))
            .expect("context budget for a long context model");

        assert_eq!(budget.auto_compact_window, LONG_CONTEXT_AUTO_COMPACT_WINDOW);
        assert!(budget.auto_compact_window + budget.max_output_tokens <= UPSTREAM_CONTEXT_HARD_CAP);
    }
}
