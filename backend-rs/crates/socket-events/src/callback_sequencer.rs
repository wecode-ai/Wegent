// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Per-session ordering for `runtime:rpc` ACK -> callback publishes.
//!
//! The Source completes `sio.call` on the event loop, so the callback
//! (`{"method": "callback", ...}`) is published in the order the device
//! acknowledges each call. The migrated RPC pool forwards calls concurrently
//! across [`super::runtime::RPC_WORKER_COUNT`] workers, so a completion that
//! arrives first could overtake a lower id that is still in flight.
//!
//! Ordering is bounded by the calls this process actually registered as
//! in-flight, never by guessing a missing integer. A series is identified by
//! `(host_id, namespace, sid)`: the sender identity plus the Socket.IO session.
//! Two senders (different `host_id`, or the same sid under a different
//! namespace) can legitimately issue their own `id = 1` to the same device, so
//! they must never share a buffer slot.
//!
//! Fallback: when a completion's callback id was not registered locally (for
//! example a call issued by another process), it publishes on arrival. Ordering
//! only holds behind an earlier id that is provably registered in this process
//! and still awaiting its own acknowledgement deadline. Correctness (no lost
//! callback, no cross-host overwrite) comes before reconstructed order.
//!
//! This module only orders the publishes. The downlink `runtime:rpc` calls and
//! their acknowledgement waits stay concurrent: [`CallbackSequencer::submit`]
//! is a non-blocking channel send, and each series drains on its own task.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};

/// The publish future returned by a [`PublishSink`].
pub type PublishFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Publishes one ordered callback. Production writes it to the Redis adapter.
pub type PublishSink = Arc<dyn Fn(SequencedCallback) -> PublishFuture + Send + Sync>;

/// One completed `runtime:rpc` acknowledgement awaiting its publish turn.
#[derive(Clone, Debug)]
pub struct SequencedCallback {
    pub host_id: String,
    pub room: String,
    pub namespace: String,
    pub id: u64,
    pub ack: Value,
}

/// The sender identity plus the Socket.IO session a callback belongs to.
///
/// Callback ids are per-socket counters, so the numeric id alone is not an
/// identity: two Source workers may each send their own `id = 1` to the same
/// device, and the sid alone cannot separate different namespaces either.
pub type SeriesKey = (String, String, String);

/// Idle time after which a finished series task removes its entry.
const SERIES_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// The per-process registry of callbacks this process issued and still awaits.
///
/// [`super::runtime::SocketIoRpc::begin`] allocates the callback id; its caller
/// registers the identity and budget here before the `runtime:rpc` emit is
/// published. The sequencer consults it to decide whether a lower id is worth
/// waiting for: only a registered, unexpired earlier call holds a later
/// completion, and only until that call's own acknowledgement deadline.
#[derive(Default)]
pub struct InFlightRegistry {
    entries: Mutex<HashMap<SeriesKey, BTreeMap<u64, Instant>>>,
}

impl InFlightRegistry {
    /// A shared, empty registry.
    #[must_use]
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Records one call this process issued and still awaits until `deadline`.
    pub fn register(&self, host_id: &str, namespace: &str, sid: &str, id: u64, deadline: Instant) {
        let key: SeriesKey = (host_id.to_owned(), namespace.to_owned(), sid.to_owned());
        if let Ok(mut entries) = self.entries.lock() {
            entries.entry(key).or_default().insert(id, deadline);
        }
    }

    /// Marks one registered call as acknowledged: its callback reached the
    /// sequencer, so it no longer holds anything behind it.
    pub fn resolve(&self, host_id: &str, namespace: &str, sid: &str, id: u64) {
        let key: SeriesKey = (host_id.to_owned(), namespace.to_owned(), sid.to_owned());
        if let Ok(mut entries) = self.entries.lock()
            && let Some(registered) = entries.get_mut(&key)
        {
            registered.remove(&id);
            if registered.is_empty() {
                entries.remove(&key);
            }
        }
    }

