// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;
use wegent_executor::prompt_enrichment::inject_kb_meta_prompt;

#[test]
fn kb_meta_prompt_is_prepended_for_chat_string_prompt() {
    let result = inject_kb_meta_prompt(
        &json!("Save this file to the selected knowledge base."),
        "Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408",
        true,
        Some("chat"),
    );
    let text = result.as_str().unwrap();

    assert!(text.starts_with("<knowledge_base_guidance>\n"));
    assert!(text.contains("<knowledge_base_context>\n"));
    assert!(text.contains("Knowledge base routing:"));
    assert!(text.contains("KB Name: 222, KB ID: 1408"));
    assert!(text.ends_with("Save this file to the selected knowledge base."));
}

#[test]
fn code_task_does_not_inject_kb_meta_prompt() {
    let prompt = json!("Save this file to the selected knowledge base.");

    let result = inject_kb_meta_prompt(
        &prompt,
        "Available Knowledge Bases:\n- KB Name: 222, KB ID: 1408",
        false,
        Some("code"),
    );

    assert_eq!(result, prompt);
}

#[test]
fn selected_kb_guidance_names_document_tools_and_fallback_order() {
    let result = inject_kb_meta_prompt(
        &json!("Read the selected knowledge base document."),
        "Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408",
        true,
        Some("chat"),
    );
    let text = result.as_str().unwrap();

    assert!(text.contains("were selected by the user"));
    assert!(text.contains("First answer by querying the provided knowledge base ID(s)"));
    assert!(text.contains("broaden the query to all knowledge bases"));
    assert!(text.contains("then use web search or other external tools"));
    assert!(text.contains("wegent_kb_list_documents"));
    assert!(text.contains("identify which document matters"));
    assert!(text.contains("wegent_kb_read_document_content"));
    assert!(text.contains("document_id"));
    assert!(text.contains("offset"));
    assert!(text.contains("limit"));
    assert!(text
        .to_ascii_lowercase()
        .contains("do not construct mcp resource uris manually"));
}

#[test]
fn available_kb_guidance_uses_same_fallback_order() {
    let result = inject_kb_meta_prompt(
        &json!("What can you help me with?"),
        "Available Knowledge Bases:\n- KB Name: 222, KB ID: 1408",
        false,
        Some("chat"),
    );
    let text = result.as_str().unwrap();

    assert!(text.contains("provides knowledge base IDs that may answer the request"));
    assert!(text.contains("First answer by querying the provided knowledge base ID(s)"));
    assert!(text.contains("broaden the query to all knowledge bases"));
    assert!(text.contains("then use web search or other external tools"));
}

#[test]
fn kb_meta_prompt_is_prepended_to_input_text_content_block() {
    let result = inject_kb_meta_prompt(
        &json!([{"type": "input_text", "text": "Save this file."}]),
        "Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408",
        false,
        Some("chat"),
    );
    let text = result[0]["text"].as_str().unwrap();

    assert!(text.starts_with("<knowledge_base_guidance>\n"));
    assert!(text.contains("<knowledge_base_context>\n"));
    assert!(text.contains("KB Name: 222, KB ID: 1408"));
    assert!(text.ends_with("Save this file."));
}
