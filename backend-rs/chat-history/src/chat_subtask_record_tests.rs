// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for `GET /api/internal/chat/history/*/subtasks/*`.
//!
//! The page arithmetic fixtures are the recorded representative case
//! (`20261111052002`, case `f097f3ff-9d06-4afb-a36a-feaacc3ba1de`): a 24-block
//! assistant subtask, `max_chars=12952`, whose first page is units 0 and 1
//! (517 + 3898 chars) with `next_cursor="2:0"`.
use super::*;
use serde_json::json;

fn assistant(result: Value) -> RenderingRow {
    RenderingRow {
        id: 6_076_176_134_539_930,
        role: "ASSISTANT".into(),
        status: "COMPLETED".into(),
        prompt: None,
        result: Some(result),
    }
}

fn user(prompt: &str) -> RenderingRow {
    RenderingRow {
        id: 1,
        role: "USER".into(),
        status: "COMPLETED".into(),
        prompt: Some(prompt.into()),
        result: None,
    }
}

/// `paging_tests` keeps the recorded first-page assertions.
mod paging_tests {
    use super::*;

    /// The recorded first page: two units fit, the third does not, so the
    /// cursor stops at its boundary.
    #[test]
    fn first_page_stops_on_the_third_unit_boundary() {
        let first = "a".repeat(517);
        let second = "b".repeat(3898);
        let third = "c".repeat(11_735);
        let row = assistant(json!({
            "blocks": [
                {"type": "text", "content": first},
                {"type": "text", "content": second},
                {"type": "text", "content": third},
            ]
        }));

        let page = read_subtask_record(&row, "0:0", 12_952);
        assert_eq!(page.total_units, 3);
        assert_eq!(page.cursor, "0:0");
        assert_eq!(page.next_cursor.as_deref(), Some("2:0"));
        assert!(page.has_more);
        assert_eq!(page.content.chars().count(), 517 + 2 + 3898);
    }

    /// A single unit larger than the whole budget is split, and the cursor
    /// advances within it rather than skipping it.
    #[test]
    fn over_budget_unit_splits_within_itself() {
        let row = assistant(json!({
            "blocks": [{"type": "text", "content": "x".repeat(100)}]
        }));

        let page = read_subtask_record(&row, "0:0", 40);
        assert_eq!(page.content, "x".repeat(40));
        assert_eq!(page.next_cursor.as_deref(), Some("0:40"));
        assert!(page.has_more);

        let rest = read_subtask_record(&row, "0:40", 40);
        assert_eq!(rest.content, "x".repeat(40));
        assert_eq!(rest.cursor, "0:40");
        assert_eq!(rest.next_cursor.as_deref(), Some("0:80"));
    }

    /// The last page of a split unit reports no further work.
    #[test]
    fn final_within_unit_page_ends_the_cursor() {
        let row = assistant(json!({
            "blocks": [{"type": "text", "content": "x".repeat(100)}]
        }));
        let page = read_subtask_record(&row, "0:90", 40);
        assert_eq!(page.content, "x".repeat(10));
        assert_eq!(page.next_cursor, None);
        assert!(!page.has_more);
    }

    /// An empty page at the end keeps `has_more` false.
    #[test]
    fn cursor_at_end_returns_an_empty_page() {
        let row = assistant(json!({"blocks": [{"type": "text", "content": "hi"}]}));
        let page = read_subtask_record(&row, "1:0", 100);
        assert_eq!(page.content, "");
        assert_eq!(page.next_cursor, None);
        assert!(!page.has_more);
        assert_eq!(page.total_units, 1);
    }

    /// A cursor without a colon parses front-to-origin, and a non-numeric half
    /// keeps its origin value. A numeric unit index is clamped to `total`
    /// (`_parse_cursor`'s `max(0, min(unit_idx, total))`).
    #[test]
    fn malformed_cursor_falls_back_to_origin() {
        let row = assistant(json!({"blocks": [{"type": "text", "content": "hi"}]}));
        assert_eq!(read_subtask_record(&row, "nope", 100).cursor, "0:0");
        assert_eq!(read_subtask_record(&row, "abc:def", 100).cursor, "0:0");
        // `1` is a valid unit index on a one-unit subtask, so it clamps to 1.
        assert_eq!(read_subtask_record(&row, "1:abc", 100).cursor, "1:0");
    }

    /// The unit index clamps to `total`, and the char offset clamps at zero.
    #[test]
    fn cursor_clamps_out_of_range_values() {
        let row = assistant(json!({"blocks": [{"type": "text", "content": "hi"}]}));
        assert_eq!(read_subtask_record(&row, "9:0", 100).cursor, "1:0");
        assert_eq!(read_subtask_record(&row, "0:-5", 100).cursor, "0:0");
    }

