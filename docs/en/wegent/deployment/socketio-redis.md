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

These settings apply only to the Backend Socket.IO Redis manager. They do not change
cache or Celery connection settings. Restart Backend instances after changing them.

## Timeouts and resubscription

A TCP connection can remain ESTABLISHED while Redis stops sending data. A finite
read timeout allows the existing client retry and resubscription paths to run.
This also covers a connection that stops after delivering only part of a message,
so the listener cannot wait indefinitely for the remaining bytes.

Health checks run before client commands or reads, rather than on a background
timer. A completely idle subscription can therefore reach its read timeout and
automatically resubscribe. Persistent failures use Socket.IO's existing retry backoff.
Once resubscribed, the listener can receive new messages. Redis Pub/Sub does not replay
messages missed during disconnection, so operations that already timed out must be retried.

## Verify recovery

Call the read-only `runtime.capacity.get` from a Backend instance other than the
device's WebSocket owner and confirm the RPC acknowledgement arrives. Also check
device commands and live updates after subscription recovery.

A healthy `device:online` heartbeat and TTL, a Running Pod, or a successful call
within the owning instance alone does not establish that reception between instances recovered.