    /// Whether one call this process accepted is still awaiting its own
    /// acknowledgement.
    pub fn pending(&self, host_id: &str, namespace: &str, sid: &str, id: u64) -> bool {
        let key: SeriesKey = (host_id.to_owned(), namespace.to_owned(), sid.to_owned());
        self.entries
            .lock()
            .ok()
            .and_then(|entries| {
                entries
                    .get(&key)
                    .map(|registered| registered.contains_key(&id))
            })
            .unwrap_or(false)
    }

    /// The nearest unexpired deadline among registered ids below `id`, if any.
    ///
    /// Expired entries are pruned: a call past its own acknowledgement budget
    /// no longer justifies holding anything behind it.
    fn outstanding_before(&self, key: &SeriesKey, id: u64) -> Option<Instant> {
        let now = Instant::now();
        let mut entries = self.entries.lock().ok()?;
        let registered = entries.get_mut(key)?;
        registered.retain(|_, deadline| *deadline > now);
        if registered.is_empty() {
            entries.remove(key);
            return None;
        }
        registered.range(..id).map(|(_, deadline)| *deadline).min()
    }
}

type SeriesSenders = Arc<Mutex<HashMap<SeriesKey, mpsc::UnboundedSender<SequencedCallback>>>>;

/// One process-owned sequencer shared by every RPC worker.
pub struct CallbackSequencer {
    series: SeriesSenders,
    sink: PublishSink,
    registry: Arc<InFlightRegistry>,
    idle_timeout: Duration,
}

impl CallbackSequencer {
    /// Publish independent requests without waiting for a different request's ACK.
    pub async fn publish_unordered(&self, callback: SequencedCallback) {
        (self.sink)(callback).await;
    }

    /// Builds the production sequencer over this process's in-flight calls.
    #[must_use]
    pub fn new(sink: PublishSink, registry: Arc<InFlightRegistry>) -> Arc<Self> {
        Self::with_idle_timeout(sink, registry, SERIES_IDLE_TIMEOUT)
    }

    /// Builds a sequencer with an explicit idle timeout (tests use short ones).
    #[must_use]
    pub fn with_idle_timeout(
        sink: PublishSink,
        registry: Arc<InFlightRegistry>,
        idle_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            series: Arc::new(Mutex::new(HashMap::new())),
            sink,
            registry,
            idle_timeout,
        })
    }

    /// Hands one completed callback to its series. Never blocks the caller:
    /// the series task publishes asynchronously.
    pub fn submit(&self, callback: SequencedCallback) {
        let key: SeriesKey = (
            callback.host_id.clone(),
            callback.namespace.clone(),
            callback.room.clone(),
        );
        // The acknowledgement is resolved by the series task only after it
        // buffered this callback. Resolving here instead would let a later
        // buffered id observe the earlier id as free during the window before
        // this callback reaches the channel, and publish out of order.
        let mut series = self.series.lock().expect("callback sequencer series");
        let sender = series.entry(key.clone()).or_insert_with(|| {
            let (sender, receiver) = mpsc::unbounded_channel();
            tokio::spawn(run_series(
                receiver,
                Arc::clone(&self.sink),
                Arc::clone(&self.registry),
                self.idle_timeout,
                key,
                Arc::clone(&self.series),
            ));
            sender
        });
        if sender.send(callback).is_err() {
            tracing::warn!("callback sequencer series closed; the callback is dropped");
        }
    }
}

