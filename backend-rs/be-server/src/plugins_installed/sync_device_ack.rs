// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The capability-acknowledgement wait of the device sync dispatch.

use super::*;

/// `ROUTE_CHECK_INTERVAL_SECONDS`: the reconnect probe interval.
pub(super) const ROUTE_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
/// `MAX_ROUTE_CHANGES`.
pub(super) const MAX_ROUTE_CHANGES: usize = 2;

/// `_call_on_routes`: await the acknowledgement while re-reading the device's
/// online document once per second. A reconnected socket re-resolves the owned
/// route and re-publishes the same payload to the new socket; a non-plugin
/// payload, a changed Runtime instance, or an exhausted retry budget aborts the
/// dispatch (the source's `ConnectionError`, whose `str()` is the recorded
/// error text).
#[allow(clippy::too_many_arguments)]
pub(super) async fn await_acknowledgement(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    route: &OnlineRoute,
    call: crate::socketio_rpc::SocketIoCall,
    deadline: std::time::Duration,
    dispatch: &Value,
    versioned: bool,
) -> Result<Value, crate::socketio_rpc::RpcError> {
    use crate::socketio_rpc::RpcError;
    let started = std::time::Instant::now();
    let mut socket_id = route.socket_id.clone();
    let mut call = Some(call);
    for attempt in 0..=MAX_ROUTE_CHANGES {
        let remaining = deadline.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(RpcError::Timeout);
        }
        let Some(pending) = call.take() else {
            return Err(RpcError::Closed);
        };
        tokio::select! {
            acknowledged = pending.wait(remaining) => return acknowledged,
            () = poll_until_route_change(state, user_id, route, &socket_id) => {}
        }
        if !versioned || attempt == MAX_ROUTE_CHANGES {
            return Err(RpcError::Closed);
        }
        let Some(next) =
            resolve_reconnected_route(state, user_id, device_id, route, &socket_id).await
        else {
            return Err(RpcError::Closed);
        };
        if !supports_plugin_sync_v2(next.online.get("runtime_features")) {
            return Err(RpcError::Closed);
        }
        let Some(rpc) = state.socketio_rpc.as_ref() else {
            return Err(RpcError::Unavailable(
                "Socket.IO Redis adapter is unavailable".into(),
            ));
        };
        let Some(redis) = state.redis.as_ref() else {
            return Err(RpcError::Unavailable(
                "Socket.IO Redis adapter is unavailable".into(),
            ));
        };
        socket_id = next.socket_id.clone();
        let next_call = rpc
            .begin(&socket_id, SYNC_NAMESPACE)
            .map_err(|_| RpcError::Unavailable("callback registration failed".into()))?;
        let data =
            serde_json::to_string(&Value::Array(vec![dispatch.clone()])).expect("serializes");
        let message = crate::socketio_emit::emit_message_with_callback(
            SYNC_EVENT,
            &data,
            SYNC_NAMESPACE,
            &socket_id,
            Some((&socket_id, next_call.id())),
        );
        if redis
            .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
            .await
            .is_err()
        {
            return Err(RpcError::Unavailable(
                "Socket.IO Redis adapter is unavailable".into(),
            ));
        }
        call = Some(next_call);
    }
    Err(RpcError::Closed)
}

/// `_changed_route`: the source's probe loop, not a single probe.
///
/// The source's `_changed_route` is a `while True` that sleeps one interval and
/// re-reads the device's online document on every iteration, returning only
/// once a read reports a socket that differs from the dispatched one. A short
/// acknowledgement therefore observes one probe, a two-second one observes two,
/// and the loop is bounded only by the dispatch deadline — exactly as
/// `asyncio.wait_for` bounds the source's `while True`.
///
/// Each iteration issues one `GET device:online:<user>:<device>`
/// (`backend/app/services/device/capability_sync_rpc.py:23-30`).
async fn poll_until_route_change(
    state: &AppState,
    user_id: i64,
    route: &OnlineRoute,
    socket_id: &str,
) {
    loop {
        tokio::time::sleep(ROUTE_CHECK_INTERVAL).await;
        if route_changed(
            read_online_document(state, user_id, route).await.as_ref(),
            socket_id,
        ) {
            return;
        }
    }
}

