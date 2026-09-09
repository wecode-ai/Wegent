---
sidebar_position: 1
---

# Go plugin authentication SDK

Version `0.3.0` implements the native private channel for `accountAuth` draft v1.
Implement `Provider` callbacks and call `Serve`; the DWS companion is the first
integration. The SDK owns the nonce handshake, loopback transport, framing and
identity checks, suppressed auth output and fixed errors. Providers own public
business output and must reject credential overrides, auth commands and debugging
through `Allowed`.

Refresh returns a complete `Account`. Unlike Python's incremental merge API, Go
providers preserve unchanged account fields and non-rotated refresh tokens. The
backend also validates account identity. Keep extra grant-management material in
the `provider_private` object, which is excluded from business credentials along
with refresh tokens, client secrets and persistent codes.

Optional `Detach(ctx, migrationID, credential)` runs only after durable encrypted
escrow. Return nil only after an idempotent, recoverable source-store handoff.
Never delete source credentials in `Export`. The declaration
`exportMode: "exclusive"` selects stage → detach → activate in the native host.
Do not declare this capability without a supported source-store transfer API.

Return `ErrSourceChanged` only after durably fencing off the old migration ID
under the provider lock, preventing every delayed detach from deleting source
credentials. The host then cancels obsolete escrow; a user retry exports current
credentials with a new ID. Persistence failures or uncertain source state must
return an ordinary error and retain recoverable escrow.

Declare custom source directories and public switches as `directory` or bounded
`enum` entries in `accountAuth.localEnvironment`. Read host-validated settings
with `LocalConfiguration()` in `Export`, `Authorize` or `Detach`. They are not
merged into the process environment or provided to `Run`, `Refresh` or `Revoke`.
Do not include local paths in exported credentials. See the
[Python SDK](../plugin-auth/README.en.md) for the declaration and limits.

The SDK does not yet include public CLI broker delegation and does not own
Keychain storage, device grants or provider HTTP protocols.

```bash
cd sdk/plugin-auth-go
go test -race ./...
```
