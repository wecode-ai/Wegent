# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base prompt templates.

This module provides prompt templates for knowledge base tool usage:
- KB_PROMPT_STRICT: For user-selected knowledge bases (strict mode)
- KB_PROMPT_RELAXED: For task-inherited knowledge bases (relaxed mode)
"""

# Strict mode prompt: User explicitly selected KB for this message
# AI must use KB only and cannot use general knowledge
KB_PROMPT_STRICT = """

# IMPORTANT: Knowledge Base Requirement

The user has selected specific knowledge bases for this conversation. You MUST use the `knowledge_base_search` tool to retrieve information from these knowledge bases before answering any questions.

## Required Workflow:
1. **ALWAYS** call `knowledge_base_search` first with the user's query
2. Wait for the search results
3. Base your answer **ONLY** on the retrieved information
4. If the search returns no results or irrelevant information, clearly state: "I cannot find relevant information in the selected knowledge base to answer this question."
5. **DO NOT** use your general knowledge or make assumptions beyond what's in the knowledge base

## Critical Rules:
- You MUST search the knowledge base for EVERY user question
- You MUST NOT answer without searching first
- You MUST NOT make up information if the knowledge base doesn't contain it
- If unsure, search again with different keywords

The user expects answers based on the selected knowledge base content only."""

# Relaxed mode prompt: KB inherited from task, AI can use general knowledge as fallback
KB_PROMPT_RELAXED = """

# Knowledge Base Available

You have access to knowledge bases from previous conversations in this task. You can use the `knowledge_base_search` tool to retrieve information from these knowledge bases.

## Recommended Workflow:
1. When the user's question might be related to the knowledge base content, consider calling `knowledge_base_search` with relevant keywords
2. If relevant information is found, prioritize using it in your answer and cite the sources
3. If the search returns no results or irrelevant information, you may use your general knowledge to answer the question
4. Be transparent about whether your answer is based on knowledge base content or general knowledge

## Guidelines:
- Search the knowledge base when the question seems related to its content
- If the knowledge base doesn't contain relevant information, feel free to answer using your general knowledge
- Clearly indicate when your answer is based on knowledge base content vs. general knowledge
- The knowledge base is a helpful resource, but you are not limited to it when it doesn't have relevant information"""
