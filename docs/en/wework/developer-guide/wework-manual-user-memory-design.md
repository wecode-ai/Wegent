---
sidebar_position: 99
---

# Wework global user preference prompt design

Status: proposed first version. Date: 2026-11-20.

[中文](../../../zh/wework/developer-guide/wework-manual-user-memory-design.md)

## Background

Wework does not yet provide one user preference prompt that applies across local, cloud, and remote executors. Users want to persist preferences such as “keep replies concise,” “do not scatter emoji through documents,” or “reasoning and agent interaction may use coined terms or English, but comments, commit messages, and PRs must use language a human engineer understands.”

The existing Wework custom instructions in `ContextSettingsPage` are Codex-config oriented and are not the right cross-executor carrier for user preferences. The first version adds the minimum capability: one global user preference prompt injected by Wework before each request.

## Goals

- Provide one global user preference prompt.
- Allow manual editing in the GUI.
- Send the same prompt to local, cloud, and remote executors.
- Inject the latest content on create, continuation, interrupt-and-send, and active-turn guidance.
- Keep the implementation small, with no database, Backend API, or executor storage.

## Non-goals

- No environment memory, layered memory, executor-local memory, or cross-device merging.
- No automatic extraction, consolidation, deduplication, or scheduled review.
- No account-level cloud synchronization.
- No semantic retrieval.
- No change to Stand-in memory.
- The preference prompt is not permission, authentication, or approval.

## Data model

Add one field to `AppPreferences`:

```ts
interface AppPreferences {
  userPreferencePrompt: string;
}
```

Rules:

- Default to an empty string.
- Trim before saving.
- Maximum 4000 characters; the GUI rejects longer input.
- No list of records, no versioning, and no device or environment binding.
- Read and write atomically with other desktop preferences; missing fields in older data read as empty.

## GUI

Add a “User preference prompt” section to Settings → Context:

- One multiline text box.
- The save button is enabled only when content changes.
- Preserve input and show an error if saving fails.
- Empty-state copy suggests stable preferences for communication, documentation, comments, and commit messages.
- No separate settings page and no new navigation entry.

## Injection

Wework reads the latest preference while constructing:

- `RuntimeTaskCreateRequest`
- `RuntimeSendRequest`
- Active-turn guidance requests

If the prompt is non-empty, write:

```ts
additionalContext["wework.user-preferences"] = {
  kind: "application",
  value: userPreferencePrompt,
};
```

Constraints:

- Do not modify `system_prompt`.
- Do not filter by device type.
- Re-read before every turn; do not rewrite an already running turn.
- Remote and cloud executors receive the same content.
- An empty prompt omits the field.

## Prompt maintenance

The first version provides two input commands:

- `/remember <preference>`: append one line to the existing prompt.
- `/memory`: open Settings → Context → User preference prompt.

Command rules:

- Append plain text only; do not parse structure or rewrite existing content.
- The change takes effect on the next turn and starts no model turn.
- Reject an append that would exceed 4000 characters and preserve the input.
- Deletion, editing, and cleanup remain in the GUI.

## Security boundaries

- The preference prompt is user data, not a permission grant.
- Keep injection as `kind: application`; do not disguise it as user input.
- Do not store credentials, tokens, API keys, or session-file contents.
- Explicit user requests, project instructions, and Wework custom instructions take precedence.
- Deleting the prompt does not modify historical conversation text.

## Testing

Use focused unit and component tests only:

- Preference normalization: missing, blank, over-limit, and invalid values.
- GUI: edit, save, failed-save retry, empty state, and length limit.
- Command parsing: valid append, empty content, and over-limit rejection.
- Request construction: create, continuation, and guidance requests inject `wework.user-preferences`.
- Remote and local requests contain the same prompt.
- An empty prompt omits the field.
- Changes affect the next turn; history remains unchanged.

If later implementation requires real desktop interaction acceptance, run `ai:verify` explicitly under the repository policy.
