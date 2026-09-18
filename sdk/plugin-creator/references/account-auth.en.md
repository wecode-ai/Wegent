---
sidebar_position: 1
title: Wework plugin authentication
---

# Wework plugin authentication

Use this flow for plugin-owned local authentication. Reuse existing
platform-managed remote Connectors without exporting their credentials.
`localAuth` describes native login; `accountAuth` enables account reuse across
devices. The host synchronizes after local login and supplies temporary
credentials to authorized native business calls. Do not add credential upload
APIs, synchronization buttons, or model-visible export tools.

From the skill root, run:

```bash
uv run --no-project python scripts/auth-sdk/tool.py scaffold my-service \
  --parent <task-selected-parent> --credential-type password
```

Supported types are `password`, `bearer`, and `oauth2`. The Executor bundles the
canonical SDK and templates; a Wegent checkout is unnecessary. The generated
adapter, provider, business CLI, and SDK are development scaffolds that reject
export and execution until implemented. For existing plugins, scaffold in a
temporary directory and merge into the existing Connector without replacing its
slug, `localAuth`, MCP, or unrelated manifest fields. Update SDK copies with
`tool.py vendor <plugin-root>`.

Implement read-only `export_local()`, public `account_id()`, a business-only
`ALLOWED_COMMANDS`, and in-memory `execute()`. Add provider validation as needed.
Existing CLIs must call `delegate_cloud_command()` before reading local auth and
propagate its exit code when non-None. Cloud failures must not trigger local
fallback or login. MCP servers must invoke the delegated business path; adding
a declaration to a long-running MCP server that reads credentials itself is
insufficient.

Preserve native login. New `localAuth` definitions need real `health`, `start`,
and, for `local_qr`, `poll` commands; optional `logout` should match the provider.
Use `browser_oauth` only for a supported browser flow. Do not disguise password
or API-key input as QR login. If native setup is unavailable, identify the
missing host capability. Commands use package-relative paths and return public
status metadata only.

OAuth providers implement the declared `authorize`, `refresh`, and `revoke`
operations, state/PKCE S256, absolute `expires_at`, and refresh-token rotation.
Keep refresh-only secrets in `provider_private`. Business code must not refresh
credentials or retry an uncertain refresh. CLI-managed OAuth requires transfer
of exclusive refresh ownership with recoverable, idempotent `detach`, or a
separate Wegent authorization. DWS requires its specialized native build and
migration adapter. This scaffold supplies Python, not JavaScript/PowerShell SDKs.

Declare non-secret local directories/enums in `accountAuth.localEnvironment` and
read them through `local_configuration()` in source-device callbacks. Do not
upload local paths or use configuration fields for secrets. See the bundled
[SDK protocol](../scripts/auth-sdk/README.en.md) for details.

Validate the full manifest with the Wework validator and run SDK `vendor --check`.
Test the unpacked artifact with synthetic credentials, allowed/denied commands,
exit-code propagation, redacted errors, and OAuth lifecycle where relevant.
Separately verify native login and automatic sync, then real business execution
on a device without local provider credentials. Revoked or unauthorized access
must fail without login. Report these layers separately; structural validation
does not prove an implemented provider or cloud authentication.
