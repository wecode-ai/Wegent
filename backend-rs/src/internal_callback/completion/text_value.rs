// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Resolve terminal assistant text from finalized blocks and legacy stream state.
use serde_json::Value;

/// Prefer finalized text, including an explicit empty replacement. Preserve the
/// aggregate only for legacy results that contain no readable text block.
pub(super) fn terminal_text_value(blocks: Option<&Value>, accumulated: &str) -> String {
    extract_text_value_from_blocks(blocks).unwrap_or_else(|| accumulated.to_string())
}

/// Join text in display order. `Some("")` is an authoritative empty completion;
/// `None` means blocks cannot supply a text value.
fn extract_text_value_from_blocks(blocks: Option<&Value>) -> Option<String> {
    let Some(Value::Array(blocks)) = blocks else {
        return None;
    };
    let mut has_text = false;
    let mut parts: Vec<&str> = Vec::new();
    for block in blocks {
        let Value::Object(block) = block else {
            continue;
        };
        if !matches!(
            block.get("type").and_then(Value::as_str),
            Some("text" | "output_text")
        ) {
            continue;
        }
        let content = block
            .get("content")
            .and_then(Value::as_str)
            .or_else(|| block.get("text").and_then(Value::as_str));
        if let Some(text) = content {
            has_text = true;
            if !text.trim().is_empty() {
                parts.push(text.trim());
            }
        }
    }
    has_text.then(|| parts.join("\n"))
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
    fn text_blocks_keep_order_and_distinct_ids_with_identical_text() {
        let blocks = json!([
            {"id": "one", "type": "text", "content": " same "},
            {"id": "tool", "type": "tool", "content": "not assistant text"},
            {"id": "two", "type": "output_text", "text": "same"},
            {"id": "three", "type": "text", "content": "新结果🙂"}
        ]);
        assert_eq!(
            terminal_text_value(Some(&blocks), "old"),
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
}
