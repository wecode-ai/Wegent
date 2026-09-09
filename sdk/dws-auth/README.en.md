---
sidebar_position: 1
---

# DWS account authentication adapter

The installed package declares source directories `DWS_CONFIG_DIR` and
`DWS_KEYCHAIN_DIR`, plus the public `DWS_DISABLE_KEYCHAIN=1` switch, through
`accountAuth.localEnvironment`. The host validates these settings and supplies
them only to local authentication callbacks. The Python SDK entry explicitly
passes them to the official adapter so migration reads the selected source store.
Unset settings retain upstream defaults; directories must exist and be absolute.
Settings are not uploaded to the backend or supplied to cloud business, refresh
or revocation callbacks.

Build the native companion from pinned DWS `v1.0.58` source plus Wegent extensions.
The source archive SHA-256 is
`f6b2dcf16b34492d7be25ce63fc81c7155d6a857af21c0604ae16bf4fa96f1e2`.
`overlay/` reuses upstream edition hooks, OAuth refresh, revocation and business
commands. `auth-overlay/` adds a function inside the upstream auth package to use
its existing refresh lock and exact-account deletion. Shared framing lives in
`../plugin-auth-go`.

```bash
uv run --project backend python sdk/dws-auth/build.py \
  --output executor/target/dws-auth/dws-account-auth --test
```

`--source-archive` accepts an already downloaded archive without bypassing checksum
verification. `GOOS` / `GOARCH` select cross-compilation targets. Outputs include
the binary, LICENSE, NOTICE, and a JSON inventory containing upstream/source/binary
hashes and target platform. Tests use isolated upstream storage and synthetic
HTTP providers, never personal Keychain entries or real DingTalk accounts.

## Exclusive refresh ownership

The plugin declaration must use `accountAuth.exportMode: "exclusive"`:

1. Export the local MCP OAuth account into encrypted backend escrow without a
   usable connection or device grant.
2. Detach compares the snapshot under the upstream refresh lock.
3. Persist a receipt containing no tokens; remove only that account and its
   upstream mirrors; verify the grant is absent; persist the completed receipt.
4. The native host confirms detachment. One backend transaction activates the
   connection, grants the source device and removes escrow ciphertext.

The receipt recovers a crash after deletion; backend confirmation is idempotent.
Refresh races durably fence off the old ID under the provider lock before the
native host cancels escrow. A user retry exports current credentials with a new
ID; delayed operations cannot delete credentials or activate the old snapshot.
Changed accounts and uncertain storage states still fail closed. Only
MCP OAuth is supported; direct-mode client secrets are not imported. Business
execution receives access credentials only and uses memory-backed store hooks.

## Build the complete plugin

```bash
uv run --project backend python sdk/dws-auth/package.py \
  --plugin ../wework-plugins-public/plugins/dingtalk \
  --output executor/target/dws-auth/dingtalk-account-auth.zip
```

The source declares `accountAuth` and includes the SDK. The packager preserves
those reviewed inputs and builds macOS arm64/amd64, Linux arm64/amd64 and Windows amd64 companions.
It rejects symlinks, verifies binary hashes and license files, then runs the real
packaged private entry on the build host. Health must succeed; wrong connector
identity and business credentials containing a refresh token must fail without
creating local account state. Failure preserves any previous output artifact.

Packages retain the existing 50 MiB upload and 200 MiB expanded limits. The public
CLI and 24 Python helpers now delegate through the public SDK. Readiness checks
for transferred accounts do not initiate DWS login.

## CI and official distribution

The plugin-local `.wework-build.json` declares a Python build entry and generated
directories. All inputs live under `plugins/dingtalk/.wework-build/`, so selecting
and mirroring the plugin into an internal MR retains the complete build contract.

```bash
uv run --project backend python sdk/dws-auth/vendor.py ../wework-plugins-public
uv run --project backend python sdk/dws-auth/vendor.py --check ../wework-plugins-public
uv run --no-project python sdk/plugin-build/vendor.py ../wework-plugins
```

The existing `package_plugin → unit_linux → release_plugin` pipeline remains the
publication path. Packaging runs the declared builder and prepares checksum-pinned
Go tools when needed. Tests exercise the extracted ZIP and retain its tested digest.
Release uploads that exact artifact; plugins without declarations keep source packaging.

Every reviewed source byte and mode must survive unchanged; only declared generated
directories may be added. Backend validates the protected commit, MR and input tree,
then independently verifies the successful GitLab package artifact and test digest
receipt. Missing outputs, altered sources, substituted artifacts or missing successful
tests block release. Builds receive no release credentials or personal auth environment.

Local publication uses the same entry and automatically chooses the build:

```bash
cd backend
uv run python scripts/publish_official_plugin.py ../../wework-plugins-public/plugins/dingtalk --slug dingtalk --visibility public --dry-run
```

Remove `--dry-run` to publish to the configured market. Batch seeding also builds
automatically. `--prebuilt --sha256` remains an operator artifact-import option,
not a required everyday publication step.

## Delivery boundary

Only the default DingTalk MCP provider is supported. A source with a custom
`mcp_url` is rejected before credential export. Memory execution also isolates
device-local DWS configuration so it cannot change the token recipient.

Source tests cover recovery, exact-account deletion, refresh-race rejection and
real upstream business commands. macOS builds and Windows/Linux cross-compilation
have been checked; native Windows storage and real-provider acceptance remain.
The source plugin manifest does not enable `accountAuth`; artifacts produced by
the packager do. Build and official distribution entry points are connected;
a minimal business fixture built with the same packager, launcher and five native
targets passed real publishing, installation, Backend/Electron/cloud-executor account
status checks: denied before a grant, successful after granting, denied after revocation.
Separate Electron verification used upstream code to create an isolated encrypted
source store. Desktop migration removed only the selected source grant, preserved
another account and retained the connection after reload. Evidence:
`wework/test-results/ai-verify/2026-09-07T12-19-29-787Z-40328/dws-source-qa.json`.
All credentials are synthetic; no personal keychain was accessed. Real providers,
system Keychain/DPAPI, remote CI and actual publication remain unverified.
The registered desktop checkpoint also passed upstream source-store migration,
cloud grant, business execution and revocation. All 20 flags passed; evidence:
`wework/test-results/desktop-e2e/2026-09-07T12-20-59-116Z-47125/`.
Generic SDK transfer
recovery has passed real Backend/Electron/cloud-executor E2E with a synthetic provider. A source build is not
a published, user-ready plugin.
