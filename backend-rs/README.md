# Wegent backend-rs

`backend-rs` is the public Wegent integration boundary between the existing
Python backend and incrementally implemented Rust APIs. It is a library plus a
small executable built from `AppState`, `PublicApi`, and the reusable hybrid
runtime. Generic routing, streaming proxy, and upgrade behavior live in
`brz-http-gateway`.

The initial route configuration is empty. Therefore hybrid mode forwards every
HTTP request, streaming response, upload, and upgraded connection to Python.

## Run

`backend/start.sh` remains unchanged as the standalone Python entry point. The
repository-level `start.sh` selects the Backend mode:

```bash
# Existing behavior: Python listens on 0.0.0.0:8000.
./start.sh

# Hybrid behavior: Rust listens on 0.0.0.0:8000 and Python on 127.0.0.1:8004.
WEGENT_BACKEND_MODE=hybrid ./start.sh backend
```

The repository-level launcher uses `backend-rs` by default. The Rust Backend
directory can be selected without changing the public startup flow:

```bash
WEGENT_BACKEND_MODE=hybrid \
WEGENT_BACKEND_RS_DIR=custom-backend-rs \
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
| `WEGENT_RS_ROUTES_FILE` | unset | Optional TOML route file; unset is empty |

The example [`config/routes.toml`](config/routes.toml) is intentionally empty.
Setting `WEGENT_RS_ROUTES_FILE` to that file preserves full Python fallback.

## Observability foundation

The Rust binary initializes `brz-logs`, writing its `info.log`, `warn.log`, and
`error.log` files to the Backend `LOG_DIR` supplied by the repository launcher.
The hybrid launcher defaults to `logs/backend` when that variable is absent;
`BREEZE_LOG_DIR` can override it. `brz-metrics` is pinned to the
process-global-registry release for future migrated APIs, but the initial
all-Python fallback does not register API metrics or start profile reporting.

## Library boundary

`PublicApi` owns an `Arc<AppState>` and currently delegates selected requests to
`NoRustApi`. Implement public routes behind this type as APIs migrate. Consumers
can retain the state/API boundary, add routes, and call `run_hybrid` or
`serve_hybrid` from their own binary.

Rust route implementations run in the gateway process; they do not open a
second internal Rust listener. With the initial empty configuration every
request is forwarded to Python.
