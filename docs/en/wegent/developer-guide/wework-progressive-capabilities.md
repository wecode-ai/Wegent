---
sidebar_position: 46
---

# Progressive capability loading in Wework

Wework defaults to native Codex Code Mode. Built-in and MCP tools retain native registration, execution, permissions and result handling. Discover relevant entries through `ALL_TOOLS`; matching descriptions provide their calling signatures. The model-facing `exec` declaration contains execution and discovery guidance rather than the complete nested catalog. Explicit custom-model `direct` settings remain supported.

The default base instructions retain collaboration, permission, safety and discovery essentials. Detailed coding guidance lives in the default-enabled `wework-runtime:coding` skill, alongside other host workflow skills. Initial context contains skill metadata; read relevant bodies when needed and reload them after compaction if missing. User catalog overrides apply after defaults.

Goal availability does not create a Goal. The host sets a Goal through the native interface when the user selects an objective. Ordinary conversations do not eagerly expand Goal tool definitions; native discovery exposes them when needed.

Native Responses Lite retains `input.additional_tools`. Compatible Responses, Chat Completions and Anthropic Messages use their protocol's declarations and calls. Adapters preserve namespaces and raw custom-tool input. Incremental declarations apply additions, replacements and native removal notices in order; historical `additional_tools` must not resurrect tools excluded from a current top-level catalog.

Native developer instructions own host policy. Bounded per-turn revision references allow policy updates and recovery through immutable policy files without applying stale revisions or replacing independent context and permissions.

Independent Backend Tasks retain their existing inline artifact-declaration contract, using the same Backend identity check as task environment construction. Wework conversations load artifact guidance through the skill. Text-only auxiliary requests omit action policy and remove both top-level and Lite-history tool declarations.

## Verification gates

The shared desktop `model-routing` matrix covers 10 model configurations across local and cloud execution: 20 cases. Core runs three local custom-model cases; Cloud runs seven other local-execution cases and ten cloud-execution cases. Protocol switching changes only the upstream format and preserves plugin and MCP configuration.

Each case captures the complete model-boundary request. The first user input must be `hi`; unloaded skill bodies and undiscovered MCP definitions must be absent, and built-in signatures must not expand upfront. Pinned `tiktoken JS/WASM 1.0.22` with `o200k_base` counts the entire serialized JSON against a strict budget below 7,000 tokens. This is a common regression estimate, not provider billing usage.

Only model services are scripted. Native discovery, MCP execution, Goal reads, skill reads, rediscovery and the file-edit round trip execute through real components. Assertions verify required capabilities remain available and unrelated skill bodies stay unloaded. Retain requests and individual reports, continue after case failures, and fail the final aggregate. A scripted terminal response used to release a failed turn never counts as successful tool execution.
