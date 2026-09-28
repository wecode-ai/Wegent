# Wegent backend-rs

`backend-rs` contains the open-source Wegent Rust APIs and the hybrid listener.
It is a library plus a small executable built from `AppState`, `Application`,
and the reusable hybrid runtime. Generic streaming proxy and upgrade behavior
live in `brz-http-gateway`.

The route configuration selects the migrated public APIs. Requests without a
matching method and path continue to the Python backend. The checked-in
`config/routes.toml` activates only the APIs that have completed cutover, so
every other request is forwarded to Python.

## Run

`backend/start.sh` remains unchanged as the standalone Python entry point. The
repository-level `start.sh` selects the Backend mode:

```bash
# Existing behavior: Python listens on 0.0.0.0:8000.
./start.sh

# Hybrid behavior: Rust listens on 0.0.0.0:8000 and Python on 127.0.0.1:8004.
WEGENT_BACKEND_MODE=hybrid ./start.sh backend
```

The repository-level launcher resolves the backend directory from
`WEGENT_BACKEND_RS_DIR`. Set it to `backend-rs` to run this directory:

```bash
WEGENT_BACKEND_MODE=hybrid \
WEGENT_BACKEND_RS_DIR=backend-rs \
./start.sh backend
```

The selected directory must contain an executable
`scripts/start-hybrid-backend.sh` launcher.

In hybrid mode the root script delegates Backend process supervision to
`backend-rs/scripts/start-hybrid-backend.sh`, which builds and runs the
optimized Cargo release profile by default. Set `WEGENT_PYTHON_UPSTREAM_PORT`
to override the script's Python upstream port; its default is `8004`.

Direct gateway configuration uses these environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEGENT_RS_LISTEN_HOST` | `0.0.0.0` | Public gateway bind host |
| `WEGENT_RS_LISTEN_PORT` | `8000` | Public gateway bind port |
| `WEGENT_PYTHON_UPSTREAM_URL` | `http://127.0.0.1:8004` | Python origin |
| `WEGENT_BACKEND_RS_ENV_FILE` | `config/example.env` | Dotenv file read by the gateway; the launcher defaults it to the Python Backend's `.env` |
| `WEGENT_RS_ROUTES_FILE` | unset | Optional TOML route file; unset forwards every request to Python |

The launcher sets `WEGENT_RS_ROUTES_FILE` to the selected backend's
[`config/routes.toml`](config/routes.toml). The internal backend's route file
includes this public list and adds its own routes. Rules can match exact paths,
path prefixes, or templates with `:parameter` and terminal `*path` segments.
Named parameters match one nonempty path segment, so unrelated Python paths
under the same prefix remain with Python.

## Observability foundation

The Rust binary initializes `brz-logs`, writing its `info.log`, `warn.log`, and
`error.log` files to a `rust` subdirectory of the Backend `LOG_DIR` supplied by
the repository launcher. The hybrid launcher nests it under `logs/backend/rust`
when the Backend `LOG_DIR` is absent; `BREEZE_LOG_DIR` can override it.
`brz-metrics` is pinned to the process-global-registry release used by the
registered Rust APIs.

## Library boundary

`Application` owns an `Arc<AppState>` and the public routes exported through
`brz-http-server` macros. A private binary can collect its own named route group
and merge it with `Application::with_routes` without introducing private state
or modules into this crate. `run_hybrid` serves the composed application;
`serve_hybrid` remains the lower-level entry point for custom matched services.

Macro-exported Rust APIs run on a loopback-only Breeze listener in the gateway
process. The public listener forwards configured Rust routes to it and sends
all other requests to Python. An unset route file remains a full Python
fallback for deployments that have not enabled the cutover.
