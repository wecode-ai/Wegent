---
sidebar_position: 46
---

# Progressive capability loading in Wework

Wework defaults to native Codex Code Mode. Built-in and MCP tools retain native registration, execution, permissions and result handling. Discover relevant entries through `ALL_TOOLS`; matching descriptions provide their calling signatures. The model-facing `exec` declaration contains execution and discovery guidance rather than the complete nested catalog. Explicit custom-model `direct` settings remain supported.

Native models retain the base instructions and `model_messages` supplied by the Codex catalog. Wework neither replaces nor copies general coding guidance and no longer provides a coding skill. Third-party and custom models inherit instructions from the default model bundled with the current Codex release, selected by native picker visibility and priority, rather than a separately maintained prompt. Only exact retired defaults are migrated to inheritance; user-authored instructions and catalog overrides remain explicit. Wework-specific routing, permission and safety requirements supplement these through developer instructions.

Ordinary repository work, file inspection and process diagnostics do not require reading a general workflow file. Specialized browser, desktop, GitHub, connector authorization, conversation/schedule, visualization and artifact-delivery workflows remain in their respective skills. Initial context contains skill metadata; read relevant skill bodies and references only when needed, and reload missing instructions after compaction when needed.

Goal availability does not create a Goal. The host sets a Goal through the native interface when the user selects an objective. Ordinary conversations do not eagerly expand Goal tool definitions; native discovery exposes them when needed.

Native Responses Lite retains `input.additional_tools`. Compatible Responses, Chat Completions and Anthropic Messages use their protocol's declarations and calls. Adapters preserve namespaces and raw custom-tool input. Incremental declarations apply additions, replacements and native removal notices in order; historical `additional_tools` must not resurrect tools excluded from a current top-level catalog.

Custom-tool wire conversion is configured per model with `custom_tool_conversion`, which accepts `none`, `all` or `except_apply_patch`. The adapter never infers it from the request URL or proxy routing. When omitted, the model default follows the tool mode: function tool conversion resolves to `all`, and native custom tools resolve to `none`. The DeepSeek provider preset selects `except_apply_patch`, wrapping custom tools such as `exec` as functions while retaining native `apply_patch`; the adapter restores custom calls from function responses and translates tool history and results. Other Responses endpoints that reject custom tools can select the same mode in the model's advanced settings without disabling Code Mode discovery.

Native developer instructions own host policy. Bounded per-turn revision references allow policy updates and recovery through immutable policy files without applying stale revisions or replacing independent context and permissions.

Independent Backend Tasks retain their existing inline artifact-declaration contract, using the same Backend identity check as task environment construction. Wework conversations load artifact guidance through the skill. Text-only auxiliary requests omit action policy and remove both top-level and Lite-history tool declarations.

## Verification gates

The shared desktop `model-routing` matrix covers 10 model configurations across local and cloud execution: 20 cases. Core runs three local custom-model cases; Cloud runs seven other local-execution cases and ten cloud-execution cases. Protocol switching changes only the upstream format and preserves plugin and MCP configuration.

Each case captures the complete model-boundary request. The first user input must be `hi`; unloaded skill bodies and undiscovered MCP definitions must be absent, and built-in signatures must not expand upfront. Pinned `tiktoken JS/WASM 1.0.22` with `o200k_base` counts the entire serialized JSON against a strict budget below 12,000 tokens, allowing for restored native base instructions. This is a common regression estimate, not provider billing usage.

The `codex-native-catalog` checkpoint captures actual HTTP requests through a separate model Mock process. It retains payloads and an audit report asserting exactly one copy of native base instructions, no duplicate host sections and no unused specialized skill bodies. Authentication headers are never written to evidence.

Only model services are scripted. Native discovery, MCP execution, Goal reads, skill reads, rediscovery and the file-edit round trip execute through real components. Assertions verify required capabilities remain available and unrelated skill bodies stay unloaded. Retain requests and individual reports, continue after case failures, and fail the final aggregate. A scripted terminal response used to release a failed turn never counts as successful tool execution.
