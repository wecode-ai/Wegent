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

Events must never contain chats, prompts, model responses, code, file names, file paths, repository names, terminal content, credentials, or authentication data. Product code may only call `src/telemetry/client.ts`; it must not call the PostHog or Sentry SDK directly. New events must be added to both `AnalyticsEventMap` and the runtime property allowlist.

Before transmission, PostHog applies the event-specific allowlist again to remove SDK-added URLs, referrers, person-profile data, and other unnecessary properties; unregistered SDK-generated events are dropped. WebView and native Tauri Sentry events remove requests, users, breadcrumbs, extra context, original exception text, source excerpts, local file paths, and local variables. Desktop E2E uses a local receiver to verify that no request is made before the user chooses, transmission starts only after explicit consent, and the real request body does not contain the test workspace path, authentication tokens, model key, or user email.

Wework does not send account user IDs to PostHog or Sentry. Both SDKs use separate random installation and session identifiers; disabling telemetry rotates those identifiers so data collected after re-enabling cannot be linked to data from before revocation.

## Event Catalog

Events cover feature adoption, funnel outcomes, and reliability outcomes that support product decisions. Ordinary button clicks are not tracked.

| Domain                         | Events                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| App, navigation, and auth      | `app_started`, `feature_opened`, `authentication_completed`                                |
| Projects and conversations     | `project_opened`, `project_created`, `project_removed`, `conversation_created`             |
| Task execution                 | `task_started`, `first_response_completed`, `task_completed`                               |
| Project spaces and boards      | `board_view_opened`, `board_item_created`, `board_item_moved`, `feature_action_completed`  |
| Plugins                        | `plugin_center_opened`, `plugin_installed`, `plugin_enabled_changed`, `plugin_uninstalled` |
| Automations                    | `automation_action_completed`                                                              |
| Built-in browser               | `browser_navigation_completed`, `browser_download_completed`                               |
| Cloud, deliveries, and updates | `cloud_connection_changed`, `delivery_completed`, `app_update_install_started`             |
| Feedback and Appshots          | `feedback_submitted`, `appshot_received`                                                   |
| Workspace panels               | `workspace_panel_added`                                                                    |
| Privacy preference             | `telemetry_preference_changed`, emitted only after telemetry is re-enabled                 |

Cross-domain resource operations use `feature_action_completed` with bounded `domain` and `action` enums for project spaces, board items, task bindings, attachments and workspace files, AI tables, plugins, skills, MCP servers, hooks, Sites, models, Git, cloud devices, quick phrases, and archived conversations. Handled failures for critical operations use `operation_failed` with a bounded operation type and never include the error message. Resource IDs, project names, plugin names, URLs, file paths, and user input are never event properties. Feature code must emit success events only after the API or native operation succeeds; rollback paths must not report success.

## Configuration

Frontend build variables:

| Variable                                | Purpose                                                     |
| --------------------------------------- | ----------------------------------------------------------- |
| `VITE_WEWORK_POSTHOG_KEY`               | PostHog project key; product events are disabled when empty |
| `VITE_WEWORK_POSTHOG_HOST`              | PostHog ingestion endpoint                                  |
| `VITE_WEWORK_SENTRY_DSN`                | WebView Sentry DSN                                          |
| `VITE_WEWORK_SENTRY_TRACES_SAMPLE_RATE` | WebView performance sample rate, default `0.05`             |
| `VITE_WEWORK_TELEMETRY_ENVIRONMENT`     | `development`, `staging`, or `production`                   |
| `VITE_WEWORK_RELEASE_CHANNEL`           | Release channel                                             |

The native Tauri layer reads `WEWORK_SENTRY_DSN` and `WEWORK_TELEMETRY_ENVIRONMENT`. The DSN may be embedded at build time or supplied at runtime.

## Metric Cardinality

OpenTelemetry metrics may only use bounded dimensions such as platform, version, result, and error category. `user_id`, `task_id`, `team_id`, paths, and arbitrary names belong in controlled events or traces and must not be metric attributes.

Session Replay, autocapture, automatic page capture, and external dependency loading remain disabled.
