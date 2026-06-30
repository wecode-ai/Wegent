---
description: "Use when users ask Wegent usage, setup, configuration, troubleshooting, Agent/Bot/Skill, knowledge base, device, deployment, or developer-documentation questions. Load this skill and search the built-in Wegent Help knowledge base before answering."
displayName: "Wegent 帮助"
version: "1.0.0"
author: "Wegent Team"
tags: ["wegent", "help", "docs", "knowledge-base", "troubleshooting"]
bindShells:
  - Chat
  - ClaudeCode
preload: false
---

# Wegent Help

Use this skill when the user asks about Wegent product usage, setup, configuration, troubleshooting, concepts, Agent/Team/Bot/Skill behavior, knowledge bases, devices, deployment, or developer documentation.

## Required Workflow

1. Load the `wegent-help-knowledge` skill when you need documentation lookup.
2. Use `wegent_help_query` with the user's full question.
3. Answer from retrieved Wegent documentation first.
4. Use the same language as the user's question whenever possible.
5. Include source document names or source references from the query response.

## Failure Handling

- If the `Wegent Help` knowledge base is missing, say that the built-in help knowledge base is not initialized.
- If documents are not indexed or no results are returned, say that the help documents are unavailable or not indexed yet, then give a concise next-step diagnostic.
- Do not invent documentation details from general model memory.
- Do not use web search unless the user explicitly asks for external or current information.
