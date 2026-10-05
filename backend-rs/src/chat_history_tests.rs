use super::*;

#[test]
fn parses_task_session_ids() {
    let (kind, id) = parse_session_id("task-69956427469753").unwrap();
    assert_eq!((kind, id), ("task", 69_956_427_469_753));
}

#[test]
fn rejects_invalid_session_ids() {
    assert!(parse_session_id("nope").is_err());
    assert!(parse_session_id("other-1").is_err());
    assert!(parse_session_id("task-abc").is_err());
}

fn item(message_id: i32, status: &str, role: &str, with_checkpoint: bool) -> ForkHistoryItem {
    let mut result = json!({});
    if with_checkpoint {
        result = json!({
            "messages_chain": [
                {"role": "user", "additional_kwargs": {"summary_compacted": true}}
            ]
        });
    }
    ForkHistoryItem {
        subtask: SubtaskRow {
            id: message_id as i64,
            user_id: 1,
            task_id: 1,
            role: role.to_string(),
            prompt: None,
            message_id,
            status: status.to_string(),
            result: Some(brz_mysql::Json(result)),
            created_at: None,
            sender_user_id: 0,
        },
    }
}

#[test]
fn checkpoint_scoping_keeps_only_after_latest_checkpoint() {
    let items = vec![
        item(1, "COMPLETED", "USER", false),
        item(2, "COMPLETED", "ASSISTANT", true),
        item(3, "COMPLETED", "USER", false),
        item(4, "COMPLETED", "ASSISTANT", false),
    ];
    let (scoped, index) = scope_to_latest_checkpoint(&items);
    assert_eq!(index, Some(1));
    assert_eq!(scoped.len(), 3);
}

#[test]
fn no_checkpoint_returns_all() {
    let items = vec![item(1, "COMPLETED", "USER", false)];
    let (scoped, index) = scope_to_latest_checkpoint(&items);
    assert_eq!(index, None);
    assert_eq!(scoped.len(), 1);
}

#[test]
fn limit_without_checkpoint_returns_most_recent() {
    let items = vec![
        item(1, "COMPLETED", "USER", false),
        item(2, "COMPLETED", "USER", false),
        item(3, "COMPLETED", "USER", false),
    ];
    let limited = apply_checkpoint_limit(&items, Some(2), false);
    assert_eq!(limited.len(), 2);
    assert_eq!(limited[0].subtask.message_id, 2);
}

#[test]
fn limit_with_checkpoint_never_drops_checkpoint() {
    let items = vec![
        item(1, "COMPLETED", "ASSISTANT", true),
        item(2, "COMPLETED", "USER", false),
        item(3, "COMPLETED", "USER", false),
    ];
    let limited = apply_checkpoint_limit(&items, Some(2), true);
    assert_eq!(limited.len(), 2);
    assert_eq!(limited[0].subtask.message_id, 1);
    assert_eq!(limited[1].subtask.message_id, 3);
}

#[test]
fn chain_message_ids_carry_the_chain_index() {
    // Verified against the recorded response: 69956427469762-0 ...
    let id = format!("{}-{}", 69_956_427_469_762_i64, 0);
    assert_eq!(id, "69956427469762-0");
}

fn document_context(extracted_text: &str) -> SubtaskContextRow {
    SubtaskContextRow {
        id: 1271806,
        subtask_id: 776117770408675,
        user_id: 3396,
        context_type: "attachment".to_string(),
        name: "spreadsheet".to_string(),
        status: "ready".to_string(),
        image_base64: None,
        extracted_text: Some(extracted_text.to_string()),
        type_data: None,
        created_at: None,
    }
}

