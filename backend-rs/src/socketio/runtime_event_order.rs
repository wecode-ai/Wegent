// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Arrival-order serialisation for `/local-executor` event streams.
//!
//! Source: `app/api/ws/device_namespace.py::_get_runtime_event_lock`. Python
//! dispatches every inbound event on the same event loop and awaits
//! `_forward_runtime_event` under one per-session lock, so a session's frames
//! forward in receive order.
//!
//! The Rust transport spawns each inbound frame independently. `brz-socket-io`
//! 0.0.4 generates a closure whose synchronous section only clones state and
//! returns an `async move` future; `brz-socketioxide` 0.18.7-brz.1
//! (`src/handler/message.rs`, the `impl_async_handler!` expansion) then runs
//! `let fut = (self.clone())(extractors...); tokio::spawn(fut);`. The spawned
//! futures start in runtime order, not receive order, so an async mutex taken
//! inside the future serialises bodies in an arbitrary order. The closure's
//! synchronous section is the only point that still observes frames in arrival
//! order: the per-connection Engine.IO read loop (`src/transport/ws.rs` and
//! `src/transport/polling.rs`) calls `on_message` inline, one packet at a time.
//!
//! [`RuntimeEventOrder::enter`] therefore takes this frame's position
//! synchronously at that receive point, before the future is spawned. Each
//! stream has one FIFO: the frame at its head forwards immediately, and every
//! later frame waits for its turn. The FIFO position *is* the sequence; no
//! number is assigned and no payload field is read or sorted.
//!
//! Cancellation never releases a successor early. A waiting frame that is
//! cancelled marks its ticket `CANCELLED`, and the holder's release skips it;
//! the next live frame is granted only by a release, which happens strictly
//! after the holder finished forwarding. A frame cancelled after it was granted
//! (a grant is only produced by a release, so its predecessor already
//! finished) hands the turn to the next frame while unwinding. Only the frame
//! that holds the turn ever advances the queue.
//!
//! The map holds one queue per stream with a frame in flight and removes it
//! when the stream drains. Only frames waiting for their turn allocate tickets.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

/// The ticket has a place in the FIFO and no frame owns the turn.
const WAITING: u8 = 0;
/// The turn was handed to this ticket; its frame may forward.
const GRANTED: u8 = 1;
/// The frame was cancelled while waiting; its release skips it.
const CANCELLED: u8 = 2;

type Queues<K> = Arc<Mutex<HashMap<K, StreamQueue>>>;

/// Receive-order positions keyed by session for Runtime events and by subtask
/// for Responses API events.
pub struct RuntimeEventOrder<K = Arc<str>> {
    queues: Queues<K>,
}

#[derive(Default)]
struct StreamQueue {
    /// One frame of this stream is forwarding (or was granted the turn).
    held: bool,
    /// Arrival-ordered frames waiting for the turn.
    waiting: VecDeque<Arc<Ticket>>,
}

struct Ticket {
    state: AtomicU8,
    wake: Notify,
}

impl Ticket {
    fn waiting() -> Self {
        Self {
            state: AtomicU8::new(WAITING),
            wake: Notify::new(),
        }
    }
}

/// This frame's position in its stream's arrival order.
///
/// Obtained from [`RuntimeEventOrder::enter`] at the receive point. Await
/// [`Turn::wait`] once before forwarding. The turn is released when this value
/// is dropped, on every path: normal completion, cancellation, or panic.
#[must_use = "the frame must wait for its arrival position before forwarding"]
pub struct Turn<K: Eq + Hash = Arc<str>> {
    key: K,
    /// `None` when this frame took the turn synchronously.
    ticket: Option<Arc<Ticket>>,
    queues: Queues<K>,
}

impl<K> Default for RuntimeEventOrder<K> {
    fn default() -> Self {
        Self {
            queues: Arc::default(),
        }
    }
}

impl<K: Clone + Eq + Hash> RuntimeEventOrder<K> {
    /// Takes this frame's position synchronously at the connection's receive
    /// point. Must run in the handler closure's synchronous section, before
    /// the transport spawns this frame's future.
    pub fn enter(&self, key: &K) -> Turn<K> {
        let mut queues = self.queues.lock().expect("runtime event order");
        let queue = queues.entry(key.clone()).or_default();
        let ticket = if queue.held {
            let ticket = Arc::new(Ticket::waiting());
            queue.waiting.push_back(Arc::clone(&ticket));
            Some(ticket)
        } else {
            queue.held = true;
            None
        };
        Turn {
            key: key.clone(),
            ticket,
            queues: Arc::clone(&self.queues),
        }
    }

    /// Streams that still have frames in flight. Test-only observability for
    /// the map bound.
    #[cfg(test)]
    fn tracked_sessions(&self) -> usize {
        self.queues.lock().expect("runtime event order").len()
    }
}

