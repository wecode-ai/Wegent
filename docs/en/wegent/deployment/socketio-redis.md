---
sidebar_position: 5
---

# Socket.IO Redis connection recovery

Backend instances use Redis Pub/Sub to relay device commands, RPC acknowledgements,
and live updates. Device WebSocket heartbeats and Redis subscriptions are separate
connections. An online device does not establish that communication between instances works.

## Connection settings

The Backend Socket.IO Redis manager enables TCP keepalive and uses the following
environment variables. Values are seconds and must be finite, positive numbers.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SOCKETIO_REDIS_SOCKET_TIMEOUT` | `30` | Bound the wait for a Redis read or write |
| `SOCKETIO_REDIS_CONNECT_TIMEOUT` | `5` | Bound the wait to establish a Redis connection |
| `SOCKETIO_REDIS_HEALTH_CHECK_INTERVAL` | `15` | Health check interval before client commands or reads |
| `SOCKETIO_REDIS_ACK_PROBE_INTERVAL_SECONDS` | `30` | Wait between completed ACK probes |

These settings apply only to the Backend Socket.IO Redis manager. They do not change
cache or Celery connection settings. Restart Backend instances after changing them.
Set `SOCKETIO_REDIS_CLIENT_NAME` to identify the manager's connections in Redis
`CLIENT LIST`.

## Timeouts and resubscription

A TCP connection can remain ESTABLISHED while Redis stops sending data. A finite
read timeout allows the existing client retry and resubscription paths to run.
This also covers a connection that stops after delivering only part of a message,
so the listener cannot wait indefinitely for the remaining bytes.

Health checks run before client commands or reads, rather than on a background
timer. Background ACK probes wait for the smaller of the configured interval and
half the read timeout, keeping healthy idle subscriptions active before they expire
and avoiding lost RPC callbacks during unnecessary resubscription. Persistent
failures use Socket.IO's existing retry backoff.
Once resubscribed, the listener can receive new messages. Redis Pub/Sub does not replay
messages missed during disconnection, so operations that already timed out must be retried.

## Verify recovery

Each Python Backend process sends a probe ACK through the Redis channel used
by Socket.IO. After three consecutive failures, `/api/shutdown/status`
returns 503. The next successful probe restores readiness. Each probe waits up
to five seconds. The configured interval defaults to 30 seconds; with the default
read timeout, the effective wait between checks is 15 seconds.

With `LOG_LEVEL=DEBUG`, correlate `publish`, `receive` and `match` using
the same `host_id`, `sid` and `callback_id`.

Call the read-only `runtime.capacity.get` from a Backend instance other than the
device's WebSocket owner and confirm the RPC acknowledgement arrives. Also check
device commands and live updates after subscription recovery.

A healthy `device:online` heartbeat and TTL, a Running Pod, or a successful call
within the owning instance alone does not establish that reception between instances recovered.
