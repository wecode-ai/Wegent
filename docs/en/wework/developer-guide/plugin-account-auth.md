---
sidebar_position: 65
title: Plugin account authentication
---

# Plugin account authentication

## Delivery status

The implementation includes the Backend, native Executor, background account connections,
Python SDK 0.7.1, and email and DWS native adapters. Isolated real Backend, Electron and
remote-executor E2E tests cover 20 assertions, including runtime-copy execution, password
updates, offline OAuth refresh, recoverable DWS handoff, device revocation, and managed
status, logout and relogin through the original local entry. Email 0.2.3
has also passed a real-account read on a simulated remote device in a local test environment.
Five-platform adapter packaging, public-repository build CI and internal declarative plugin
builds are connected. Production publication, real-provider OAuth and native Windows
acceptance still require separate verification. `accountAuth` remains a draft protocol,
not a promise that every Connector plugin automatically supports account reuse.

Public business entry points resolve installation identity from the host manifest's
`store_path`, `runtime.codex_link` and `runtime.claude_link`, including copied runtime caches.
The native executor still verifies and executes the adapter from the managed package store.
Device grants bind to the unique execution route and Runtime instance, preventing stale
shared desktop aliases from disrupting authentication reuse after a restart.

## Credential flow

Account-wide automatic connection is enabled by default. The native executor checks
installed plugins every 15 seconds and retries unavailable local credentials after at least
60 seconds, including a later local login. No migration or device-grant click is required;
the OS can still require initial Keychain permission. The native executor
checks the managed package, checksum and adapter declaration, then reads the plugin's
existing credential through its provider callback. An authenticated native device
channel enrolls the credential in a user-owned connection encrypted with AES-256-GCM.

An authorized cloud executor obtains credentials only for native adapter execution.
It does not copy the macOS Keychain database or write a cloud Keychain. Provider
credentials never enter the renderer, model tools, ordinary task parameters, or public
business proxy API. Password migration preserves the original local credential.
Exclusive transfer removes the account's original local authorization after migration.
Supported Wework commands automatically use the account broker; external tools need their own login.

Connections use the existing `kinds` table with kind `ConnectorConnection` and namespace
`plugin-auth`; no DDL migration is required. Queries include owner, namespace, kind
and name. Connection identity binds plugin provenance, connector and provider account.
First enrollment locks the user row; later mutations compare `revision` and return
409 for stale writes. Decisions under the owner lock use current locking reads, so
an earlier `REPEATABLE READ` snapshot cannot hide concurrent enrollment or transfer
state. Owner locking also refreshes cached ORM activation state. Real MySQL 8.0
race acceptance has passed.

Device grants bind the logical device ID, database row, runtime ID and runtime instance
ID. Recreated devices cannot inherit grants. Removed or disabled plugins and changed
provenance or adapter declarations cannot continue using credentials. Ordinary device
registration, heartbeat, task startup and local offline commands do not require the
credential service to be configured or online.

## Automation and opt-out

The UI has no account-migration panel, device-authorization buttons or automatic-connection
switch. Only the existing plugin-local login flow remains. Background synchronization defaults
to enabled. Disabling it through the management API stops new enrollment and grants while
preserving existing connections and recoverable exclusive transfers. Manual revocations and disconnected accounts persist as
tombstones; background reconciliation never restores them. New cloud devices owned by the
same account receive eligible grants when online. Other owners, revoked devices, replacement
instances with old bindings, and changed plugin provenance or definitions cannot inherit access.

Automation only exports existing authentication; it never opens an OAuth login page or starts
QR login. First login still uses the local plugin flow. Local authorization changes automatically update the account connection; subsequent cloud
commands use the new credential without an update click. A domain-separated keyed HMAC records
each source device’s last observed credential. Unchanged local state cannot overwrite tokens
already refreshed in the cloud. Disconnected connections remain disabled. Implementing `accountAuth` and SDK export/business callbacks
is sufficient; plugin authors need no additional installation hook or device integration. Export
callbacks must only read existing state and fail without initiating login when no credential exists.
After an exclusive DWS handoff, Wework commands detect the durable transfer receipt and use the
account broker, requiring backend connectivity. The original external CLI grant is removed.

### Existing local login entry and managed connections

Managed plugins declaring both `localAuth` and `accountAuth` retain their original login entry.
Health checks first probe authentication still owned locally, preserving offline local use. When
that authentication has been removed or is unavailable, the native executor checks the account
connection and current device grant. Local-auth children also receive the existing business broker
environment, allowing SDK-based local calls with managed authentication.

