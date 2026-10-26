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

Both `backend/start.sh` and the repository-level `start.sh` default to hybrid
mode: Rust listens on `0.0.0.0:8000` and Python on `127.0.0.1:8004`.

```bash
# Start only the Backend from the repository root.
./start.sh backend

# Or start from the backend directory, including uv dependency setup.
cd backend
./start.sh

# Python-only debugging; Rust-owned APIs are unavailable in this mode.
WEGENT_BACKEND_MODE=python ./start.sh
```

Both launchers resolve the Rust backend directory from `WEGENT_BACKEND_RS_DIR`,
which defaults to `backend-rs`. To select a different Rust backend, run from the
repository root:

```bash
WEGENT_BACKEND_RS_DIR=backend-rs-internal ./start.sh backend
```

The selected directory must contain an executable
`scripts/start-hybrid-backend.sh` launcher.

In hybrid mode both scripts delegate Backend process supervision to
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

API 响应码与服务器超时统一导出到带 `status_code` 的 `brz_req_total`；每个请求仅计一次，不再输出无状态码的 API 总数或 `brz_api_resp_total`、`brz_api_timeout_total`。错误、慢请求及耗时仍按路由累计，超时仅在达到慢请求阈值时计为慢请求。

`GET /metrics` streams the process registry in Prometheus text format. The
default route configuration selects this handler for Rust. Request, error,
slow-request and duration counters are cumulative. API request counts now use
`brz_req_total{type="API",name="...",status_code="200"}` and
`status_code="timeout"` for server deadline expiry; each request increments one
result counter. There is no unlabeled API total or separate `brz_api_resp_total` /
`brz_api_timeout_total`. Sum across `status_code` for total request rates. Error,
slow-request and duration sums remain route-level totals; a timeout is always
an error and is slow only when it reaches the configured threshold.
Connection metrics expose the current count (`brz_conn`)
and successful establishments (`brz_conn_total`), from which Prometheus computes
CPS with `rate(brz_conn_total[1m])`. Scrapes do not reset metrics or write a
`profile.log`. Durations export seconds with two decimal places.

A binary composing `Application` inherits the handler, and including this
crate's route configuration activates it on the public gateway.

Redis 指标把业务资源名称与地址分开：`name` 统一读取 `REDIS_RESOURCE_NAME`，默认 `backend`，`endpoint` 保留配置中的 `host:port`（包括 DNS 名称）。请求的 `access` 为 `read` / `write`；读请求回退到 master 时仍计为读，混合 pipeline 按每条命令分别计数。连接使用独立的 `role=read` / `write` 标签，复用和 clone 不增加连接累计值。MySQL 使用 `read` / `write` / `other`（完整事务），不采集连接数。

主 Redis 和 MySQL 服务分别读取 `REDIS_RESOURCE_NAME`、`MYSQL_RESOURCE_NAME`，未设置或留空时均使用 `backend`。支持进程环境变量和已有 `.env` 配置规则，仅在启动时读取；独立缓存客户端、workspace、models 和 runtime check 的 Redis 客户端也使用同一个名称配置。

Set `REDIS_RESOURCE_NAME` and `MYSQL_RESOURCE_NAME` to name the shared Redis
and MySQL services. Both default to `backend` when unset or blank. Values follow
the existing process-environment / `.env` configuration rules and are read only
during startup. All Redis startup clients, including independent caches, workspace, models and
runtime checks, use the same configured name.

Resource labels separate the business `name` from the configured `endpoint`.
All Redis startup clients default to `name="backend"` and read
`REDIS_RESOURCE_NAME`; their endpoints and access labels distinguish resources.
Redis preserves DNS hostnames in `endpoint="host:port"`. Request `access` is
`read` or `write`, independent of connection `role`. Reads falling back to the
master remain reads, and mixed pipelines count each command's direction.
MySQL uses `access="other"` for whole transactions and exports no connection
counts. Aggregate directions with `sum by (type, name) (rate(brz_req_total[1m]))`;
retain `endpoint` or `access` in the grouping to inspect servers or directions.

资源初始化或拓扑重建时注册指标，请求记录使用缓存句柄、计时和原子操作，不拼接标签或查注册表。计时 slot 保持 64 字节，标量 slot 保持 8 字节。SDK 的协议编码和缓冲区仍可能分配内存。

Handles are registered during resource construction or topology rebuilding.
Metric updates use cached Copy handles, clocks and atomics without label
allocation or registry lookup, including the first update. Timing slots remain
64 bytes and scalar slots 8 bytes. Protocol encoding and buffering may still
allocate independently of metric recording.

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

The loopback listener exports explicit per-response CORS decisions, and only
its matched `OriginService` trusts them. `FastApiError::unhandled()` bypasses
CORS to match FastAPI's outer exception handler; ordinary business errors,
including other 500 responses, retain the public CORS policy. The gateway
consumes the internal metadata before public delivery. Python fallback origins
cannot choose this policy through response metadata.

## 网关测试依赖

知识接口回迁测试通过真实本地 Python HTTP 上游验证网关转发，并检查正常结束和启动超时后的进程清理。运行这些常规 Cargo 测试前，需要安装 `uv`、Python 3.11 或符合 Backend 项目要求的 Python，并准备 Backend 虚拟环境：

```bash
# Run from the repository root; an existing Backend environment can be reused.
uv venv --python 3.11 backend/.venv
cd backend-rs
cargo test --locked --test knowledge_python_rollback
```

测试上游只使用 Python 标准库；不需要安装 Backend 业务依赖，不连接生产服务。测试通过 `uv run --no-sync --offline` 启动上游，因此环境应在测试前准备好。Rust CI 使用现有 Python/uv 安装 action 创建该环境。上述命令属于本地网关集成测试，不是产品 E2E 或 `ai:verify`。
