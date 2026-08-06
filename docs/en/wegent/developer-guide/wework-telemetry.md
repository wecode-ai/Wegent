---
sidebar_position: 26
---

# Wework Telemetry and Product Analytics

Wework separates product analytics, desktop error diagnostics, and service observability:

- PostHog receives allowlisted product events.
- Sentry receives React WebView errors and Tauri/Rust panics.
- Backend services and Executors continue to export traces and metrics through the OpenTelemetry Collector.

## Privacy Boundary

On first launch, Wework explicitly asks whether the user allows anonymous usage and error-diagnostic data to be shared. Frontend and native telemetry remain disabled until the user makes a choice. The choice can later be changed under Settings > General > Privacy; disabling telemetry stops both client SDKs, clears unsent events, and resets the analytics identity.

Product analytics events must never contain chats, prompts, model responses, code, file names, file paths, repository names, terminal content, credentials, or authentication data. Product code may only call `src/telemetry/client.ts`; it must not call the PostHog or Sentry SDK directly. New events must be added to both `AnalyticsEventMap` and the runtime property allowlist.

Before transmission, PostHog applies the event-specific allowlist again to remove SDK-added URLs, referrers, person-profile data, and other unnecessary properties; unregistered SDK-generated events are dropped. WebView and native Tauri Sentry events remove requests, users, breadcrumbs, extra context, original exception text, source excerpts, local file paths, and local variables. WebView stack traces retain file locations, functions, line and column numbers, and source-map Debug IDs only for trusted Wework application resources; URL queries, fragments, and credentials are removed, while user files, external pages, and other untrusted paths are represented as `<redacted>`. Desktop E2E uses a local receiver to verify that no request is made before the user chooses, transmission starts only after explicit consent, and the real request body does not contain the test workspace path, authentication tokens, model key, or user email.

Wework does not send account user IDs to PostHog or Sentry. Sentry uses an `installation_id` tag stored in localStorage and a per-session `telemetry_session_id`; PostHog uses the SDK-generated `distinct_id` and `$session_id`. These identifiers are anonymous, independent of the authenticated account, and rotated when telemetry is disabled so data collected after re-enabling cannot be linked to data from before revocation.

## Event Catalog

Events cover feature adoption, funnel outcomes, and reliability outcomes that support product decisions. Ordinary button clicks are not tracked.

| Domain                         | Events                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| App, navigation, and auth      | `app_started`, `feature_opened`, `authentication_completed`                                |
| Projects and conversations     | `project_opened`, `project_created`, `project_removed`, `conversation_created`             |
| Task execution                 | `task_started`, `first_response_completed`, `task_completed`, `task_interrupted`, `task_retried` |
| Project spaces and boards      | `board_view_opened`, `board_item_created`, `board_item_moved`, `feature_action_completed`  |
| Plugins                        | `plugin_center_opened`, `plugin_installed`, `plugin_enabled_changed`, `plugin_uninstalled` |
| Automations                    | `automation_action_completed`                                                              |
| Built-in browser               | `browser_navigation_completed`, `browser_download_completed`                               |
| Cloud, deliveries, and updates | `cloud_connection_changed`, `delivery_completed`, `app_update_install_started`             |
| Feedback and Appshots          | `feedback_submitted`, `appshot_received`                                                   |
| Workspace panels               | `workspace_panel_added`, `workspace_panel_removed`                                          |
| Settings                       | `setting_changed`                                                                          |
| AI analytics                   | `$ai_trace`, `$ai_generation`, `ai_output_action_completed`, `generation_regenerated`      |
| Privacy preference             | `telemetry_preference_changed`, emitted only after telemetry is re-enabled                 |

Cross-domain resource operations use `feature_action_completed` with bounded `domain` and `action` enums for project spaces, board items, task bindings, attachments and workspace files, AI tables, plugins, skills, MCP servers, hooks, Sites, models, Git, cloud devices, quick phrases, and archived conversations. Handled failures for critical operations use `operation_failed` with a bounded operation type and never include the error message. Resource IDs, project names, plugin names, URLs, file paths, and user input are never event properties; the only exception is the AI correlation identifiers described below, which are opaque per-run tokens rather than the raw IDs. Feature code must emit success events only after the API or native operation succeeds; rollback paths must not report success.

## AI Analytics Events

Wework emits PostHog AI analytics events for agent task traces, LLM generations, and user feedback. These events follow the same privacy boundary: they contain only metadata and bounded categorical values, never prompts, outputs, user text, file paths, or credentials.

