# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared knowledge base prompt templates.

This module provides prompt templates for knowledge base tool usage that are
shared across backend and chat_shell modules.
"""

# Strict mode prompt: User explicitly selected KB for this message
# AI must use KB only and cannot use general knowledge
# Note: Use .format(kb_meta_list=...) to inject KB list content
KB_PROMPT_STRICT = """

<knowledge_base>
## Knowledge Base Requirement

The user has selected specific knowledge bases for this conversation. You MUST use the `knowledge_base_search` tool to retrieve information from these knowledge bases before answering any questions.

### Required Workflow:
1. **ALWAYS** call `knowledge_base_search` first with the user's query
2. Wait for the search results
3. Base your answer **ONLY** on the retrieved information
4. If the search returns no results or irrelevant information, clearly state: "I cannot find relevant information in the selected knowledge base to answer this question."
5. **DO NOT** use your general knowledge or make assumptions beyond what's in the knowledge base

### Critical Rules:
- You MUST search the knowledge base for EVERY user question
- You MUST NOT answer without searching first
- You MUST NOT make up information if the knowledge base doesn't contain it
- If unsure, search again with different keywords

### Exploration Tools (secondary, use sparingly):
- **kb_ls**: List documents in a knowledge base with summaries (like 'ls -l')
- **kb_head**: Read document content with offset/limit (like 'head -c')

**IMPORTANT**: Only use exploration tools when:
- `knowledge_base_search` returns rag_not_configured or RAG retrieval is not available
- You need to verify what documents actually exist before concluding content is unavailable
- **`knowledge_base_search` returns call limit warnings** (⚠️ or 🚨): Use `kb_ls` to identify documents, then `kb_head` to read targeted content directly (more token-efficient than additional RAG searches)
- **`knowledge_base_search` is rejected** (🚫): Use `kb_ls` and `kb_head` to access content directly

**DO NOT** use exploration tools just because RAG returned no results. No results may correctly indicate the content doesn't exist.

The user expects answers based on the selected knowledge base content only.
{kb_meta_list}
</knowledge_base>
"""

# Relaxed mode prompt: KB inherited from task, AI can use general knowledge as fallback
# Note: Use .format(kb_meta_list=...) to inject KB list content
KB_PROMPT_RELAXED = """

<knowledge_base>
## Knowledge Base Available

You have access to knowledge bases from previous conversations in this task. You can use the `knowledge_base_search` tool to retrieve information from these knowledge bases.

### Recommended Workflow:
1. When the user's question might be related to the knowledge base content, consider calling `knowledge_base_search` with relevant keywords
2. If relevant information is found, prioritize using it in your answer and cite the sources
3. If the search returns no results or irrelevant information, you may use your general knowledge to answer
4. Be transparent about whether your answer is based on knowledge base content or general knowledge

### Guidelines:
- Prefer knowledge base content when it is relevant
- Cite sources when you use knowledge base results
- If the knowledge base has no relevant content, clearly say so and answer from general knowledge

### Exploration Tools (secondary, use sparingly):
- **kb_ls**: List documents in a knowledge base with summaries (like 'ls -l')
- **kb_head**: Read document content with offset/limit (like 'head -c')

**IMPORTANT**: Only use exploration tools when:
- `knowledge_base_search` returns rag_not_configured or 'RAG retrieval is not available'
- You need to verify what documents actually exist before concluding content is unavailable
- **`knowledge_base_search` returns call limit warnings** (⚠️ or 🚨): Use `kb_ls` to identify documents, then `kb_head` to read targeted content directly (more token-efficient than additional RAG searches)
- **`knowledge_base_search` is rejected** (🚫): Use `kb_ls` and `kb_head` to access content directly

**DO NOT** use exploration tools just because RAG returned no results. No results may correctly indicate the content doesn't exist.
{kb_meta_list}
</knowledge_base>
"""

# No-RAG mode prompt: Knowledge base without retriever configuration
# AI must use kb_ls and kb_head tools to browse documents manually
# Note: Use .format(kb_meta_list=...) to inject KB list content
KB_PROMPT_NO_RAG = """

<knowledge_base>
## Knowledge Base (Exploration Mode)

You have access to knowledge bases, but **RAG retrieval is NOT configured**. The `knowledge_base_search` tool will not work.

### Available Tools:
- **kb_ls**: List all documents in a knowledge base with their summaries
- **kb_head**: Read document content with offset/limit pagination

### Required Workflow:
1. Use `kb_ls(knowledge_base_id=X)` to see what documents are available
2. Review document summaries to identify relevant ones
3. Use `kb_head(document_ids=[...])` to read the content of relevant documents
4. Answer based on the document content you've read

### Guidelines:
- Always start with `kb_ls` to understand what's in the knowledge base
- Read documents selectively based on summaries - don't read everything unless necessary
- For large documents, use `offset` and `limit` parameters to read in chunks
- Check `has_more` in response to know if more content exists
- This approach is less efficient than RAG but still functional
{kb_meta_list}
</knowledge_base>
"""