/// `_changed_route`'s probe: one read of the dispatched route's online document.
async fn read_online_document(
    state: &AppState,
    user_id: i64,
    route: &OnlineRoute,
) -> Option<Value> {
    let key = format!("device:online:{user_id}:{}", route.runtime_device_id);
    crate::devices::cache_manager_get(state.redis.as_ref(), &key).await
}

/// `_changed_route`'s comparison: only a non-empty socket that differs from the
/// dispatched one reports a reconnect; every other read keeps polling.
pub(super) fn route_changed(online: Option<&Value>, socket_id: &str) -> bool {
    let reported = online
        .and_then(|document| document.get("socket_id"))
        .and_then(Value::as_str)
        .map(str::trim);
    matches!(reported, Some(reported) if !reported.is_empty() && reported != socket_id)
}

/// Re-resolve the owned route while keeping the dispatch bound to its original Runtime.
async fn resolve_reconnected_route(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    initial: &OnlineRoute,
    socket_id: &str,
) -> Option<OnlineRoute> {
    match resolve_online_route(state, user_id, device_id).await.ok()? {
        OnlineRouteResolution::Ready(next) if can_retry_on_route(initial, socket_id, &next) => {
            Some(next)
        }
        _ => None,
    }
}

fn can_retry_on_route(initial: &OnlineRoute, socket_id: &str, next: &OnlineRoute) -> bool {
    next.runtime_device_id == initial.runtime_device_id
        && next.runtime_instance_id == initial.runtime_instance_id
        && next.socket_id != socket_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_must_keep_the_initial_runtime_and_change_the_current_socket() {
        let route = |device: &str, instance: Option<&str>, socket: &str| OnlineRoute {
            runtime_device_id: device.to_owned(),
            runtime_instance_id: instance.map(str::to_owned),
            socket_id: socket.to_owned(),
            online: Value::Null,
        };
        let initial = route("device", Some("runtime"), "first");
        assert!(can_retry_on_route(
            &initial,
            "second",
            &route("device", Some("runtime"), "third")
        ));
        for next in [
            route("device", Some("runtime"), "second"),
            route("other-device", Some("runtime"), "third"),
            route("device", Some("replacement"), "third"),
            route("device", None, "third"),
        ] {
            assert!(!can_retry_on_route(&initial, "second", &next));
        }
    }
}

/// A dispatch failure that keeps the desired snapshot for result recording.
pub(super) fn snapshot_failure(
    device_id: &str,
    snapshot: &Option<Value>,
    error: &str,
) -> SyncResult {
    let mut result = SyncResult::failure(device_id, None, error);
    result.desired_plugin_snapshot = snapshot.clone();
    result
}

/// `sio.call`'s return value: the single positional ack argument.
pub(crate) fn ack_argument(args: &Value) -> &Value {
    match args {
        Value::Array(items) if items.len() == 1 => &items[0],
        other => other,
    }
}

/// `ACKNOWLEDGEMENT_TIMEOUT_TEXT`: the message of the `TimeoutError`
/// `call_capability_sync` raises when the total deadline expires
/// (`backend/app/services/device/capability_sync_rpc.py:119-124`).
pub(super) const ACKNOWLEDGEMENT_TIMEOUT_TEXT: &str =
    "Device capability sync acknowledgement timed out";

/// Python `str(exc)` for the mapped dispatch failure.
///
/// Source `sync_device_payload` catches the dispatch exception and stores
/// `str(exc)` as `result.error`, so an expired deadline reports the raised
/// `TimeoutError` message rather than an empty reason
/// (`backend/app/services/device/capability_sync_service.py:576-586`).
pub(super) fn error_text(error: &crate::socketio_rpc::RpcError) -> &'static str {
    match error {
        crate::socketio_rpc::RpcError::Timeout => ACKNOWLEDGEMENT_TIMEOUT_TEXT,
        crate::socketio_rpc::RpcError::Closed => "connection closed",
        crate::socketio_rpc::RpcError::Unavailable(_) => "Socket.IO Redis adapter is unavailable",
    }
}
