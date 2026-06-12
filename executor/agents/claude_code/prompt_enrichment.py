# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompt enrichment helpers for Claude Code requests."""

from typing import Any, Union

from executor.agents.claude_code.multimodal_prompt import append_text_to_vision_prompt

PromptType = Union[str, list[dict[str, Any]]]


def inject_kb_meta_prompt(
    prompt: PromptType,
    kb_meta_prompt: str,
    *,
    executor_mode: str,
    is_user_selected_kb: bool,
    task_type: str | None = None,
) -> PromptType:
    """Prepend KB metadata context for non-code Claude Code requests."""
    if not kb_meta_prompt:
        return prompt

    if (task_type or "").strip().lower() == "code":
        return prompt

    guidance_lines = [
        "<knowledge_base_guidance>",
        "Knowledge base routing:",
    ]
    if is_user_selected_kb:
        guidance_lines.append(
            "- The knowledge base IDs in the context below were selected by the user."
        )
    else:
        guidance_lines.append(
            "- The context below provides knowledge base IDs that may answer the request."
        )
    guidance_lines.extend(
        [
            "- First answer by querying the provided knowledge base ID(s). When a Wegent knowledge tool accepts `knowledge_base_id` or `knowledge_base_ids`, pass the ID(s) from the context.",
            "- If the provided knowledge base ID(s) cannot satisfy the request because results are empty, irrelevant, inaccessible, or incomplete, broaden the query to all knowledge bases when the tool supports it.",
            "- If knowledge base retrieval still cannot answer the request, then use web search or other external tools when available and appropriate.",
            "- When you need to identify which document matters, call `wegent_kb_list_documents` first.",
            "- When you need the content of a specific knowledge base document, call",
            "  `wegent_kb_read_document_content` with `document_id` and optional `offset`/`limit`.",
            "- Do not construct MCP resource URIs manually.",
            "</knowledge_base_guidance>",
        ]
    )
    kb_guidance = "\n".join(guidance_lines) + "\n"

    kb_context = (
        f"{kb_guidance}<knowledge_base_context>\n"
        f"{kb_meta_prompt}\n"
        "</knowledge_base_context>"
    )
    if isinstance(prompt, list):
        return append_text_to_vision_prompt(prompt, kb_context, prepend=True)
    return f"{kb_context}\n\n{prompt}"
