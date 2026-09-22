# Wegent backend-rs contributor guide

Read the repository [contributor guide](../AGENTS.md) first. This directory is
the Rust side of an incremental API migration, not a second default backend.

## API ownership

The Python `backend/` remains the default implementation while Rust
dependencies and the migration surface are still stabilizing.

- Implement every **new public API** in `backend/`, not here.
- Implement an existing API here only after it is an active migrated Rust API:
  it has a Rust handler registered by `Application` and the active
  `WEGENT_RS_ROUTES_FILE` selects the same method and path.
- Implement all other existing APIs in `backend/`.
- Do not copy a behavior change into both implementations unless the task
  explicitly requires parity on both runtime paths.

The checked-in `config/routes.toml` activates only the APIs that have completed
cutover; every other request is forwarded to Python. Shared Rust modules such as
authentication, MySQL, and FastAPI-compatibility helpers do not by themselves
make an API migrated.

## Finding migrated APIs

Treat `config/routes.toml` as the checked-in inventory of public APIs owned by
Rust. For an existing API, find its matching `[[routes]]` entry by method and
path, then verify that `Application` registers the corresponding Rust handler.
If the task sets `WEGENT_RS_ROUTES_FILE`, inspect that effective file instead.
Do not create or maintain a separate endpoint list; the route configuration is
the single source of truth. A route migration must update the handler, route
entry, and focused compatibility tests in the same change.

Changing `config/routes.toml`, adding a public Rust handler, or adding or
upgrading a Rust dependency is migration work. Do it only when the task
explicitly includes that scope. If handler registration and route selection
disagree, stop and ask for direction.

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
cargo clippy --all-targets -- -D warnings
```
