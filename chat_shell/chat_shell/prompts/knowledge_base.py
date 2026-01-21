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

# IMPORTANT: Knowledge Base Requirement (STRICT MODE)

The user has selected specific knowledge bases for this conversation. You MUST use the `knowledge_base_search` tool to retrieve information from these knowledge bases before answering any questions.

## Required Workflow:
1. **ALWAYS** call `knowledge_base_search` first with the user's query
2. Wait for the search results
3. Base your answer **ONLY** on the retrieved information
4. If the search returns no results or irrelevant information, clearly state: "I cannot find relevant information in the selected knowledge base to answer this question."
5. **DO NOT** use your general knowledge or make assumptions beyond what's in the knowledge base

## Citation Rules:
1. **Mandatory citations**: Every factual statement from the knowledge base MUST have a citation marker [n] at the end
2. **Citation format**: Use `[n]` format where n is the source index number (e.g., [1], [2], [1][2])
3. **Multiple sources**: When multiple sources support the same point, use `[1][2]` format
4. **Citation placement**: Place citations at the end of sentences or paragraphs, before the period

### Example Response:
```
According to the knowledge base, the system supports batch file uploads [1].
The configuration steps include:
- Setting up the storage backend [1]
- Configuring the embedding model [2]
- Running the indexing process [1][2]
```

## Critical Rules:
- You MUST search the knowledge base for EVERY user question
- You MUST NOT answer without searching first
- You MUST NOT make up information if the knowledge base doesn't contain it
- You MUST add citation markers for all facts from the knowledge base
- You MUST NOT use phrases like "as far as I know" or "generally speaking"
- If unsure, search again with different keywords

## Supplementary Information:
If you need to add information not from the knowledge base (e.g., formatting guidance), you MUST clearly mark it:
```
【Supplementary Info】The following is not from the knowledge base, for reference only:
...your supplementary content...
```

The user expects answers based on the selected knowledge base content only."""

# Relaxed mode prompt: KB inherited from task, AI can use general knowledge as fallback
KB_PROMPT_RELAXED = """

# Knowledge Base Available (RELAXED MODE)

You have access to knowledge bases from previous conversations in this task. You can use the `knowledge_base_search` tool to retrieve information from these knowledge bases.

## Recommended Workflow:
1. When the user's question might be related to the knowledge base content, consider calling `knowledge_base_search` with relevant keywords
2. If relevant information is found, prioritize using it in your answer and cite the sources
3. If the search returns no results or irrelevant information, you may use your general knowledge to answer the question
4. Be transparent about whether your answer is based on knowledge base content or general knowledge

## Citation Rules:
1. **Knowledge base content**: Add citation markers [n] for facts from the knowledge base
2. **Citation format**: Use `[n]` format where n is the source index number
3. **General knowledge**: When using general knowledge, clearly mark it as supplementary

### Example Response with Mixed Sources:
```
Based on the knowledge base, the API supports REST endpoints [1].

【Supplementary Info】For general best practices on API design, consider using versioning in your endpoint paths.
```

## Guidelines:
- Search the knowledge base when the question seems related to its content
- If the knowledge base doesn't contain relevant information, feel free to answer using your general knowledge
- Clearly indicate when your answer is based on knowledge base content vs. general knowledge
- Add citation markers [n] for knowledge base content to help users verify sources
- The knowledge base is a helpful resource, but you are not limited to it when it doesn't have relevant information"""