| Event             | Purpose                                                                                       | Key properties                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$ai_trace`       | One task run, emitted at run start and end.                                                   | `$ai_trace_id` (opaque per-run id minted when the run starts), `$ai_trace_phase` (`start` or `end`), `execution_target`, `duration_ms` (end only), `result` (`success`, `failure`, or `cancelled`; end only), `failure_reason` (bounded failure category; end only when result is `failure`). |
| `$ai_generation`  | Each LLM-backed assistant response, measured from assistant start to settled.                 | `$ai_generation_id`, `$ai_trace_id` (the run's opaque trace id; the PostHog-required property that groups generations into a trace), `$ai_parent_id` (same per-run id, kept for tree nesting), `$ai_model` (runtime catalog enum), `$ai_provider` (bounded known-provider enum), `$ai_input_tokens`, `$ai_output_tokens`, `$ai_total_tokens`, `$ai_latency` (seconds), `$ai_cost` (best-effort USD estimate when the model is recognized), `result`. |

A task is a stable resource that can be run repeatedly, so trace correlation must be scoped to a single run rather than to the task id. When a run starts, the client mints an opaque `t-<base36>` trace id and every `$ai_trace` and `$ai_generation` emitted while that run is active shares it; when the run settles the id is discarded and the next run mints a fresh one. Reusing one trace id for every run of a task would collapse separate runs into a single PostHog trace and corrupt per-run duration, token, and cost metrics. Each `$ai_generation` captures the run's trace id at assistant start, so generations stay correlated even if the run settles concurrently. If the window closes while a run is active, an `$ai_trace` `end` with `result=cancelled` is flushed so no trace is left open. The runtime allowlist enforces that `$ai_trace_id` and `$ai_parent_id` match the hashed `t-<base36>` format and `$ai_generation_id` is a UUID, so an un-hashed raw task ID can never be transmitted as a correlation property.

Generation token counts (`$ai_input_tokens`, `$ai_output_tokens`, `$ai_total_tokens`) are taken from the run's own context usage carried by the settled event, so the counts are attributed to the generation they describe and never to a concurrent run of the same task; when the runtime did not report usage for a turn, the token properties are omitted.

The `result` on `$ai_trace` `end`, `task_completed`, and `first_response_completed` reflects the last assistant-turn outcome reported for the run when one exists, so a run whose only generation failed or was cancelled is reported as `failure` or `cancelled` instead of defaulting to `success`; when the runtime reported no generation outcome, these events fall back to the task record's status.

`$ai_model` is a bounded enum derived dynamically from the current Wework model catalog, which is fed exclusively by the three model channels (Codex models, self-configured provider profiles, and cloud models); any model id the app exposes is a valid enum value and anything else collapses to `other`, and the user-facing model name is never sent. `$ai_provider` is a bounded enum of known providers derived with the following priority: first, the model id prefix identifies the vendor (e.g. `moonshot-kimi-*` and `kimi-*` map to `moonshot`, `deepseek-*` to `deepseek`, `gpt-*` to `openai`); if that misses, official Codex catalog models are reported as `openai` because they are all routed through Wework's openai-responses proxy; only as a last resort does it fall back to the provider string on the model configuration. Note that the provider string is free text: both the cloud and self-configured model channels can write the API transport (e.g. Kimi served over an anthropic-messages endpoint reports `anthropic`) instead of the actual vendor, so when the model id is unrecognized `$ai_provider` may be dirty data and provider-based breakdowns or cost attribution should trust the model id instead. `$ai_cost` is estimated on the client from a small, known-model pricing table because the backend does not currently expose per-call cost; it is best-effort and PostHog computes its own cost from the model, provider, and token counts, so `$ai_cost` should be treated as a client-side estimate rather than the source of truth; it should be replaced with backend-supplied cost when available.

Older builds emitted AI events in a different shape: `runtime-<id>` trace ids with no `$ai_trace_id` on generations, raw provider strings such as `claude`, and a `$ai_trace_summary` event. The current allowlist drops events and properties outside the schema above, so new builds only produce the format documented here, but historical rows from the legacy emitter may still appear in the project.

## Experience Optimization Events

Beyond the lifecycle and AI analytics events above, the client reports bounded metadata about the quality loop and friction points so product decisions can be informed without exposing content:

- `ai_output_action_completed` (`action`: `copy`, `open_file`, `run`, `apply`, `expand`, `accept`, or `reject`; `source`: `chat`, `workbench`, or `board`) — emitted when the user acts on an AI output, such as copying a code block or opening a file the agent touched. It records only the action type, never the copied text or file path.
- `generation_regenerated` — emitted when a task runs again after a previous run, signaling the user re-asked/modified their request. It is counted separately from `task_interrupted`: re-asking queues a new turn and never marks the run as stopped.
- `task_interrupted` — emitted only when the user explicitly stops a running response (the pause button or "interrupt and send"); `after_first_response` distinguishes stopping before versus after the first response. A normal re-ask does not fire this event.
- `task_retried` — emitted when the same task is re-run within 60 seconds of a previous completion (`previous_result`), signaling impatience or a failing flow.
- `setting_changed` (`setting`: `appearance_mode`, `accent_color`, or other future keys; `value`) — emitted when a user changes a key setting, currently wired to the appearance theme mode and accent color.
- `workspace_panel_removed` — emitted when a workspace panel is closed, complementing `workspace_panel_added`.

## Configuration

Frontend build variables:

| Variable                                | Purpose                                                     |
| --------------------------------------- | ----------------------------------------------------------- |
| `VITE_WEWORK_POSTHOG_KEY`               | PostHog project key; product events are disabled when empty |
| `VITE_WEWORK_POSTHOG_HOST`              | PostHog ingestion endpoint; defaults to `https://us.i.posthog.com`; use `https://eu.i.posthog.com` for EU-hosted projects |
| `VITE_WEWORK_SENTRY_DSN`                | WebView Sentry DSN                                          |
| `VITE_WEWORK_SENTRY_TRACES_SAMPLE_RATE` | WebView performance sample rate, default `0.05`             |
| `VITE_WEWORK_TELEMETRY_ENVIRONMENT`     | `development`, `staging`, or `production`                   |
| `VITE_WEWORK_RELEASE_CHANNEL`           | Release channel                                             |

