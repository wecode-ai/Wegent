// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::attachments::append_text_to_vision_prompt;

pub fn inject_kb_meta_prompt(
    prompt: &Value,
    kb_meta_prompt: &str,
    is_user_selected_kb: bool,
    task_type: Option<&str>,
) -> Value {
    let kb_meta_prompt = kb_meta_prompt.trim();
    if kb_meta_prompt.is_empty() || is_code_task(task_type) {
        return prompt.clone();
    }

    let kb_context = build_kb_context(kb_meta_prompt, is_user_selected_kb);
    match prompt {
        Value::String(text) => Value::String(format!("{kb_context}\n\n{text}")),
        Value::Array(_) => append_text_to_vision_prompt(prompt, &kb_context, true),
        _ => prompt.clone(),
    }
}

fn build_kb_context(kb_meta_prompt: &str, is_user_selected_kb: bool) -> String {
    let mut guidance_lines = vec![
        "<knowledge_base_guidance>".to_owned(),
        "Knowledge base routing:".to_owned(),
    ];
    if is_user_selected_kb {
        guidance_lines.push(
            "- The knowledge base IDs in the context below were selected by the user.".to_owned(),
        );
    } else {
        guidance_lines.push(
            "- The context below provides knowledge base IDs that may answer the request."
                .to_owned(),
        );
    }
    guidance_lines.extend([
        "- First answer by querying the provided knowledge base ID(s). When a Wegent knowledge tool accepts `knowledge_base_id` or `knowledge_base_ids`, pass the ID(s) from the context.".to_owned(),
        "- If the provided knowledge base ID(s) cannot satisfy the request because results are empty, irrelevant, inaccessible, or incomplete, broaden the query to all knowledge bases when the tool supports it.".to_owned(),
        "- If knowledge base retrieval still cannot answer the request, then use web search or other external tools when available and appropriate.".to_owned(),
        "- When you need to identify which document matters, call `wegent_kb_list_documents` first.".to_owned(),
        "- When you need the content of a specific knowledge base document, call".to_owned(),
        "  `wegent_kb_read_document_content` with `document_id` and optional `offset`/`limit`.".to_owned(),
        "- Do not construct MCP resource URIs manually.".to_owned(),
        "</knowledge_base_guidance>".to_owned(),
    ]);

    format!(
        "{}\n<knowledge_base_context>\n{}\n</knowledge_base_context>",
        guidance_lines.join("\n"),
        kb_meta_prompt
    )
}

fn is_code_task(task_type: Option<&str>) -> bool {
    task_type
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("code"))
}
