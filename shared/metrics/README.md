# shared/metrics

Breeze-style process metrics for the Wegent Python services (`backend`,
`executor_manager`, `chat_shell`). The package mirrors the `brz-metrics`
contract used by the Rust gateway: services record into one process-wide
registry, and a background thread drains it every interval into ProfileUtil
JSON lines appended to a profile log. Python series therefore flow through the
same collection pipeline as the Rust and Java services — no new scrape target.

## Usage

```python
from shared.metrics import ApiRouteMetrics, Metric

# One inbound API route, split by HTTP status class (2xx/3xx/4xx/5xx).
route = ApiRouteMetrics("/api/v1/responses")
route.record(status_code=200, elapsed_seconds=0.012)

# A service operation (200 ms slow threshold, 10/50/100/200 ms buckets).
run = Metric.service("wecode/orphan_pod_cleanup/run")
run.record(elapsed_seconds=0.42, success=True)

# A count-only counter.
deleted = Metric.log("wecode/orphan_pod_cleanup/deleted")
deleted.increment(3)
```

The first registration starts the profile logger thread. Every interval each
metric is drained and appended as one line:

```
2026-09-20 15:00:00 {"type":"API","name":"/api/v1/responses_2xx","slowThreshold":200,"total_count":3,"error_count":0,"slow_count":0,"avg_time":"12.34","interval1":3,"interval2":0,"interval3":0,"interval4":0,"interval5":0}
```

A fixed `other://profile_baseline` sentinel closes every interval, matching the
Java/Rust writers.

The profile log rolls over on the natural clock hour like the service `info.log`
does, archiving the previous hour as `profile.log.YYYYMMDD-HH`. Rollover and
append run under an exclusive file lock so concurrent workers sharing one log
file do not corrupt each other.

## Configuration

Injected by the deployment through environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WECODE_METRICS_PROFILE_LOG_PATH` | dir of `$WEGENT_LOG_FILE_PATH`, else `$LOG_DIR/profile.log`, else `logs/profile.log` | Profile log destination |
| `WECODE_METRICS_PROFILE_INTERVAL_SECONDS` | `30` | Drain interval |
| `WECODE_METRICS_ENABLED` | `true` | Set to `false` to disable the profile logger |

## Tests

```bash
cd shared && uv run pytest tests/test_metrics.py
```
