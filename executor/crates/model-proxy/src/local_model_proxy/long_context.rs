// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Long-context model alias handling and context-overflow normalization.
//!
//! Claude Code addresses long-context models through a `[1m]` model alias and
//! only starts its reactive compaction for errors it recognizes as a prompt
//! that is too long. The alias must never reach an upstream provider, and
//! provider-specific overflow errors must be translated into the shape Claude
//! Code understands so a failed turn can still recover by compacting.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

const LONG_CONTEXT_SUFFIXES: [&str; 2] = ["[1m]", "+1m"];
const CONTEXT_OVERFLOW_STATUSES: [u16; 4] = [400, 413, 422, 460];
const CONTEXT_OVERFLOW_MARKERS: [&str; 6] = [
    "对话内容太长",
    "exceeds the context limit",
    "maximum context length",
    "context_length_exceeded",
    "prompt is too long",
    "input is too long",
];
/// Rough characters-per-token ratio used when a provider error carries no
/// token count.
const CONTEXT_OVERFLOW_CHARS_PER_TOKEN: u64 = 4;

/// Removes a long-context alias suffix from a model id.
///
/// Claude Code strips the suffix itself before calling a provider, but the
/// proxy must not depend on that: any registration or direct caller may pass
/// the alias through, and upstream model names never carry it.
pub(super) fn strip_long_context_suffix(model: &str) -> &str {
    let trimmed = model.trim();
    for suffix in LONG_CONTEXT_SUFFIXES {
        let suffix_length = suffix.len();
        if trimmed.len() <= suffix_length {
            continue;
        }
        let tail = &trimmed.as_bytes()[trimmed.len() - suffix_length..];
        if tail.eq_ignore_ascii_case(suffix.as_bytes()) {
            return trimmed[..trimmed.len() - suffix_length].trim_end();
        }
    }
    trimmed
}

/// Rewrites an upstream context-overflow error into the message Claude Code
/// recognizes as a prompt-too-long error.
///
/// Returns `None` for statuses and messages that are not context overflows so
/// callers can pass the original upstream response through unchanged. The
/// rewritten message always reports `actual > limit`, which Claude Code parses
/// to size the reactive compaction.
pub(super) fn normalize_context_overflow(
    status: u16,
    response_body: &[u8],
    request_body_size: usize,
    model_context_window: Option<u64>,
) -> Option<Value> {
    if !CONTEXT_OVERFLOW_STATUSES.contains(&status) {
        return None;
    }
    let text = String::from_utf8_lossy(response_body);
    let lowered = text.to_ascii_lowercase();
    if !CONTEXT_OVERFLOW_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return None;
    }

    let actual_tokens = extract_token_count(&text)
        .unwrap_or(request_body_size as u64 / CONTEXT_OVERFLOW_CHARS_PER_TOKEN)
        .max(2);
    let limit_tokens = model_context_window
        .filter(|limit| *limit > 0 && *limit < actual_tokens)
        .unwrap_or_else(|| actual_tokens.saturating_sub(1).max(1));

    Some(json!({
        "type": "error",
        "error": {
            "type": "invalid_request_error",
            "message": format!(
                "prompt is too long: {actual_tokens} tokens > {limit_tokens} maximum"
            ),
        },
    }))
}

fn extract_token_count(text: &str) -> Option<u64> {
    static TOKEN_COUNT: OnceLock<Regex> = OnceLock::new();
    let pattern = TOKEN_COUNT.get_or_init(|| {
        Regex::new(r"(?i)(\d{3,})\s*tokens?\b").expect("token count pattern is valid")
    });
    pattern
        .captures_iter(text)
        .filter_map(|captures| captures.get(1)?.as_str().parse().ok())
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_long_context_suffixes_case_insensitively() {
        assert_eq!(
            strip_long_context_suffix("deepseek-v4.1-flash[1m]"),
            "deepseek-v4.1-flash"
        );
        assert_eq!(
            strip_long_context_suffix("deepseek-v4.1-flash[1M]"),
            "deepseek-v4.1-flash"
        );
        assert_eq!(
            strip_long_context_suffix("deepseek-v4.1-flash+1m"),
            "deepseek-v4.1-flash"
        );
        assert_eq!(
            strip_long_context_suffix("  deepseek-v4.1-flash[1m]  "),
            "deepseek-v4.1-flash"
        );
    }

    #[test]
    fn leaves_plain_model_ids_unchanged() {
        assert_eq!(
            strip_long_context_suffix("deepseek-v4.1-flash"),
            "deepseek-v4.1-flash"
        );
        assert_eq!(strip_long_context_suffix("[1m]"), "[1m]");
        assert_eq!(strip_long_context_suffix(""), "");
        assert_eq!(strip_long_context_suffix("模型"), "模型");
    }

    #[test]
    fn normalizes_provider_context_limit_error() {
        let body = br#"{"error":{"code":"InvalidParameter","message":"Input exceeds the context limit (1048568 tokens). Please shorten the input."}}"#;

        let normalized =
            normalize_context_overflow(400, body, 4_000_000, Some(1_000_000)).expect("overflow");

        assert_eq!(normalized["type"], "error");
        assert_eq!(normalized["error"]["type"], "invalid_request_error");
        assert_eq!(
            normalized["error"]["message"],
            "prompt is too long: 1048568 tokens > 1000000 maximum"
        );
    }

    #[test]
    fn normalizes_new_api_context_error_with_request_estimate() {
        let body = "{\"error\":{\"message\":\"对话内容太长，已超出当前模型的处理能力。\"}}";

        let normalized = normalize_context_overflow(460, body.as_bytes(), 800_000, Some(1_000_000))
            .expect("overflow");

        assert_eq!(
            normalized["error"]["message"],
            "prompt is too long: 200000 tokens > 199999 maximum"
        );
    }

    #[test]
    fn uses_largest_parseable_token_count_for_actual_input() {
        for body in [
            "maximum context length is 128000 tokens; your messages resulted in 130000 tokens",
            "input is too long: 130000 tokens exceed 128000 tokens",
            "maximum context length: 999999999999999999999999 tokens; requested 130000 tokens",
        ] {
            let normalized = normalize_context_overflow(400, body.as_bytes(), 0, Some(128_000))
                .expect("overflow");

            assert_eq!(
                normalized["error"]["message"],
                "prompt is too long: 130000 tokens > 128000 maximum"
            );
        }
    }

    #[test]
    fn reports_actual_above_a_matching_window() {
        let body = b"Input exceeds the context limit (1000000 tokens).";

        let normalized =
            normalize_context_overflow(400, body, 0, Some(1_000_000)).expect("overflow");

        assert_eq!(
            normalized["error"]["message"],
            "prompt is too long: 1000000 tokens > 999999 maximum"
        );
    }

    #[test]
    fn keeps_overflow_counts_positive_and_ordered_for_small_requests() {
        for request_size in [0, 1, 4, 8] {
            for window in [None, Some(0), Some(1), Some(1_000_000)] {
                let normalized = normalize_context_overflow(
                    460,
                    "对话内容太长".as_bytes(),
                    request_size,
                    window,
                )
                .expect("overflow");

                assert_eq!(
                    normalized["error"]["message"],
                    "prompt is too long: 2 tokens > 1 maximum"
                );
            }
        }
    }

    #[test]
    fn ignores_other_errors_and_statuses() {
        let overflow = b"Input exceeds the context limit (1048568 tokens).";

        assert_eq!(
            normalize_context_overflow(400, b"invalid parameter", 10, None),
            None
        );
        assert_eq!(normalize_context_overflow(500, overflow, 10, None), None);
    }
}
