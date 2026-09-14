# Wegent backend-rs

`backend-rs` is the public Wegent integration boundary between the existing
Python backend and incrementally implemented Rust APIs. It is a library plus a
small executable for supplying additional `RustApi` routes. Generic routing,
streaming proxy, and upgrade behavior live in `brz-http-gateway`.

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

## Public extension seam

Implement `RustApi` and construct `Gateway<RouteImplementation>` with a
validated `RouteTable`. An extension crate can depend on this library, combine
route configuration, and run its own binary.

Rust route implementations run in the gateway process; they do not open a
second internal Rust listener. With the initial empty configuration every
request is forwarded to Python.
