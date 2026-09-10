---
name: wework-plugin-creator
description: Create or extend Wework plugins, including native Connector login and account authentication for reuse on cloud devices. Use for Wework Plugin Creator tasks; preserve the selected Task workspace or managed personal marketplace.
---

# Wework Plugin Creator

Use the installed Codex `plugin-creator` skill for common plugin structure,
metadata, skills, and marketplace helpers. Apply the Wework workflow below to
storage, authentication, and validation. This skill and its authentication SDK
are shipped by the Executor and work without a Wegent source checkout.

## Choose the authentication path

Before generating a plugin, establish how its business commands authenticate:

- Public data or a skill without authenticated commands: do not add Connectors.
- An existing platform-managed remote Connector/MCP: reuse that connection;
  do not export platform credentials or wrap it in a local account adapter.
- A plugin-owned local CLI/session, password, API token, or OAuth authorization
  that must work on cloud devices: read
  [references/account-auth.md](references/account-auth.md), generate the adapter
  using the bundled SDK, and route business calls through that SDK.

`connectors` and `localAuth` alone do not enable account synchronization. Each
supported local credential flow needs `connectors[].accountAuth`, a working
provider implementation, and a delegated business entrypoint. If the provider
cannot safely support this, explain the concrete limitation; do not advertise
cloud authentication support or invent credential copying.

## Create and iterate

1. Resolve the source location from the task environment. For `DEVICE_TYPE=cloud`,
   use `$WEGENT_TASK_WORKSPACE/plugins/<plugin-name>`. Otherwise resolve the
   registered `wework-personal` marketplace and use its existing plugin directory.
   Do not use upstream defaults under `~/plugins` or `~/.agents`.
2. For native account authentication, use `scripts/auth-sdk/tool.py scaffold` as
   described in the reference. For other plugins, use the upstream scaffold with
   the explicit destination. Preserve existing source and manifest fields when
   extending a plugin; scaffold into a temporary directory to obtain templates.
3. Implement the requested skills/MCP/business commands. Keep the existing native
   Connector login entry; authentication setup remains a host operation, and
   cloud tasks must never request passwords, tokens, or exported credentials.
4. Run the Wework validator below, then test provider behavior with synthetic
   credentials and the unpacked distributable. A scaffold passing validation
   does not mean its provider is implemented or authenticated.
5. Locally, keep both managed marketplace manifests consistent and install/update
   through the existing managed marketplace flow. In cloud tasks, leave the source
   in the Task workspace and run `plugin-workspace describe` with the Executor.
   Return the complete `[WEGENT_PLUGIN_RESULT]` line verbatim. Publish only when
   requested, using the same source and the host's publication workflow.

## Validate

Run from this skill directory (use absolute script paths from another directory):

```bash
uv run --no-project --with pyyaml python scripts/validate_wework_plugin.py <plugin-root>
```

The validator reuses the installed upstream validator for standard manifest
fields, assets, and skills, and separately validates Wework Connectors. It does
not alter the plugin manifest. Do not run the upstream validator directly on a
Wework manifest containing `connectors`, or remove that declaration to make it
pass. For a Python adapter, also check the bundled SDK:

```bash
uv run --no-project python scripts/auth-sdk/tool.py vendor <plugin-root> --check
```

Report structural validation, provider tests, local login/synchronization, and
real cloud business execution separately. Do not claim the latter from generated
code or synthetic tests alone.