/// One series' ordered publisher.
///
/// The buffer is keyed by callback id inside `(host_id, namespace, sid)`, so
/// distinct senders never overwrite each other's callbacks.
async fn run_series(
    mut receiver: mpsc::UnboundedReceiver<SequencedCallback>,
    sink: PublishSink,
    registry: Arc<InFlightRegistry>,
    idle_timeout: Duration,
    key: SeriesKey,
    series: SeriesSenders,
) {
    let mut buffered: BTreeMap<u64, SequencedCallback> = BTreeMap::new();
    let mut idle_deadline: Option<Instant> = None;

    loop {
        tokio::select! {
            biased;
            received = receiver.recv() => {
                match received {
                    Some(callback) => {
                        idle_deadline = None;
                        let id = callback.id;
                        buffered.insert(id, callback);
                        resolve_received(&registry, &key, id);
                    }
                    None => {
                        drain_ascending(&mut buffered, &sink, &registry, &key).await;
                        break;
                    }
                }
            }
            _ = sleep_until(idle_deadline.unwrap_or_else(Instant::now)), if idle_deadline.is_some() => {
                idle_deadline = None;
                if buffered.is_empty()
                    && let Ok(mut series) = series.lock()
                    && receiver.is_empty()
                {
                    // Submitters hold the same lock while sending. Remove
                    // this sender before its receiver exits.
                    receiver.close();
                    series.remove(&key);
                    break;
                }
            }
        }

        // Publish everything whose order is already proven: the lowest buffered
        // callback leaves immediately unless this process registered an earlier
        // id for the same series whose own acknowledgement deadline has not
        // expired. An unregistered gap never blocks.
        while let Some((&id, _)) = buffered.first_key_value() {
            match registry.outstanding_before(&key, id) {
                Some(deadline) => {
                    // Hold behind the registered earlier call, but never past
                    // that call's own budget.
                    tokio::select! {
                        biased;
                        _ = sleep_until(deadline) => {}
                        received = receiver.recv() => {
                            match received {
                                Some(callback) => {
                                    idle_deadline = None;
                                    let id = callback.id;
                                    buffered.insert(id, callback);
                                    resolve_received(&registry, &key, id);
                                }
                                None => {
                                    drain_ascending(&mut buffered, &sink, &registry, &key).await;
                                    return;
                                }
                            }
                        }
                    }
                }
                None => {
                    let callback = buffered.remove(&id).expect("buffer holds the lowest id");
                    sink(callback).await;
                }
            }
        }
        if buffered.is_empty() {
            idle_deadline = Some(Instant::now() + idle_timeout);
        }
    }
}

/// Marks one already buffered acknowledgement as received. The registry is
/// updated only from inside the series task, so the buffer always holds the
/// callback before a later id stops waiting for it.
fn resolve_received(registry: &InFlightRegistry, key: &SeriesKey, id: u64) {
    registry.resolve(&key.0, &key.1, &key.2, id);
}