Logout first suspends synchronization for the plugin provenance and connector, disconnects its
account connections so subsequent cloud calls lose authorization, and then runs local cleanup.
Provider OAuth revocation uses the existing background queue. Failed local cleanup can be retried
without restoring cloud access. A staged exclusive handoff returns `plugin_auth_transfer_pending`:
its recovery must finish before logout can proceed. Plugin logout commands must clean up local
state idempotently even when the provider token is already invalid.

A successful login through the original entry records a synchronization intent bound to the source
device instance, permitting fresh authentication to reconnect a disconnected account. Ordinary
background probes cannot authorize this transition. Expired intents can be renewed; enrollment
clears the pending marker, and logout fences existing intents. This integration uses the existing
export, exclusive handoff, refresh and revoke contracts. It adds no plugin authentication protocol
and exposes no account-management operations through the business broker.

## Backend configuration

- `WEWORK_PLUGIN_CREDENTIAL_KEYS`: JSON mapping key IDs to Base64-encoded random 32-byte keys.
- `WEWORK_PLUGIN_CREDENTIAL_ACTIVE_KEY_ID`: key ID used for new writes.

There is no default key. Missing configuration only fails credential reads/writes.
Authenticated encryption binds owner, provenance, account, credential type and adapter.
For rotation, add a new key and change the active ID; retain old keys while stored
ciphertext references them. A bulk re-encryption command is not implemented. Never
configure these keys on clients or commit them to source control.

## Plugin contract

Use the [shared Python SDK and templates](../../../../sdk/plugin-auth/README.en.md).
Developers do not implement framing, pipes or credential envelope parsing. The SDK
ships inside the plugin, and `vendor --check` verifies exact source consistency.
A new compliant plugin does not need changes to device scheduling. Existing plugins
need provider-specific adaptation; plugins without `accountAuth` keep existing behavior.

```json
{
  "accountAuth": {
    "protocolVersion": 1,
    "credentialType": "password",
    "adapter": "scripts/account-auth.py"
  }
}
```

| Plugin type        | Provider responsibility                                                                | Platform / SDK responsibility                                                            |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Password / API key | Read existing auth, stable account ID, allowed commands, credential consumption        | Validation, private transport, encryption, device grants, process lifecycle              |
| OAuth              | authorize / refresh / revoke callbacks, browser state and PKCE, ownership of the grant | One-use authorization intents, exclusive refresh leases, durable rotation and revocation |
| Third-party CLI    | Supported export, injection and exclusive refresh mechanism                            | Shared account connection and native broker                                              |

Public business CLIs call `delegate_cloud_command` before reading local authentication.
Cloud execution must use the broker; failure never initiates a cloud login. Ordinary
local commands remain available offline. An explicit public `account_id` selects among
multiple connections and also lets local commands use a platform connection. JavaScript
and PowerShell SDKs are not provided; native `.ps1` adapters explicitly report unsupported.

## OAuth lifecycle

Declare supported operations in `accountAuth.oauth2`: `authorize`, `refresh`, `revoke`.
Authorization runs in a native local process; the UI passes only an intent ID. Return
absolute Unix seconds in `expires_at`. Refresh callbacks may return a rotated
`refresh_token`; the SDK preserves unchanged identity fields and non-rotated tokens.

Backend issues a 90-second exclusive refresh lease. Business callbacks receive only
Access Tokens and cannot refresh independently. An uncertain refresh is not replayed
with an old token. The lease coordinates Wegent devices only: an external CLI must
support transferring exclusive refresh ownership, otherwise use a separate Wegent
grant. Never let the CLI and platform independently rotate the same Refresh Token.

Disconnect immediately clears business credentials and device grants. If supported,
encrypted credentials remain only in a revoke-only job claimable by matching native
device instances. Online executors check every 15 seconds. Provider failures back off
and require attention after five failures. Successful revocation erases retained secrets.
The callback must be idempotent for retries following outages or lost acknowledgements.

A refresh completing after disconnect updates only the revocation job and never
restores business access. Lost rotation results require action at the provider. The management API
distinguishes pending, provider-revoked, attention, unsupported, and user-confirmed
external revocation. Unfinished revocation blocks replacement of the same connection.
User attestation is not presented as a provider receipt. Platform revocation cannot
invalidate an already copied password; that requires a provider password change.

## Native transport and process boundaries

The native host listens on a random `127.0.0.1` port and gives the child a one-use
32-byte capability through stdin. Provider credentials travel only over the authenticated
socket, never environment variables, arguments or stdout. Frames use a four-byte
big-endian length and UTF-8 JSON, limited to 65536 bytes. The SDK also accepts an explicit
private FD, rejecting standard streams, ordinary files, duplicate keys, nonfinite values
and ambiguous simultaneous channels.

