---
sidebar_position: 19
---

# Model settings

Manage task models in **Settings → Models**.

- **Codex subscription**: Enable the local subscription to use your local Codex account and models. Use “View models” to adjust model capabilities and “Manage account” to sign in or manage your account. Changing the subscription switch requires restarting the app.
- **Custom models**: Select “Add model”, choose a provider such as DeepSeek, enter an API key, and select “Fetch models”. Select models and save. The provider endpoint is configured automatically. Models missing from the list can be added manually.
- **Custom endpoint**: Choose the last option in the same provider dropdown. Enter a name, API protocol, Base URL, and any required API key, then fetch or manually add models.
- **Cloud models**: Connect to the cloud to view models provided by the server.

Models are grouped by endpoint and share its URL and key. Expand a group to edit shared connection settings or edit an individual model's context length, capabilities, protocol, and tools. Canceling does not save changes; discarding unsaved changes requires confirmation. Deleting an endpoint also removes its models, while keeping existing conversations.

Legacy local model settings migrate automatically, preserving model IDs and capabilities. Old records are removed only after persistence succeeds and the runtime loads the same revision. Failed migrations retain old data and can be retried.

Reply suggestions are under **Settings → General → AI assistance**. See [Reply suggestions](reply-suggestions.md).
