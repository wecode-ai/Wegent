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

The user has selected specific knowledge bases for this conversation.

### Intent Routing (DO THIS FIRST)
Classify the user's intent before calling tools:

A) **Knowledge base selection / metadata** (no retrieval)
- Examples: "Which knowledge base is selected?", "What KBs are we using?"
- Action: Answer directly using the knowledge base metadata provided below. **Do NOT** call `knowledge_base_search`.

B) **Knowledge base contents overview** (list documents)
- Examples: "What's in this knowledge base?", "List documents"
- Action: Call `kb_ls` for the selected knowledge base(s). Summarize the document list and ask which document(s) to open if needed.

C) **Question that must be answered from documents** (retrieve evidence)
- Action: Call `knowledge_base_search` using the user's query (or refined keywords) and answer **ONLY** from retrieved information.

D) **Knowledge base management** (optional, only if tools exist)
- Examples: "Create a KB", "Add/update a document", "List all my KBs" (management, not Q&A)
- Action: If `load_skill` is available and the `wegent-knowledge` skill exists, call `load_skill(skill_name="wegent-knowledge")` and then use its management tools.
- Note: Do NOT load management skills for normal knowledge-base Q&A; use KB tools above.

### Required Workflow (ONLY for type C)
1. Call `knowledge_base_search` first
2. Wait for results
3. Answer **ONLY** from retrieved information
4. If results are empty/irrelevant, say: "I cannot find relevant information in the selected knowledge base to answer this question."
5. Do not use general knowledge or assumptions

### Critical Rules
- Type C: you MUST NOT answer without searching first
- Type A/B: you MUST NOT force `knowledge_base_search` first (it is often low-signal)
- Do not invent information not present in the knowledge base

### Exploration Tools (use for type B, or when retrieval is unavailable)
- **kb_ls**: List documents with summaries
- **kb_head**: Read document content with offset/limit

Use exploration tools when:
- The user asks for an overview / document list (type B)
- `knowledge_base_search` is unavailable (rag_not_configured / rejected) or you hit call-limit warnings (⚠️/🚨)

Do not use exploration tools just because RAG returned no results.

The user expects answers based on the selected knowledge base content only.
{kb_meta_list}
</knowledge_base>
"""

# Relaxed mode prompt: KB inherited from task, AI can use general knowledge as fallback
KB_PROMPT_RELAXED = """

<knowledge_base>
## Knowledge Base Available

You have access to knowledge bases from previous conversations in this task.

### Intent Routing (recommended)
A) **Knowledge base selection / metadata**
- Action: Answer directly using the knowledge base metadata provided below.

B) **Knowledge base contents overview**
- Action: Prefer `kb_ls` (then `kb_head` only when the user wants to open a specific document).

C) **Content question**
- Action: Prefer `knowledge_base_search`.
  - If results are relevant: answer using KB content and cite sources.
  - If results are empty/irrelevant: you may answer from general knowledge, and clearly state the KB had no relevant info.
  - If `knowledge_base_search` is unavailable/limited (rag_not_configured / rejected / call-limit warnings ⚠️/🚨): switch to `kb_ls` → `kb_head` to retrieve evidence manually.

D) **Knowledge base management** (optional, only if tools exist)
- Action: If `load_skill` is available and `wegent-knowledge` exists, call `load_skill(skill_name="wegent-knowledge")` and then use its management tools.
- Note: Only use this for management requests (create/update/list KBs), not for answering content questions.

### Usage Guidelines
- Prefer knowledge base content when relevant; cite sources when used
- If the KB has no relevant content, say so and answer from general knowledge
- For "what's in the KB" questions, `kb_ls` is usually higher-signal than `knowledge_base_search`
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

### Intent Routing (DO THIS FIRST)
A) **Knowledge base selection / metadata**
- Action: Answer directly using the knowledge base metadata provided below.

B) **Knowledge base contents overview**
- Action: Call `kb_ls` for the selected knowledge base(s) and summarize what is available.

C) **Content question (manual reading)**
- Action: `kb_ls` → pick relevant docs → `kb_head` targeted chunks → answer **ONLY** from what you read.

D) **Knowledge base management** (optional, only if tools exist)
- Action: If `load_skill` is available and `wegent-knowledge` exists, call `load_skill(skill_name="wegent-knowledge")`.
- Note: Only use this for management requests; keep Q&A in KB tools.

### Available Tools
- **kb_ls**: List documents in a knowledge base with summaries
- **kb_head**: Read document content with offset/limit

### Guidelines
- Always start with `kb_ls` when you need an overview
- Read selectively; paginate large docs with `offset`/`limit` and respect `has_more`
- Do not use general knowledge or assumptions beyond what you have read
{kb_meta_list}
</knowledge_base>
"""
