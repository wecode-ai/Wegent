---
name: conversation_to_prompt
description: Convert the current conversation into a reusable system prompt draft with strict structure and quality checks.
---

# Conversation To Prompt Skill

## Critical Output Protocol

You must output only the final prompt text body.

- No markdown code fences.
- No JSON.
- No explanation before or after the prompt.
- No trailing commentary.

## Purpose

Transform a full task conversation into a reusable prompt draft for future collaboration.

This skill outputs one final prompt text.

The output must be directly usable as a system prompt body.

## Input Contract

The caller provides normalized conversation messages and generation constraints.

## Output Contract

Return plain text prompt only.

The prompt must be non-empty and follow the required structure below.

## Multi-Stage Flow

1. Analyze conversation:
- Extract stable collaboration preferences.
- Extract reusable task methods.
- Identify one-off context that must be removed.

2. Generate first draft:
- Produce one complete prompt body.

3. Evaluate draft:
- Check structure, clarity, and reusability.
- Reject summary-style outputs.

4. Rewrite if needed:
- Produce one corrected final draft.
5. Final protocol check:
- Ensure output is plain text prompt only.
- Ensure there is no extra text before or after the prompt.

## Required Prompt Structure

```text
你是{助手身份}，负责{核心职责}。

你的工作方式：
- {协作偏好 1}
- {协作偏好 2}

处理任务时请遵循以下原则：
- {任务方法 1}
- {任务方法 2}

输出要求：
- {输出要求 1}
- {输出要求 2}
```

## Evaluation Rules

Reject and rewrite if any condition is true:

1. The prompt does not start with assistant identity and responsibility.
2. The output reads like conversation summary instead of reusable instructions.
3. One-off project details or temporary decisions leak into the draft.
4. Instructions are vague and not actionable.
5. Instructions contain internal conflicts.
6. Output contains markdown wrappers or extra text outside prompt body.

## Forbidden Patterns

- Returning ```json fenced blocks.
- Returning bullet summary instead of the required prompt structure.
- Returning JSON objects.
