// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Resolve terminal assistant text from finalized blocks and legacy stream state.
use serde_json::Value;

/// Prefer complete finalized text, preserving streamed whitespace and explicit
/// empty replacements. Incomplete blocks retain the available stream aggregate.
pub(super) fn terminal_text_value(blocks: Option<&Value>, accumulated: &str) -> String {
    let parts = extract_text_value_from_blocks(blocks);
    if parts.is_empty() {
        return accumulated.to_string();
    }
    if !accumulated.trim().is_empty() {
        if parts.iter().any(Option::is_none) {
            return accumulated.to_string();
        }
        return parts.into_iter().flatten().collect();
    }
    // Block-only callbacks keep the collector's existing paragraph formatting.
    parts
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Keep text blocks in display order, distinguishing unavailable content from
/// an explicitly empty string. Tool and thinking blocks do not contribute text.
fn extract_text_value_from_blocks(blocks: Option<&Value>) -> Vec<Option<&str>> {
    let Some(Value::Array(blocks)) = blocks else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("text" | "output_text")
            )
        })
        .map(|block| {
            block
                .get("content")
                .and_then(Value::as_str)
                .or_else(|| block.get("text").and_then(Value::as_str))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::terminal_text_value;
    use serde_json::json;

    #[test]
    fn rewritten_same_id_snapshot_overrides_the_stream_aggregate() {
        let blocks = json!([{
            "id": "message", "type": "text", "content": "已改写🙂", "status": "done"
        }]);
        assert_eq!(terminal_text_value(Some(&blocks), "原始🙂"), "已改写🙂");
    }

    #[test]
    fn an_explicitly_empty_completed_block_does_not_restore_old_text() {
        let blocks = json!([{
            "id": "message", "type": "text", "content": "", "status": "done"
        }]);
        assert_eq!(terminal_text_value(Some(&blocks), "原始🙂"), "");
    }

    #[test]
    fn canonical_empty_content_does_not_restore_a_stale_text_alias() {
        let blocks = json!([{
            "id": "message", "type": "text", "content": "", "text": "old"
        }]);
        assert_eq!(terminal_text_value(Some(&blocks), "old"), "");
    }

    #[test]
    fn block_only_results_keep_order_and_distinct_ids_with_identical_text() {
        let blocks = json!([
            {"id": "one", "type": "text", "content": " same "},
            {"id": "tool", "type": "tool", "content": "not assistant text"},
            {"id": "two", "type": "output_text", "text": "same"},
            {"id": "three", "type": "text", "content": "新结果🙂"}
        ]);
        assert_eq!(
            terminal_text_value(Some(&blocks), ""),
            "same\nsame\n新结果🙂"
        );
    }

    /// Legacy callbacks may only provide a stream or tool metadata; preserve
    /// their exact aggregate instead of synthesizing an empty block result.
    #[test]
    fn legacy_results_without_text_content_keep_the_aggregate_verbatim() {
        for blocks in [
            json!(null),
            json!({}),
            json!([]),
            json!([{"type": "tool", "content": "tool output"}]),
            json!([{"type": "text"}]),
        ] {
            assert_eq!(terminal_text_value(Some(&blocks), " old\n"), " old\n");
        }
        assert_eq!(terminal_text_value(None, " old\n"), " old\n");
    }

    #[test]
    fn streamed_text_keeps_whitespace_across_block_boundaries() {
        let blocks = json!([
            {"id": "one", "type": "text", "content": "Hello "},
            {"id": "two", "type": "text", "content": "world\n"}
        ]);
        assert_eq!(
            terminal_text_value(Some(&blocks), "Hello world\n"),
            "Hello world\n"
        );
    }

    #[test]
    fn a_rewritten_stream_keeps_the_completed_blocks_whitespace() {
        let blocks = json!([
            {"id": "one", "type": "text", "content": "Hello "},
            {"id": "two", "type": "text", "content": "world\n"}
        ]);
        assert_eq!(
            terminal_text_value(Some(&blocks), "Old world\n"),
            "Hello world\n"
        );
    }

    #[test]
    fn one_missing_text_block_preserves_the_complete_stream_aggregate() {
        let blocks = json!([
            {"id": "expired", "type": "text"},
            {"id": "two", "type": "text", "content": "world"}
        ]);
        assert_eq!(
            terminal_text_value(Some(&blocks), "Hello world"),
            "Hello world"
        );
    }

    #[test]
    fn missing_blocks_without_an_aggregate_keep_the_available_text() {
        let blocks = json!([
            {"id": "expired", "type": "text"},
            {"id": "two", "type": "text", "content": " world "}
        ]);
        assert_eq!(terminal_text_value(Some(&blocks), ""), "world");
    }
}
