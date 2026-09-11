---
description: "Access the external wiki site through the Wegent wiki bridge MCP. Use this skill when the selected knowledge sources include an external wiki site, subtree, or single page."
displayName: "外部 Wiki"
version: "1.0.0"
author: "Wegent Team"
tags: ["knowledge", "wiki", "external"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
mcpServers:
  external_wiki:
    type: streamable-http
    url: "${{backend_url}}/mcp/wiki/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 180
---

# External Wiki

Use the external wiki bridge MCP directly. Resources in `<selected_knowledge_sources>`
are wiki-native paths (e.g. `docs/architecture/overview`).

- For a whole site, start from `wiki_search` with the user's question, then read the
  matching pages with `wiki_get_page`; use `wiki_list_pages` when the topic is unclear.
- For a selected path subtree, pass the same prefix to `wiki_list_pages(path=...)` and
  `wiki_search(path=...)`. Never search outside the selected prefix.
- For a selected page, call `wiki_get_page(path=...)` directly.
- `wiki_search` returns metadata only; fetch the body with `wiki_get_page` before
  quoting or summarizing.
- When several pages look relevant, read them with parallel `wiki_get_page` calls;
  rank candidates by title, description and path first, and narrow the search when
  more than ~5 pages compete. Cite every page you actually used (`page_url`).
- For truncated long pages, use the `outline` to pick the right `section` on the
  follow-up call instead of asking for the full body again.
- Tools are read-only and scope-enforced server-side. Never claim to modify wiki
  content, and never claim a page exists when the tool reported it missing.
- If a tool returns `wiki_out_of_scope`, the path is outside the selected sources:
  do not retry it; tell the user which selected scope covers their question instead.
