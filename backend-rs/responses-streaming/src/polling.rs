// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::future::Future;
use std::pin::Pin;

use brz_redis::Redis;
use wegent_execution_runtime::stream_state::is_cancelled;

use crate::sse_protocol::CANCEL_POLL_INTERVAL;

/// `_wait_for_sse_cancellation`'s Redis half, driven as one future for the
/// whole dispatch.
///
/// The Source's `poll_redis` issues a GET, sleeps one full interval, then
/// issues the next GET (`chat_shell_sse.py:97-101`), so a slow read delays the
/// following poll instead of firing on a fixed grid. The loop is created before
/// the stream opens (`:235`) and cancelled in `finally` (`:533-548`); the call
/// site waits for the cancelled poller before `unregister_stream`.
///
/// `stop` halts scheduling of new reads, but it never interrupts an admitted
/// `is_cancelled` GET: dropping an already-admitted command does not recall it
/// (`brz-redis` admits the envelope before returning the response future), so
/// its bytes could reach Redis after the unregister `DEL`. The loop therefore
/// awaits every GET to completion and only races `stop` against the interval
/// sleep.
pub async fn poll_cancellation<R: Redis>(
    redis: &R,
    key: &str,
    mut stop: tokio::sync::oneshot::Receiver<()>,
) {
    loop {
        if is_cancelled(redis, key).await {
            return;
        }
        tokio::select! {
            biased;
            _ = &mut stop => return,
            _ = tokio::time::sleep(CANCEL_POLL_INTERVAL) => {}
        }
    }
}

/// Poll `future` once, returning its output when it is immediately ready.
///
/// Used to issue the poll loop's initial GET before the stream opens without
/// waiting for the read or for the next interval.
pub async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Option<F::Output> {
    tokio::select! {
        biased;
        output = &mut future => Some(output),
        _ = std::future::ready(()) => None,
    }
}
