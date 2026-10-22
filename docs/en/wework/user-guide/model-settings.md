---
sidebar_position: 19
---

# Model settings

Manage task models in **Settings → Models**.

- **Codex subscription**: Enable the local subscription to use your local Codex account and models. Use “View models” to adjust model capabilities and “Manage account” to sign in or manage your account. Changing the subscription switch requires restarting the app.
- **Custom models**: Select “Add model”, choose a provider such as DeepSeek, enter an API key, and select “Fetch models”. Select models and save. The provider endpoint is configured automatically. Models missing from the list can be added manually.
- **Custom endpoint**: Choose the last option in the same provider dropdown. Enter a name, API protocol, Base URL, and any required API key, then fetch or manually add models.
- **Cloud models**: Connect to the cloud to view models provided by the server.

Models are grouped by endpoint and share its URL and key. Select “Edit” to change shared connection settings. Expand a group and select “Edit model” to change a model's context length, maximum output length, capabilities, protocol, and tools. Maximum output length is measured in tokens and must be a positive integer. If a context length is set, the output limit must be smaller. Leave it blank to use the runtime default.

Codex tasks without an explicit context length use the model Catalog's context window. The maximum context and auto-compaction threshold are separate settings: with a 500,000-token context, a 95% effective context ratio, and no explicit auto-compaction threshold, the usable window is about 475k and the default auto-compaction threshold is about 450k.

When adding or editing models, select “Test connection” at the bottom of the dialog to test the current connection and selected models without saving. Leaving the API key blank while editing uses the saved key. The test checks authentication and tool calling. Successful tests show “Connected”; expand failed tests for details, correct the settings, and test again. Testing does not change saved settings.

Canceling does not save changes; discarding unsaved changes requires confirmation. Deleting an endpoint also removes its models, while keeping existing conversations.

Legacy local model settings migrate automatically, preserving model IDs and capabilities. Old records are removed only after persistence succeeds and the runtime loads the same revision. Failed migrations retain old data and can be retried.

Reply suggestions are under **Settings → General → AI assistance**. See [Reply suggestions](reply-suggestions.md).
