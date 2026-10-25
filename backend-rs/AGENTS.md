# Wegent backend-rs contributor guide

Read the repository [contributor guide](../AGENTS.md) first. This directory is
the primary implementation for new Backend APIs and the Rust side of the
remaining incremental API migration.

## API ownership

- Implement every **new Backend API** here. Register its handler with
  `Application`, add it to the active `WEGENT_RS_ROUTES_FILE`, and add focused
  tests in the same change. Do not add a duplicate Python fallback handler.
- Implement an existing API here only when it is an active Rust-owned API:
  it has a Rust handler registered by `Application` and the active
  `WEGENT_RS_ROUTES_FILE` selects the same method and path.
- Keep existing APIs that are not selected for Rust in `backend/`.
- Do not copy a behavior change into both implementations unless the task
  explicitly requires parity on both runtime paths.

The checked-in `config/routes.toml` is the inventory of active Rust-owned APIs,
including migrated and newly added routes; every other request is forwarded to
Python. Shared Rust modules such as authentication, MySQL, and
FastAPI-compatibility helpers do not by themselves make an API Rust-owned.

## Finding Rust-owned APIs

Treat `config/routes.toml` as the checked-in inventory of public APIs owned by
Rust. For an existing API, find its matching `[[routes]]` entry by method and
path, then verify that `Application` registers the corresponding Rust handler.
If the task sets `WEGENT_RS_ROUTES_FILE`, inspect that effective file instead.
Do not create or maintain a separate endpoint list; the route configuration is
the single source of truth. Creating or migrating a Rust API must update the
handler, route entry, and focused compatibility tests in the same change.

For a new Backend API, changing `config/routes.toml` and adding its Rust handler
are part of the feature change. Moving an existing Python-owned endpoint to Rust
or adding or upgrading a Rust dependency remains migration work and requires
explicit task scope. If handler registration and route selection disagree, stop
and ask for direction.

## Migration compatibility

For a Rust-owned API, preserve the observable Python contract unless the task
explicitly changes it: method and path matching, authentication, request and
response JSON shape, status codes, error bodies, headers, uploads, streaming,
and upgrade behavior. Use the existing Python endpoint and its tests as the
compatibility reference. Keep gateway fallback behavior intact for all
non-selected routes.

## Rust conventions and verification

- Keep public handlers small and delegate reusable logic to focused modules.
- Do not use `unsafe`; the crate forbids it.
- Prefer the existing `brz-*` abstractions and pinned dependency versions over
  introducing another web, logging, metrics, or database framework.
- Add focused tests for changed request handling and compatibility behavior.

For Rust code changes, run the relevant commands from this directory:

```bash
cargo fmt --check
cargo test
```

Choose when to run focused tests or the full project suite based on the scope
and risk of the changes.