Adapters have deadlines and output limits; authentication errors expose fixed codes.
Unix cancellation terminates the process group. Windows reuses the Executor process-tree
terminator before killing the root process and hides the console. Cross-platform native
CI coverage is configured; only macOS has been exercised locally. This transport does
not sandbox malicious processes running as the same OS user.

## DWS and downloads

The official DWS v1.0.58 portable store does not support Windows DPAPI / Registry export
or direct export from the default macOS Keychain mode. Do not reset, force re-login or
copy partial files to claim successful migration. The
[DWS companion](../../../../sdk/dws-auth/README.en.md) now builds pinned upstream source
plus extensions, reusing upstream stores, refresh locks, exact-account deletion,
OAuth and business commands. Shared Go code owns the transport. The public CLI and
24 Python helpers now use the public SDK. The packager enables `accountAuth` and
includes five native platform targets. Packaged private-entry checks and Backend
parsing/scanning passed locally. The ordinary source manifest does not enable the
new declaration. Refresh-race recovery durably fences the old ID, cancels obsolete
escrow and retries with a new migration ID.

`exportMode: "exclusive"` selects encrypted, non-executable escrow, source-native
durable detachment, then transactional connection activation. Lost acknowledgements
can be replayed. An explicit UI resume rebinds only the same source device record
after restart. Pending escrow prevents competing enrollment for that account.
Extra provider secrets belong in `provider_private`, excluded from business
credentials alongside refresh tokens.

DingTalk shell and PowerShell installers accept `DWS_DOWNLOAD_BASE_URL` with layout
`<base>/v1.0.58/<archive>`, retaining pinned versions, HTTPS and SHA-256 checks. A managed
accelerated artifact source has not been deployed. Desktop builds already materialize
DWS sidecars from npm package assets, which is separate from standalone plugin installation.

## Verification and remaining work

Local checks include 143 Backend cases, 12 real MySQL transaction races, 123 plugin UI
cases, 17 native adapter integration cases and 8 native module tests. An independent real
Electron session automatically enrolled an isolated official DWS source store before opening
plugin details. The detail page had no additional account authorization controls; source
ownership transferred, another account remained unchanged, and reload retained the connection.
The five-platform DWS package was rebuilt and validated; 10 public-entry delegation tests passed.

The CI-registered desktop regression remains:

```bash
pnpm --filter wework e2e:desktop --cloud-only --segment plugin-account-auth
```

It covers missing authentication at installation, later local login, automatic credential
updates, cloud business execution, source-change fencing, automatic recovery after interrupted
exclusive handoff, cloud OAuth refresh while the source is offline, provider revocation,
official DWS source migration and durable device revocation. UI assertions prohibit additional
account-migration, device-authorization or synchronization controls.

Manual acceptance requires only normal local plugin installation/login followed by use on
an owned cloud device. After changing local authentication, allow the background check interval
and verify that subsequent cloud commands use it. Initial OS Keychain permission may still be
required; this is not another cloud login.

All fixtures use synthetic credentials. Real email/DingTalk providers, native Windows,
remote CI, publication and deployment still require their corresponding environments.
Nothing was committed, pushed or deployed in this change.

## Publication integration

DingTalk 0.3.1 keeps its build declaration and all compiler/SDK inputs inside the
plugin directory. Existing GitHub mirroring, internal MR, package, test and release
jobs remain the publication path. Local official publication also builds automatically.
Backend verifies reviewed inputs separately from generated outputs, and checks the
GitLab package artifact plus the digest recorded by the successful test job.
Source-only packages cannot be published as complete native plugins.

Local build and mocked GitLab API regression checks do not prove a remote pipeline
has executed. Actual merged-MR publication requires pushed code, deployed services
and verification in the configured release environment.

### Local authorization diagnostic stream

Local authorization commands can emit JSON lines prefixed with
`WEGENT_PLUGIN_AUTH_DIAGNOSTIC:` on stderr. The Executor consumes them before the
command exits and records allowlisted fields in the existing `executor.log`,
which is already included in unified feedback exports. Stdout remains the command
JSON result; plugins must not write directly to the Executor log file.

The initial company-email integration accepts the plugin, stage, status, platform,
a 32-character hexadecimal `attempt_id`, fixed reasons and error codes, and numeric
`exit_code` / `system_code`. Unknown fields and non-protocol lines are not logged
as diagnostics. Lines are limited to 4096 bytes and each invocation to 256 events;
the pipe continues draining after the limit. Command stdout is limited to 1 MiB.
Events already received remain available if authorization times out or is cancelled.

The email plugin must also emit this protocol and relay Windows stderr. Updating
only the host cannot recover output discarded by the plugin launcher. Diagnostics
do not include accounts, passwords, command arguments, or raw exception text.
