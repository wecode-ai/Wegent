---
name: "interactive-form-question"
description: "Ask the user questions or present choices via an interactive form. Use when you need to gather preferences, clarify ambiguous instructions, get decisions on implementation choices, or present a list of options for the user to select from. Never write options or questions as plain text — always use this tool."
displayName: "交互式表单提问"
version: "2.0.0"
author: "Wegent Team"
tags: ["interaction", "user-input", "form", "clarification"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
mcpServers:
  wegent-interactive-form-question:
    type: streamable-http
    url: "${{backend_url}}/mcp/interactive-form-question/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Ask User

You now have access to the `interactive_form_question` tool. Use it to ask the user questions during execution.

## When to Use

1. **Gather user preferences or requirements** — before starting or when more detail is needed
2. **Clarify ambiguous instructions** — when the request could be interpreted multiple ways
3. **Get decisions on implementation choices as you work** — when a fork in the road requires user input
4. **Offer choices on direction** — let the user steer when multiple valid paths exist
5. **Present any list of options to the user** — whenever you would naturally write a numbered/bulleted list of choices for the user to pick from, use `interactive_form_question` instead

**Never write options, choices, or questions as plain text or markdown lists — always call the tool.**

## Usage Notes

- Users can always select **"Other"** to provide custom text input, even on choice questions — you don't need to add it manually
- Use `multi_select: true` to allow multiple answers to be selected
- If you recommend a specific option, set `"recommended": true` on that option — the frontend will display the recommended badge automatically. **NEVER add "(Recommended)", "(推荐)" or any similar text to the `label` field** — the badge is rendered by the frontend, not by text in the label
- Always pass questions via `questions=[...]`. A single-question form is just a one-item `questions` array.
- After receiving answers, call `interactive_form_question` again if follow-up questions arise — never ask in plain text

## Behavior

`interactive_form_question` displays an interactive form and returns immediately (`__silent_exit__`). The current task ends silently and resumes when the user submits their answer as a new message.

## Tool Parameters

- `questions` (list, required): The full list of questions to render
- Each item in `questions` has:
  - `id`: Unique identifier
  - `question`: Question text shown to the user
  - `input_type`: `"choice"` or `"text"`
  - `options` (optional): `[{label, value, recommended?}]` for choice questions
  - `multi_select` (optional): Allow multiple selections; default `false`
  - `required` (optional): Whether the question must be answered; default `true`
  - `default` (optional): Pre-selected values
  - `placeholder` (optional): Placeholder for text input

## Examples

### Clarify ambiguous instructions

```
interactive_form_question(
  questions=[
    {
      "id": "environment",
      "question": "Which environment should I deploy to?",
      "input_type": "choice",
      "options": [
        {"label": "Development", "value": "dev", "recommended": true},
        {"label": "Staging", "value": "staging"},
        {"label": "Production", "value": "prod"}
      ]
    }
  ]
)
```

### Get a decision as you work

```
interactive_form_question(
  questions=[
    {
      "id": "cache_strategy",
      "question": "I found two approaches for the caching layer. Which do you prefer?",
      "input_type": "choice",
      "options": [
        {"label": "Option A — simple in-memory cache", "value": "simple", "recommended": true},
        {"label": "Option B — Redis with TTL control", "value": "redis"}
      ]
    }
  ]
)
```

### Gather requirements upfront (multi-question)

```
interactive_form_question(
  questions=[
    {
      "id": "language",
      "question": "Which language should I use?",
      "input_type": "choice",
      "options": [
        {"label": "Python", "value": "python", "recommended": true},
        {"label": "TypeScript", "value": "typescript"},
        {"label": "Go", "value": "go"}
      ]
    },
    {
      "id": "features",
      "question": "Which features to include?",
      "input_type": "choice",
      "multi_select": true,
      "options": [
        {"label": "Authentication", "value": "auth", "recommended": true},
        {"label": "Rate Limiting", "value": "rate_limit"},
        {"label": "Caching", "value": "caching"}
      ]
    },
    {
      "id": "notes",
      "question": "Anything else I should know?",
      "input_type": "text",
      "required": false,
      "placeholder": "Optional notes..."
    }
  ]
)
```

### Confirm before a destructive action

```
interactive_form_question(
  questions=[
    {
      "id": "overwrite_confirmation",
      "question": "This will overwrite the existing file. Proceed?",
      "input_type": "choice",
      "options": [
        {"label": "Yes, overwrite", "value": "yes"},
        {"label": "No, keep existing", "value": "no", "recommended": true}
      ]
    }
  ]
)
```

## Response Format

**Single-question:** `{"answer": ["value"]}` (choice) or `{"answer": "text"}` (text)

**Multi-question:** `{"answers": {"language": ["python"], "features": ["auth", "caching"], "notes": ""}}`