/// Publishes every buffered callback in ascending id order.
async fn drain_ascending(
    buffered: &mut BTreeMap<u64, SequencedCallback>,
    sink: &PublishSink,
    registry: &InFlightRegistry,
    key: &SeriesKey,
) {
    while let Some((id, callback)) = buffered.pop_first() {
        resolve_received(registry, key, id);
        sink(callback).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::Mutex as AsyncMutex;
    use tokio::time::timeout;

    type Recorder = Arc<AsyncMutex<Vec<(String, String, u64)>>>;

    fn sink(recorder: Recorder) -> PublishSink {
        Arc::new(move |callback: SequencedCallback| {
            let recorder = Arc::clone(&recorder);
            Box::pin(async move {
                recorder
                    .lock()
                    .await
                    .push((callback.host_id, callback.room, callback.id));
            })
        })
    }

    fn callback(host: &str, namespace: &str, sid: &str, id: u64) -> SequencedCallback {
        SequencedCallback {
            host_id: host.into(),
            room: sid.into(),
            namespace: namespace.into(),
            id,
            ack: json!({"success": true, "workspaces": []}),
        }
    }

    fn sequencer(recorder: Recorder) -> (Arc<CallbackSequencer>, Arc<InFlightRegistry>) {
        let registry = InFlightRegistry::shared();
        let sequencer = CallbackSequencer::with_idle_timeout(
            sink(recorder),
            Arc::clone(&registry),
            Duration::from_secs(1),
        );
        (sequencer, registry)
    }

    async fn wait_for(recorder: &Recorder, expected: usize) {
        timeout(Duration::from_secs(2), async {
            loop {
                if recorder.lock().await.len() >= expected {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("callbacks published in time");
    }

    fn series_of(seen: &[(String, String, u64)], sid: &str) -> Vec<u64> {
        seen.iter()
            .filter(|(_, room, _)| room == sid)
            .map(|(_, _, id)| *id)
            .collect()
    }

    #[tokio::test]
    async fn an_idle_series_can_publish_again_on_the_same_socket() {
        let recorder: Recorder = Arc::default();
        let sequencer = CallbackSequencer::with_idle_timeout(
            sink(Arc::clone(&recorder)),
            InFlightRegistry::shared(),
            Duration::from_millis(20),
        );
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 1));
        wait_for(&recorder, 1).await;
        timeout(Duration::from_secs(2), async {
            while !sequencer.series.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the idle series removes its sender");
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 2));
        wait_for(&recorder, 2).await;
        assert_eq!(series_of(&recorder.lock().await, "sid-1"), vec![1, 2]);
    }

    #[tokio::test]
    async fn an_unregistered_id_publishes_immediately() {
        let recorder: Recorder = Arc::default();
        let (sequencer, _) = sequencer(Arc::clone(&recorder));
        // No in-flight registration: id 2 arrives alone and must not wait for
        // a missing id 1.
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 2));
        wait_for(&recorder, 1).await;
        assert_eq!(series_of(&recorder.lock().await.clone(), "sid-1"), vec![2]);
    }

    #[tokio::test]
    async fn a_registered_earlier_id_holds_the_publish_until_it_resolves() {
        let recorder: Recorder = Arc::default();
        let (sequencer, registry) = sequencer(Arc::clone(&recorder));
        registry.register(
            "host-a",
            "/local-executor",
            "sid-1",
            1,
            Instant::now() + Duration::from_secs(5),
        );
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 2));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(
            recorder.lock().await.is_empty(),
            "id 2 waits behind the registered id 1"
        );
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 1));
        wait_for(&recorder, 2).await;
        assert_eq!(
            series_of(&recorder.lock().await.clone(), "sid-1"),
            vec![1, 2]
        );
    }

    /// The recorded reversal (`06040002` `b02e8ec6`): the device answered the
    /// accepted call `17` before `18`, but the two workers' completions resumed
    /// out of order. Registering the accepted call at admission makes `18`
    /// wait for `17`'s own acknowledgement, so the publishes keep the source's
    /// `workspaces` then `error` order.
    #[tokio::test]
    async fn an_accepted_remote_call_holds_a_later_acknowledgement() {
        let recorder: Recorder = Arc::default();
        let (sequencer, registry) = sequencer(Arc::clone(&recorder));
        registry.register(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            17,
            Instant::now() + Duration::from_secs(5),
        );
        sequencer.submit(callback(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            18,
        ));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(
            recorder.lock().await.is_empty(),
            "18 must not overtake the accepted earlier call"
        );
        assert!(registry.pending("remote-host", "/local-executor", "sid-runtime", 17));
        sequencer.submit(callback(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            17,
        ));
        wait_for(&recorder, 2).await;
        assert_eq!(
            series_of(&recorder.lock().await.clone(), "sid-runtime"),
            vec![17, 18]
        );
        assert!(!registry.pending("remote-host", "/local-executor", "sid-runtime", 17));
    }

    /// `submit` hands the acknowledgement to its series before resolving the
    /// registry entry. Resolving first let an already buffered later id race
    /// the earlier callback into the channel and publish out of order, so the
    /// ack may arrive after the later completion in the same instant.
    #[tokio::test]
    async fn a_later_ack_submitted_after_an_earlier_completion_stays_ordered() {
        let recorder: Recorder = Arc::default();
        let (sequencer, registry) = sequencer(Arc::clone(&recorder));
        registry.register(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            17,
            Instant::now() + Duration::from_secs(5),
        );
        // 18 completes first and is buffered; 17 arrives immediately after.
        sequencer.submit(callback(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            18,
        ));
        sequencer.submit(callback(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            17,
        ));
        wait_for(&recorder, 2).await;
        assert_eq!(
            series_of(&recorder.lock().await.clone(), "sid-runtime"),
            vec![17, 18]
        );
    }

    /// A gap is never guessed: with only `19` accepted, `20` publishes on
    /// arrival instead of waiting for an unknown id in between.
    #[tokio::test]
    async fn an_unregistered_gap_never_holds_a_later_acknowledgement() {
        let recorder: Recorder = Arc::default();
        let (sequencer, registry) = sequencer(Arc::clone(&recorder));
        registry.register(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            19,
            Instant::now() + Duration::from_secs(5),
        );
        sequencer.submit(callback(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            20,
        ));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(
            recorder.lock().await.is_empty(),
            "20 waits for the accepted 19"
        );
        sequencer.submit(callback(
            "remote-host",
            "/local-executor",
            "sid-runtime",
            19,
        ));
        wait_for(&recorder, 2).await;
        assert_eq!(
            series_of(&recorder.lock().await.clone(), "sid-runtime"),
            vec![19, 20]
        );
    }

    #[tokio::test]
    async fn a_registered_earlier_id_times_out_and_the_rest_publish_in_order() {
        let recorder: Recorder = Arc::default();
        let (sequencer, registry) = sequencer(Arc::clone(&recorder));
        // The registered id 1 never acknowledges; its own budget is short.
        registry.register(
            "host-a",
            "/local-executor",
            "sid-1",
            1,
            Instant::now() + Duration::from_millis(40),
        );
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 2));
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 3));
        wait_for(&recorder, 2).await;
        assert_eq!(
            series_of(&recorder.lock().await.clone(), "sid-1"),
            vec![2, 3]
        );
    }

    #[tokio::test]
    async fn two_hosts_with_the_same_id_both_publish() {
        let recorder: Recorder = Arc::default();
        let (sequencer, registry) = sequencer(Arc::clone(&recorder));
        registry.register(
            "host-a",
            "/local-executor",
            "sid-1",
            1,
            Instant::now() + Duration::from_secs(5),
        );
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 1));
        // A different sender's own id 1 must not overwrite host A's callback.
        sequencer.submit(callback("host-b", "/local-executor", "sid-1", 1));
        wait_for(&recorder, 2).await;
        let seen = recorder.lock().await.clone();
        let hosts: Vec<&str> = seen.iter().map(|(host, _, _)| host.as_str()).collect();
        assert_eq!(hosts, vec!["host-a", "host-b"]);
    }

    #[tokio::test]
    async fn two_namespaces_with_the_same_id_both_publish() {
        let recorder: Recorder = Arc::default();
        let (sequencer, registry) = sequencer(Arc::clone(&recorder));
        registry.register(
            "host-a",
            "/local-executor",
            "sid-1",
            1,
            Instant::now() + Duration::from_secs(5),
        );
        sequencer.submit(callback("host-a", "/local-executor", "sid-1", 1));
        sequencer.submit(callback("host-a", "/wework-runtime", "sid-1", 1));
        wait_for(&recorder, 2).await;
        let seen = recorder.lock().await.clone();
        assert_eq!(seen.len(), 2, "both namespaces published their own id 1");
    }

    #[tokio::test]
    async fn different_series_are_independent_and_concurrent() {
        let recorder: Recorder = Arc::default();
        let (sequencer, registry) = sequencer(Arc::clone(&recorder));
        // Series A holds id 2 behind a registered, slow id 1.
        registry.register(
            "host-a",
            "/local-executor",
            "sid-a",
            1,
            Instant::now() + Duration::from_millis(150),
        );
        sequencer.submit(callback("host-a", "/local-executor", "sid-a", 2));
        // Series B publishes without waiting for series A.
        sequencer.submit(callback("host-a", "/local-executor", "sid-b", 1));
        sequencer.submit(callback("host-a", "/local-executor", "sid-b", 2));
        wait_for(&recorder, 2).await;
        let seen = recorder.lock().await.clone();
        assert_eq!(series_of(&seen, "sid-b"), vec![1, 2]);
        assert!(series_of(&seen, "sid-a").is_empty());
        wait_for(&recorder, 3).await;
        assert_eq!(series_of(&recorder.lock().await.clone(), "sid-a"), vec![2]);
    }
}