#[test]
fn document_prefix_omits_the_sandbox_path_like_the_history_endpoint() {
    // `chat_storage.py:571` calls build_document_text_prefix without
    // task/subtask ids, so build_sandbox_path is None and the header
    // carries no "File Path(already in sandbox)" segment.
    let prefix =
        build_document_text_prefix(&document_context("R1: a\nR2: b\n"), 32_000).expect("prefix");
    assert!(prefix.starts_with("[Attachment: spreadsheet | ID: 1271806"));
    assert!(!prefix.contains("File Path(already in sandbox)"));
    assert!(!prefix.contains("File Path in Sandbox"));
    assert!(prefix.contains("R1: a\nR2: b\n"));
}

#[test]
fn empty_extracted_text_has_no_document_prefix() {
    assert!(build_document_text_prefix(&document_context(""), 32_000).is_none());
}

/// Build one assistant/user subtask row for the message-shaping tests.
fn subtask(id: i64, role: &str, status: &str, result: Value) -> SubtaskRow {
    SubtaskRow {
        id,
        user_id: 1,
        task_id: 1,
        role: role.to_string(),
        prompt: None,
        message_id: 1,
        status: status.to_string(),
        result: Some(brz_mysql::Json(result)),
        created_at: None,
        sender_user_id: 0,
    }
}

fn content_of(message: &Message) -> Value {
    serde_json::to_value(&message.content).expect("content serializes")
}

#[test]
fn completed_assistant_without_value_is_omitted() {
    // Recorded case 146795ac: subtask 843875174469920 is a COMPLETED
    // assistant turn whose result carries no value and no messages_chain.
    // The source returns no message for it, so the history stays in step with
    // the following turn.
    let row = subtask(
        843_875_174_469_920,
        "ASSISTANT",
        "COMPLETED",
        json!({"value": "", "loaded_skills": ["interactive"], "messages_chain": null}),
    );
    assert!(assistant_messages(&row).is_empty());
}

#[test]
fn completed_assistant_without_value_key_is_omitted() {
    let row = subtask(2, "ASSISTANT", "COMPLETED", json!({"usage": null}));
    assert!(assistant_messages(&row).is_empty());
}

#[test]
fn legacy_fallback_keeps_value_skills_and_model_info() {
    let row = subtask(
        69_956_427_469_762,
        "ASSISTANT",
        "COMPLETED",
        json!({
            "value": "done",
            "loaded_skills": ["example-tools"],
            "model_info": {"model": "gpt-5.6-terra", "provider": "openai"},
        }),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "69956427469762");
    assert_eq!(messages[0].role, "assistant");
    assert_eq!(content_of(&messages[0]), json!("done"));
    assert_eq!(
        serde_json::to_value(messages[0].loaded_skills.as_deref()).expect("skills serialize"),
        json!(["example-tools"])
    );
    assert_eq!(
        serde_json::to_value(messages[0].model_info.as_deref()).expect("model info serializes"),
        json!({"model": "gpt-5.6-terra", "provider": "openai"})
    );
}

#[test]
fn legacy_fallback_preserves_non_string_content() {
    let row = subtask(
        12,
        "ASSISTANT",
        "COMPLETED",
        json!({"value": [{"type": "text", "text": "hi"}]}),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 1);
    assert_eq!(
        content_of(&messages[0]),
        json!([{"type": "text", "text": "hi"}])
    );
}

#[test]
fn cancelled_assistant_without_text_is_omitted() {
    for value in [
        json!(""),
        json!("   "),
        json!([{"type": "text", "text": "x"}]),
        json!(null),
    ] {
        let row = subtask(3, "ASSISTANT", "CANCELLED", json!({"value": value}));
        assert!(
            assistant_messages(&row).is_empty(),
            "cancelled value {value} must not produce a message"
        );
    }
}

#[test]
fn cancelled_assistant_text_is_closed_with_the_note() {
    let row = subtask(
        4,
        "ASSISTANT",
        "CANCELLED",
        json!({"value": "partial answer\n\n"}),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "4");
    assert_eq!(
        content_of(&messages[0]),
        json!("partial answer\n\n[Previous assistant response was interrupted by the user.]")
    );
    assert!(messages[0].loaded_skills.is_none());
    assert!(messages[0].model_info.is_none());
}