The WebView layer reads `VITE_WEWORK_SENTRY_DSN` at build time, while the native Tauri layer reads `WEWORK_SENTRY_DSN` at runtime (or embeds it at build time). Both should point to the same Sentry project; keep the two variables in sync in deployment and local development configuration. The native Tauri layer also reads `WEWORK_TELEMETRY_ENVIRONMENT`.

## Defense-in-depth deployment settings

Client-side scrubbing is the first line of defense, but project-level server settings must also minimize retained data.

For the Sentry project used by WebView and native Tauri:

- Enable `scrubIPAddresses` so Sentry does not store client IP addresses.
- Enable `dataScrubberDefaults` and `enhancedPrivacy` to apply built-in PII scrubbing to events, breadcrumbs, and trace data.
- Configure `relayPiiConfig` to redact local file paths, email addresses, bearer tokens, and any values that resemble API keys before they are persisted. Example:

```json
{
  "rules": {
    "remove_ips": { "type": "ip", "redaction": { "method": "remove" } },
    "remove_emails": {
      "type": "pattern",
      "pattern": "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
      "redaction": { "method": "remove" }
    },
    "remove_paths": {
      "type": "pattern",
      "pattern": "([A-Za-z]:)?(/|\\\\)(Users|home|tmp|var|private)(/|\\\\)[^\\s\\\"]*",
      "redaction": { "method": "replace", "text": "<redacted>" }
    },
    "remove_tokens": {
      "type": "pattern",
      "pattern": "(token|key|bearer)\\s*[:=]\\s*[\"']?[^\\s\"']+[\"']?",
      "redaction": { "method": "replace", "text": "<redacted>" }
    }
  },
  "applications": {
    "freeform": ["remove_ips", "remove_emails", "remove_paths", "remove_tokens"],
    "username": ["remove_ips", "remove_emails"],
    "$string": ["remove_emails", "remove_paths", "remove_tokens"]
  }
}
```

For the PostHog project:

- Set `VITE_WEWORK_POSTHOG_HOST` to the correct ingestion endpoint. The default is `https://us.i.posthog.com`; EU-hosted projects should use `https://eu.i.posthog.com`. Self-hosted instances should use their own ingestion URL.
- Disable Session Replay and autocapture at the project level as a backup to the client-side flags; Wework never sends replay data or autocaptured events.
- Keep person profiles disabled; Wework sets `person_profiles: 'never'` and `$process_person_profile: false` so PostHog does not build per-user profiles from anonymous events.
- Use the project-level IP anonymization or `$_` capture settings as a fallback to `$geoip_disable: true`, which Wework already sends on every event.

## Metric Cardinality

OpenTelemetry metrics may only use bounded dimensions such as platform, version, result, and error category. `user_id`, `task_id`, `team_id`, paths, and arbitrary names belong in controlled events or traces and must not be metric attributes.

Session Replay, autocapture, automatic page capture, and external dependency loading remain disabled.
