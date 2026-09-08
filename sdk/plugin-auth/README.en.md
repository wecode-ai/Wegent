---
sidebar_position: 1
title: Python plugin account authentication SDK
---

# Python plugin account authentication SDK

This dependency-free Python 3.9+ SDK implements `accountAuth` draft protocol v1.
SDK version `0.7.0` is vendored into each plugin. The company email adapter uses it.

Optional `accountAuth.localEnvironment` declares non-secret source settings, for
example `{"DWS_CONFIG_DIR":{"type":"directory"},"DWS_DISABLE_KEYCHAIN":{"type":"enum","values":["1"]}}`.
Names match `[A-Z][A-Z0-9_]{0,63}`; at most 16 settings are allowed. Directories must
exist and be absolute on the source device. Enums contain 1–16 distinct public values
matching `[A-Za-z0-9_.-]{1,64}`. Missing/empty variables preserve provider defaults;
invalid values fail closed. Passwords, tokens and arbitrary strings are not supported.
Call `local_configuration()` from export/authorize/detach (Go: `LocalConfiguration()`).
The SDK returns a dictionary without overriding interpreter variables. An embedded CLI
adapter maps its own declared settings explicitly. The bounded 16 KiB payload stays on
the source device; never put it in exported credentials. Business, refresh and revoke
callbacks do not receive source settings. New plugins need no host-specific env whitelist.
Native export/run and public business dispatch are connected to desktop and
standalone Backend Runners. Native OAuth authorization and leased refresh are connected. Real backend/desktop tests pass with a synthetic OAuth provider. Persistent provider
revocation is connected; real-provider and native Windows acceptance remain pending.
The protocol remains a draft.

## Scaffold a provider

From the Wegent repository root:

```bash
uv run --no-project python sdk/plugin-auth/tool.py scaffold my-service \
  --parent ../plugins --credential-type password
```

Types are `password`, `bearer`, and `oauth2`. The scaffold contains a connector
manifest, `scripts/account-auth.py`, provider callbacks in `scripts/auth_provider.py`,
and the SDK with its license and checksums. It fails closed until configured;
it creates no login UI, Skill, MCP, or active connection. Keep existing localAuth
and business entry points. Never expose the native adapter as a model tool.

Implement these provider-specific parts:

| Interface                        | Responsibility                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `export_local()`                 | Read existing authentication into a JSON dictionary without changing local storage |
| `account_id(credential)`         | Return a stable public account identifier, never a secret                          |
| `ALLOWED_COMMANDS`               | Explicit business commands, excluding authentication management                    |
| `execute(credential, arguments)` | Execute using process-memory credentials and restore scoped state                  |
| `validate(credential)`           | Optional provider-specific validation beyond the SDK checks                        |

Required nonempty fields: password uses `username` and `password`; bearer uses
`token`; oauth2 uses `access_token`. Additional JSON configuration is allowed.
OS keychain databases and encrypted OS blobs are not portable credentials.

OAuth scaffolds declare `accountAuth.oauth2` operations and generate `authorize()`,
`refresh(credential)`, and `revoke(credential)` callbacks. Authorization uses a
local one-use intent. Platform refresh leases select one native actor; business
commands receive only Access Tokens after the rotated result is committed.
Return absolute Unix `expires_at` and a new `refresh_token` when rotated. The SDK
preserves unchanged identity fields and non-rotated refresh tokens. Do not retry
uncertain provider refresh requests. Late results cannot undo device revocation,
runtime replacement, disconnection, or reauthorization.

Put additional grant-management secrets in `provider_private`; business execution
does not receive that object, `refresh_token`, `client_secret` or `persistent_code`.
A CLI with a supported exclusive handoff can declare `exportMode: "exclusive"`
and implement `detach(migration_id, credential)`. The host stages encrypted escrow,
calls detach, then activates. Persist a recoverable receipt, remove only the
matching old grant, handle duplicate confirmation idempotently and raise on failure.
Never delete source credentials inside `export`. Password/API Key adapters do not
need detach.

If source credentials rotated after export, detach may raise `SourceChanged` only
after durably fencing off that migration ID under the provider storage lock. A
delayed or restarted operation with that ID must never delete credentials. The
SDK returns fixed `source_changed` metadata; the native host cancels old escrow.
A new user migration receives a new ID and exports current credentials. When
fencing cannot be proven, raise an ordinary error and retain recoverable escrow.

