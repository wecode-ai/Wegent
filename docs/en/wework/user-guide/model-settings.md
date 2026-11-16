---
sidebar_position: 19
---

# Model settings

<!-- ui-source: src/components/settings/ModelSettingsPage.tsx -->

<a id="model-controls"></a>

## Individual model controls

Open **bottom-left account menu → Settings → Personal → Models**. The task composer model selector chooses a model; it is not the provider configuration form.

In an existing conversation, use **Task composer → model selector → choose a model → Switch model**.
The next message uses that model. Switching between an OpenAI account, custom models and cloud
models retains the conversation, draft and workspace panels instead of creating a referenced
conversation. An in-progress reply keeps its original model; model capabilities and existing
tool permissions still apply.

| Feature                    | Steps and result                                                                                  | Limitations                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Local Codex subscription   | Toggle and restart when prompted; expand model or account management                              | Local Codex and Wegent cloud accounts are separate                                                               |
| Add provider model         | Add model → provider → API key → fetch models → select and save                                   | Models in a group share provider URL and key; never enter secrets in chat                                        |
| Custom endpoint            | Select Custom endpoint in the provider list; enter name, protocol, Base URL and key               | Protocol must match the API; a passing test does not authorize external plugins                                  |
| Edit provider / add model  | Edit shared configuration or add a model inside its group                                         | Shared settings affect the group; a model test checks that model only                                            |
| Edit model capabilities    | Expand provider → Edit model; set context, maximum output and capabilities                        | Maximum output must be positive and smaller than an explicitly configured context                                |
| Vision sidecar             | Select an explicitly image-capable model in a text model's configuration                          | Images go to that vision model; descriptions go to the main model. Cloud references are configured in Wegent Web |
| Test connection            | Test at the bottom of the add/edit dialog; expand errors for details                              | No save required; does not change stored settings. A blank key during editing uses the stored key                |
| Codex Catalog              | Expand Codex models → model actions → Edit Catalog; save or restore defaults                      | Cannot add models here; an executor restart may be required                                                      |
| Disable, cancel and delete | Use the model/provider action and review the affected scope                                       | Cancel does not save; deleting a provider removes its models, not conversations                                  |
| Choose for a task          | Return to the composer, open the model selector and select a model and available reasoning effort | Options depend on capabilities; recover missing configuration in settings                                        |

Manage task models in **Settings → Models**.

- **Codex subscription**: Enable the local subscription to use your local Codex account and models. Use “View models” to adjust model capabilities and “Manage account” to sign in or manage your account. Changing the subscription switch requires restarting the app.
- **Custom models**: Select “Add model”, choose a provider such as DeepSeek, enter an API key, and select “Fetch models”. Select models and save. The provider endpoint is configured automatically. Models missing from the list can be added manually.
- **Custom endpoint**: Choose the last option in the same provider dropdown. Enter a name, API protocol, Base URL, and any required API key, then fetch or manually add models.
- **Cloud models**: Connect to the cloud to view models provided by the server.

Models are grouped by endpoint and share its URL and key. Select “Edit” to change shared connection settings. Expand a group and select “Edit model” to change a model's context length, maximum output length, capabilities, protocol, and tools. Maximum output length is measured in tokens and must be a positive integer. If a context length is set, the output limit must be smaller. Leave it blank to use the runtime default.

Codex tasks without an explicit context length use the model Catalog's context window. The maximum context and auto-compaction threshold are separate settings: with a 500,000-token context, a 95% effective context ratio, and no explicit auto-compaction threshold, the usable window is about 475k and the default auto-compaction threshold is about 450k.

When the model configures a maximum output, Codex auto-compacts at 80% of the usable input budget (context minus maximum output). Chat Completions and Anthropic Messages reserve the proxy default of 96,000 output tokens when no output limit is configured. Without a configured context length, they use the selected Wework Catalog's window. For example, a 1,048,576-token context with a 96,000-token output budget gives a usable input budget of about 952.6k and an auto-compaction point of about 762.1k. Native Responses keeps the provider default when no output limit is configured.

The context compaction threshold under **Settings → Context** (default 75%) only controls when the context indicator shows the manual compaction hint; it does not change Codex's automatic compaction threshold. Codex derives that threshold from the task model's Catalog window, its actual output budget, and the model configuration. A cloud model without a dedicated Catalog entry uses the `wework-gpt-6.1-sol` compatibility profile through the existing shared catalog flow, without requiring an official account. This profile does not cap the model's configured context window or enable official-only code mode or Responses Lite.

When adding or editing models, select “Test connection” at the bottom of the dialog to test the current connection and selected models without saving. Leaving the API key blank while editing uses the saved key. The test checks authentication and tool calling. Successful tests show “Connected”; expand failed tests for details, correct the settings, and test again. Testing does not change saved settings.

Canceling does not save changes; discarding unsaved changes requires confirmation. Deleting an endpoint also removes its models, while keeping existing conversations.

Legacy local model settings migrate automatically, preserving model IDs and capabilities. Old records are removed only after persistence succeeds and the runtime loads the same revision. Failed migrations retain old data and can be retried.

Reply suggestions are under **Settings → General → AI assistance**. See [Reply suggestions](reply-suggestions.md).