impl<K: Eq + Hash> Turn<K> {
    /// Waits until this frame is granted the stream's turn. Immediate when
    /// this frame took the turn synchronously.
    ///
    /// Call once: each call waits for another grant.
    pub async fn wait(&self) {
        if let Some(ticket) = &self.ticket {
            ticket.wake.notified().await;
        }
    }

    /// Hands the turn to the next live waiting frame, or frees the stream.
    ///
    /// Only the frame that owns the turn calls this. Cancelled tickets are
    /// skipped, so a cancelled waiter can never be the frame that advances the
    /// queue.
    fn release(&self) {
        let mut queues = self.queues.lock().expect("runtime event order");
        let Some(queue) = queues.get_mut(&self.key) else {
            return;
        };
        loop {
            let Some(ticket) = queue.waiting.pop_front() else {
                queue.held = false;
                break;
            };
            // A ticket cancelled while waiting loses this race and is skipped;
            // its frame never forwarded, so no successor was released early.
            if ticket
                .state
                .compare_exchange(WAITING, GRANTED, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                ticket.wake.notify_one();
                return;
            }
        }
        // The queue drained: drop the stream so the map stays bounded.
        queues.remove(&self.key);
    }
}

impl<K: Eq + Hash> Drop for Turn<K> {
    fn drop(&mut self) {
        if let Some(ticket) = &self.ticket
            && ticket
                .state
                .compare_exchange(WAITING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            // Still queued: the holder's release skips this ticket. This
            // frame never forwarded, so nothing may start before its
            // predecessor finishes.
            return;
        }
        // This frame held the turn, or the grant won the cancellation race.
        // Grants are only produced by a release, so the predecessor already
        // finished; passing the turn on cannot overtake it.
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn session(sid: &str) -> Arc<str> {
        Arc::from(sid)
    }

    fn record(log: &Mutex<Vec<&'static str>>, label: &'static str) {
        log.lock().expect("forward log").push(label);
    }

    #[tokio::test]
    async fn one_session_forwards_in_arrival_order_when_the_first_is_slow() {
        let order = RuntimeEventOrder::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        // Arrival order is `first` then `second`. The transport spawns each
        // frame's future independently, so start the later frame's future
        // first to model the reordering the removed per-handler lock allowed.
        let first = order.enter(&session("sid"));
        let second = order.enter(&session("sid"));
        let later = tokio::spawn({
            let log = Arc::clone(&log);
            async move {
                second.wait().await;
                record(&log, "second");
            }
        });
        tokio::task::yield_now().await;
        let earlier = tokio::spawn({
            let log = Arc::clone(&log);
            async move {
                first.wait().await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                record(&log, "first");
            }
        });
        earlier.await.expect("the first frame forwards");
        later.await.expect("the second frame forwards");
        assert_eq!(*log.lock().expect("forward log"), ["first", "second"]);
    }

    #[tokio::test]
    async fn different_sessions_forward_concurrently() {
        let order = RuntimeEventOrder::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let slow = order.enter(&session("slow"));
        let fast = order.enter(&session("fast"));
        let slow_task = tokio::spawn({
            let log = Arc::clone(&log);
            async move {
                slow.wait().await;
                tokio::time::sleep(Duration::from_millis(100)).await;
                record(&log, "slow");
            }
        });
        let fast_task = tokio::spawn({
            let log = Arc::clone(&log);
            async move {
                fast.wait().await;
                record(&log, "fast");
            }
        });
        fast_task.await.expect("the other session's frame forwards");
        // The other session finished while this one is still forwarding: a
        // session's FIFO never serialises another session.
        assert_eq!(*log.lock().expect("forward log"), ["fast"]);
        slow_task.await.expect("the slow frame forwards");
        assert_eq!(*log.lock().expect("forward log"), ["fast", "slow"]);
    }

    #[tokio::test]
    async fn cancelling_a_waiting_frame_keeps_the_predecessor_barrier() {
        let order = RuntimeEventOrder::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let release_active = Arc::new(Notify::new());
        // A is forwarding; B and C are queued behind it in arrival order.
        let active = order.enter(&session("sid"));
        let second = order.enter(&session("sid"));
        let third = order.enter(&session("sid"));
        let active_task = tokio::spawn({
            let log = Arc::clone(&log);
            let release_active = Arc::clone(&release_active);
            async move {
                active.wait().await;
                release_active.notified().await;
                record(&log, "active");
            }
        });
        let second_task = tokio::spawn({
            let log = Arc::clone(&log);
            async move {
                second.wait().await;
                record(&log, "second");
            }
        });
        tokio::task::yield_now().await;
        // Cancel B before A finishes. C must still wait for A, not run next to
        // it.
        second_task.abort();
        assert!(
            second_task
                .await
                .expect_err("B is cancelled")
                .is_cancelled()
        );
        let third_task = tokio::spawn({
            let log = Arc::clone(&log);
            async move {
                third.wait().await;
                record(&log, "third");
            }
        });
        tokio::task::yield_now().await;
        assert!(
            log.lock().expect("forward log").is_empty(),
            "no queued frame forwards while the active frame is still running"
        );
        release_active.notify_one();
        active_task.await.expect("A forwards");
        third_task.await.expect("C forwards");
        assert_eq!(*log.lock().expect("forward log"), ["active", "third"]);
    }

    #[tokio::test]
    async fn cancelling_the_tail_does_not_expose_a_new_head() {
        let order = RuntimeEventOrder::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let release_active = Arc::new(Notify::new());
        let active = order.enter(&session("sid"));
        let tail = order.enter(&session("sid"));
        let active_task = tokio::spawn({
            let log = Arc::clone(&log);
            let release_active = Arc::clone(&release_active);
            async move {
                active.wait().await;
                release_active.notified().await;
                record(&log, "active");
            }
        });
        let tail_task = tokio::spawn(async move {
            tail.wait().await;
        });
        tokio::task::yield_now().await;
        // Cancel the waiting tail. The session must stay owned until A
        // finishes; a newly arriving frame cannot become the head.
        tail_task.abort();
        assert!(
            tail_task
                .await
                .expect_err("the tail is cancelled")
                .is_cancelled()
        );
        assert_eq!(
            order.tracked_sessions(),
            1,
            "a cancelled tail keeps the session"
        );
        let newcomer = order.enter(&session("sid"));
        let newcomer_task = tokio::spawn({
            let log = Arc::clone(&log);
            async move {
                newcomer.wait().await;
                record(&log, "newcomer");
            }
        });
        tokio::task::yield_now().await;
        assert!(
            log.lock().expect("forward log").is_empty(),
            "the new frame waits for the active frame"
        );
        release_active.notify_one();
        active_task.await.expect("A forwards");
        newcomer_task.await.expect("the new frame forwards");
        assert_eq!(*log.lock().expect("forward log"), ["active", "newcomer"]);
    }

    #[tokio::test]
    async fn an_early_failing_frame_does_not_bypass_the_predecessor() {
        let order = RuntimeEventOrder::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let release_active = Arc::new(Notify::new());
        // A forwards. B then fails its payload/session checks, so its handler
        // body returns before `wait()`. C is behind B and is valid.
        let active = order.enter(&session("sid"));
        let failing = order.enter(&session("sid"));
        let valid = order.enter(&session("sid"));
        let active_task = tokio::spawn({
            let log = Arc::clone(&log);
            let release_active = Arc::clone(&release_active);
            async move {
                active.wait().await;
                release_active.notified().await;
                record(&log, "active");
            }
        });
        // The invalid frame drops its position without ever waiting: the same
        // path as an `ensure_active`, session, or payload error.
        drop(failing);
        let valid_task = tokio::spawn({
            let log = Arc::clone(&log);
            async move {
                valid.wait().await;
                record(&log, "valid");
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(
            order.tracked_sessions(),
            1,
            "a failing middle frame keeps the session active"
        );
        assert!(
            log.lock().expect("forward log").is_empty(),
            "the valid successor waits for the active frame, not the failed one"
        );
        release_active.notify_one();
        active_task.await.expect("A forwards");
        valid_task.await.expect("C forwards");
        assert_eq!(*log.lock().expect("forward log"), ["active", "valid"]);
    }

    #[tokio::test]
    async fn a_granted_frame_cancelled_before_forwarding_passes_the_turn_on() {
        let order = RuntimeEventOrder::default();
        let active = order.enter(&session("sid"));
        let granted = order.enter(&session("sid"));
        let next = order.enter(&session("sid"));
        // A releases its turn, granting B; B is then dropped without running.
        drop(active);
        drop(granted);
        tokio::time::timeout(Duration::from_secs(1), next.wait())
            .await
            .expect("the next frame proceeds after the granted one is dropped");
    }

    #[tokio::test]
    async fn a_panicking_frame_still_releases_the_next_position() {
        let order = RuntimeEventOrder::default();
        let first = order.enter(&session("sid"));
        let second = order.enter(&session("sid"));
        let panicked = tokio::spawn(async move {
            first.wait().await;
            panic!("forward failed");
        });
        assert!(panicked.await.is_err(), "the first forward panicked");
        tokio::time::timeout(Duration::from_secs(1), second.wait())
            .await
            .expect("the successor proceeds after the predecessor unwinds");
    }

    #[tokio::test]
    async fn a_drained_session_removes_its_entry() {
        let order = RuntimeEventOrder::default();
        let turn = order.enter(&session("sid"));
        assert_eq!(order.tracked_sessions(), 1);
        turn.wait().await;
        drop(turn);
        assert_eq!(order.tracked_sessions(), 0);
    }
}