Disconnect immediately removes business access and queues encrypted revoke-only work.
Online native workers retry outages with backoff; successful callbacks erase retained
credentials. Revocation callbacks must be idempotent. The UI distinguishes native
provider receipts from user confirmation of external revocation. Existing third-party CLIs may still
refresh their original grant independently: export requires a supported exclusive
ownership transfer; otherwise obtain a separate Wegent grant. Provider callbacks
own browser authorization, state validation and PKCE S256. DWS requires its own
supported adapter.
JavaScript and PowerShell native SDKs are not included.

## Bundle and update

```bash
uv run --no-project python sdk/plugin-auth/tool.py vendor ../plugins/my-service
uv run --no-project python sdk/plugin-auth/tool.py vendor ../plugins/my-service --check
```

Maintain this canonical source, test it, then vendor it into plugins. `--check`
compares file contents, file lists, version metadata, and the license. The bundled
`vendor.json` also allows integrity checks inside a plugin repository; checksums
are not signatures and do not establish provenance. Do not edit vendored copies
or import a sibling development checkout at runtime. Follow the plugin repository's
version and release rules when distributing updates; this work is not published.

## Transport boundaries

The native host uses the authenticated loopback socket described below. Explicit FD
hosts may supply an inherited pipe FD >= 3 in `WEGENT_PLUGIN_AUTH_FD`, never a
secret environment value. Standard streams and regular files are rejected. Each
frame has a four-byte big-endian length plus UTF-8 JSON, bounded to 65536 bytes
including the envelope. Exact fields: integer `protocolVersion: 1`, `connectorSlug`,
`credentialType`, `credential`. Duplicate keys, nonfinite numbers, truncation,
invalid credentials, and oversized frames fail closed.

Export sends credentials only through the pipe and prints account metadata.
Run closes the pipe before executing the callback; the SDK does not write an auth
store. Authentication callback Python output is suppressed and caught exceptions
are sanitized. Plugins still own business output and must not print credentials,
raw upstream errors, or secret-bearing subprocess output.

The host owns authentication, provenance, permissions, grant revisions, deadlines,
and process cleanup. Pipes do not isolate hostile code under the same OS user.
Native sockets avoid platform-specific descriptor handoff. Windows process-tree cleanup
is implemented using the shared Executor guard; native Windows acceptance is pending.

## Verification

```bash
uv run --no-project python -m unittest discover -s sdk/plugin-auth/tests -v
```

Synthetic tests cover real authenticated socket subprocesses, isolated ZIP extraction,
credential types, failure redaction, frame limits, and vendor integrity. The
`plugin-auth-sdk.yml` workflow configures Linux/macOS/Windows on Python 3.9/3.12. Remote CI
and real cloud integration must be verified separately.

## Native cross-platform transport (SDK 0.4.0)

The native runner binds a random port on 127.0.0.1 and supplies only the port in
`WEGENT_PLUGIN_AUTH_PORT`. A cryptographically random 32-byte one-use capability
is transferred on child stdin. The SDK submits it to the listener before any
credential frame is sent. Provider credentials never travel on stdin or in env.
PORT and FD together fail; no transport fallback occurs. Explicit FD hosts remain
supported, while the native runner uses sockets to avoid Windows CRT inheritance.
Business commands cannot use stdin interactively in this mode.

NativeAdapter verifies the installed connector/adapter against the expected
backend definition. Callers must resolve roots from managed installation records,
never arbitrary model-provided paths. Credentials have no Debug or Serialize.
The native gateway uses dedicated events on the authenticated device socket.
Stdout is bounded to 1 MiB, errors are fixed codes, and execution is bounded.
Unix cancellation kills the dedicated process group. Windows process-tree cleanup
uses the shared Executor guard and awaits native Windows verification. Desktop migration
and cloud CLI dispatch have passed real backend/desktop tests using synthetic passwords
and OAuth providers. DWS and real providers require separate acceptance.

## Integrating an existing CLI

Call `delegate_cloud_command(plugin_root, connector_slug, argv, account_id=None)`
before reading local credentials. A returned integer is the exit code; `None`
means continue the ordinary local command. The scaffold includes `scripts/cli.py`.
The runner supplies a loopback business capability and device mode; SDK resolves
the managed installed ID. Cloud errors never downgrade to local login. Ordinary
local commands work offline; an explicit account ID selects an authorized account
connection in either mode. Working directories preserve relative business paths.

The native adapter establishes a scoped recursion guard when calling existing
business code. Provider credentials never enter this public HTTP API, environment
or stdout. The loopback capability only authorizes business execution. Plugins
must not print authentication fields in their business output.
