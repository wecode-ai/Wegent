---
sidebar_position: 1
---

# Claude Code Model Switching

## Goal

Allow users to switch the selected model while continuing an existing ClaudeCode conversation.

## Context

The message send path already carries model overrides:

- The frontend maps the selected model to `force_override_bot_model`.
- The backend persists that value in task metadata and resolves the model for the next execution request.
- The Claude executor already receives the resolved model through Claude Code environment configuration.

The current blocker is the frontend UI. Once a task has messages, both desktop and mobile input controls disable model selection for every non-Chat Shell team. ClaudeCode is in that non-Chat Shell group, so users cannot change the model during the conversation.

## Design

Replace the broad `hasMessages && !isChatShell(selectedTeam)` disable rule with a narrower rule that only disables model switching for shell types that cannot safely support it.

ClaudeCode should remain enabled after messages exist, except while a request is loading or streaming. Chat Shell keeps the existing behavior. Other executor types remain conservative unless explicitly allowed by a shared helper.

## Components

- Add or reuse a frontend helper that determines whether a team can switch models after task creation.
- Apply the helper in desktop `ChatInputControls`.
- Apply the same helper in mobile `MobileChatInputControls`.
- Keep the existing send payload unchanged.

## Data Flow

1. User changes the model in the selector during an existing ClaudeCode task.
2. The selected model state updates in the same way it does before the first message.
3. The next send includes `force_override_bot_model`.
4. Backend task metadata and execution request resolution continue through the existing path.
5. Claude executor receives the selected model through existing model configuration.

## Error Handling

Do not add new frontend error behavior. If the selected model is invalid, missing, or not allowed, the existing backend model resolver should reject the request and surface the existing chat error.

## Testing

Add focused frontend unit coverage for the helper:

- Chat Shell can switch after messages.
- ClaudeCode can switch after messages.
- Unknown or unsupported shells stay disabled after messages.

Run the frontend lint or targeted test command available in the repository.