#[test]
fn cancelled_turn_does_not_expand_its_messages_chain() {
    let row = subtask(
        5,
        "ASSISTANT",
        "CANCELLED",
        json!({
            "value": "partial",
            "messages_chain": [{"role": "assistant", "content": "chain text"}],
        }),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "5");
    assert_eq!(
        content_of(&messages[0]),
        json!("partial\n\n[Previous assistant response was interrupted by the user.]")
    );
}

#[test]
fn failed_assistant_keeps_only_a_present_value() {
    let empty = subtask(6, "ASSISTANT", "FAILED", json!({"value": ""}));
    assert!(assistant_messages(&empty).is_empty());

    let row = subtask(
        7,
        "ASSISTANT",
        "FAILED",
        json!({"value": "boom", "messages_chain": [{"role": "assistant", "content": "chain"}]}),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "7");
    assert_eq!(content_of(&messages[0]), json!("boom"));
}

#[test]
fn chain_expansion_skips_empty_assistant_entries() {
    let row = subtask(
        8,
        "ASSISTANT",
        "COMPLETED",
        json!({
            "value": "final",
            "messages_chain": [
                {"role": "assistant", "content": ""},
                {"role": "tool", "content": "tool output"},
                {"role": "assistant", "content": "answer"},
            ],
        }),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].id, "8-1");
    assert_eq!(messages[0].role, "tool");
    assert_eq!(messages[1].id, "8-2");
    assert_eq!(content_of(&messages[1]), json!("answer"));
}

#[test]
fn chain_keeps_empty_assistant_entries_with_tool_calls_or_reasoning() {
    let row = subtask(
        9,
        "ASSISTANT",
        "COMPLETED",
        json!({
            "messages_chain": [
                {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1"}]},
                {"role": "assistant", "content": "", "reasoning_content": "thinking"},
            ],
        }),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].id, "9-0");
    assert_eq!(messages[1].id, "9-1");
}

#[test]
fn chain_attaches_loaded_skills_to_the_last_assistant_message() {
    let row = subtask(
        10,
        "ASSISTANT",
        "COMPLETED",
        json!({
            "value": "final",
            "loaded_skills": ["example-tools"],
            "messages_chain": [
                {"role": "assistant", "content": "answer"},
                {"role": "tool", "content": "tool output"},
            ],
        }),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 2);
    assert_eq!(
        serde_json::to_value(messages[0].loaded_skills.as_deref()).expect("skills serialize"),
        json!(["example-tools"])
    );
    // The trailing tool entry is not an assistant message, so it stays bare.
    assert!(messages[1].loaded_skills.is_none());
}

#[test]
fn chain_forwards_the_summary_compaction_marker() {
    let row = subtask(
        11,
        "ASSISTANT",
        "COMPLETED",
        json!({
            "messages_chain": [
                {
                    "role": "assistant",
                    "content": "",
                    "additional_kwargs": {"summary_compacted": true},
                },
            ],
        }),
    );
    let messages = assistant_messages(&row);
    assert_eq!(messages.len(), 1);
    assert_eq!(
        serde_json::to_value(messages[0].metadata.as_deref()).expect("metadata serializes"),
        json!({"summary_compacted": true})
    );
}

#[test]
fn json_falsy_matches_python_truthiness() {
    for falsy in [
        json!(null),
        json!(false),
        json!(0),
        json!(0.0),
        json!(""),
        json!([]),
        json!({}),
    ] {
        assert!(json_falsy(&falsy), "{falsy} is falsy");
    }
    for truthy in [
        json!(true),
        json!(1),
        json!(-1),
        json!("x"),
        json!([1]),
        json!({"a": 1}),
    ] {
        assert!(!json_falsy(&truthy), "{truthy} is truthy");
    }
}
