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
) -> PromptType:
    """Prepend KB metadata context for local executor requests only."""
    if executor_mode != "local" or not kb_meta_prompt:
        return prompt

    kb_priority = ""
    if is_user_selected_kb:
        kb_priority = (
            "<knowledge_base_priority>\n"
            "Use the selected knowledge base first for this request.\n"
            "- Use selected knowledge base tools and skills before web search or external lookup.\n"
            "- When you need to identify which document matters, call `wegent_kb_list_documents` first.\n"
            "- When you need the content of a specific knowledge base document, call\n"
            "  `wegent_kb_read_document_content` with `document_id` and optional `offset`/`limit`.\n"
            "- Pass `knowledge_base_id` when calling `wegent_kb_list_documents`.\n"
            "- Do not construct MCP resource URIs manually.\n"
            "- Use web search only if the user explicitly asks for external or current web information,\n"
            "  or if knowledge base retrieval cannot answer the request.\n"
            "</knowledge_base_priority>\n"
        )

    kb_context = (
        f"{kb_priority}<knowledge_base_context>\n"
        f"{kb_meta_prompt}\n"
        "</knowledge_base_context>"
    )
    if isinstance(prompt, list):
        return append_text_to_vision_prompt(prompt, kb_context, prepend=True)
    return f"{kb_context}\n\n{prompt}"