    /// `max_chars=0` means the default budget.
    #[test]
    fn zero_max_chars_uses_the_default_budget() {
        let row = assistant(json!({
            "blocks": [{"type": "text", "content": "x".repeat(20_000)}]
        }));
        let page = read_subtask_record(&row, "0:0", 0);
        assert_eq!(
            page.content.chars().count(),
            DEFAULT_READ_MAX_CHARS as usize
        );
        assert_eq!(
            page.next_cursor.as_deref(),
            Some(format!("0:{DEFAULT_READ_MAX_CHARS}").as_str())
        );
    }
}

/// `rendering_tests` covers `_rendered_units`.
mod rendering_tests {
    use super::*;

    #[test]
    fn user_role_renders_its_prompt_as_one_unit() {
        assert_eq!(rendered_units(&user("hello")), vec!["hello".to_string()]);
    }

    #[test]
    fn empty_user_prompt_renders_no_units() {
        assert!(rendered_units(&user("")).is_empty());
    }

    #[test]
    fn text_block_renders_its_content() {
        let row = assistant(json!({"blocks": [{"type": "text", "content": "hi"}]}));
        assert_eq!(rendered_units(&row), vec!["hi".to_string()]);
    }

    #[test]
    fn tool_block_renders_name_input_and_output() {
        let row = assistant(json!({"blocks": [{
            "type": "tool",
            "tool_name": "list_history",
            "tool_input": {"page": 61},
            "tool_output": "{\"status\": \"success\"}",
        }]}));
        assert_eq!(
            rendered_units(&row),
            vec![
                "[tool: list_history] input={\"page\": 61}\noutput: {\"status\": \"success\"}"
                    .to_string()
            ]
        );
    }

    #[test]
    fn tool_block_defaults_its_name_and_empty_input() {
        let row = assistant(json!({"blocks": [{"type": "tool"}]}));
        assert_eq!(
            rendered_units(&row),
            vec!["[tool: tool] input={}".to_string()]
        );
    }

    /// A `thinking` block is not one of the rendered types, so the source's
    /// `json.dumps(block)` fallback applies with Python's key order and
    /// `ensure_ascii=False`.
    #[test]
    fn unknown_block_type_falls_back_to_json() {
        let row = assistant(json!({"blocks": [{
            "id": "thinking-abc",
            "type": "thinking",
            "status": "done",
            "content": "plan",
        }]}));
        assert_eq!(
            rendered_units(&row),
            vec![
                "{\"id\": \"thinking-abc\", \"type\": \"thinking\", \"status\": \"done\", \"content\": \"plan\"}"
                    .to_string()
            ]
        );
    }

    #[test]
    fn guidance_and_subagent_render_their_content() {
        let row = assistant(json!({"blocks": [
            {"type": "guidance", "content": "g"},
            {"type": "subagent", "content": "s"},
        ]}));
        assert_eq!(rendered_units(&row), vec!["g".to_string(), "s".to_string()]);
    }

    #[test]
    fn empty_rendered_units_are_dropped() {
        let row = assistant(json!({"blocks": [
            {"type": "text", "content": ""},
            {"type": "text", "content": "kept"},
        ]}));
        assert_eq!(rendered_units(&row), vec!["kept".to_string()]);
    }

    #[test]
    fn messages_chain_is_the_fallback_without_blocks() {
        let row = assistant(json!({"messages_chain": [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "a", "tool_calls": [{"id": "c1"}]},
        ]}));
        assert_eq!(
            rendered_units(&row),
            vec![
                "user: q".to_string(),
                "assistant: a\n[tool_calls: [{\"id\": \"c1\"}]]".to_string(),
            ]
        );
    }

    #[test]
    fn value_is_the_last_fallback() {
        let row = assistant(json!({"value": "only text"}));
        assert_eq!(rendered_units(&row), vec!["only text".to_string()]);
    }

    #[test]
    fn empty_value_renders_no_units() {
        let row = assistant(json!({"value": ""}));
        assert!(rendered_units(&row).is_empty());
    }

    /// A non-object `result` is `{}` in the source, so it renders nothing.
    #[test]
    fn non_object_result_renders_no_units() {
        let row = assistant(json!("not-an-object"));
        assert!(rendered_units(&row).is_empty());
    }
}

/// `record_shape_tests` pins the response envelope fields.
mod record_shape_tests {
    use super::*;

    #[test]
    fn record_exposes_role_lowercased_and_keeps_status_verbatim() {
        let mut row = assistant(json!({"blocks": [{"type": "text", "content": "x"}]}));
        row.role = "ASSISTANT".into();
        row.status = "COMPLETED".into();
        let record = read_subtask_record(&row, "0:0", 100);
        assert_eq!(record.role, "assistant");
        assert_eq!(record.status, "COMPLETED");
        assert_eq!(record.id, 6_076_176_134_539_930);
    }
}
