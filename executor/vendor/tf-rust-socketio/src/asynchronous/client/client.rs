use std::{
    ops::Deref,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use backoff::{backoff::Backoff, ExponentialBackoffBuilder};
use futures_util::{future::BoxFuture, stream, Stream, StreamExt};
use log::{error, trace};
use serde_json::Value;
use tf_rust_engineio::header::{HeaderMap, HeaderValue};
use tokio::{
    sync::RwLock,
    task::JoinHandle,
    time::{sleep, Duration, Instant},
};

use super::{
    ack::Ack,
    builder::ClientBuilder,
    callback::{Callback, DynAsyncCallback},
};
use crate::{
    asynchronous::socket::Socket as InnerSocket,
    error::{Error, Result},
    packet::{Packet, PacketId},
    CloseReason, Event, Payload,
};

#[derive(Default)]
enum DisconnectReason {
    /// There is no known reason for the disconnect; likely a network error
    #[default]
    Unknown,
    /// The user disconnected manually
    Manual,
    /// The server disconnected
    Server,
}

/// Settings that can be updated before reconnecting to a server
#[derive(Default)]
pub struct ReconnectSettings {
    address: Option<String>,
    auth: Option<serde_json::Value>,
    headers: Option<HeaderMap>,
}

impl ReconnectSettings {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the URL that will be used when reconnecting to the server
    pub fn address<T>(&mut self, address: T) -> &mut Self
    where
        T: Into<String>,
    {
        self.address = Some(address.into());
        self
    }

    /// Sets the authentication data that will be send in the opening request
    pub fn auth(&mut self, auth: serde_json::Value) {
        self.auth = Some(auth);
    }

    /// Adds an http header to a container that is going to completely replace opening headers on reconnect.
    /// If there are no headers set in `ReconnectSettings`, client will use headers initially set via the builder.
    pub fn opening_header<T: Into<HeaderValue>, K: Into<String>>(
        &mut self,
        key: K,
        val: T,
    ) -> &mut Self {
        self.headers
            .get_or_insert_with(HeaderMap::default)
            .insert(key.into(), val.into());
        self
    }
}

/// An in-flight per-packet dispatch task plus whether it is a terminal
/// notification (Close/Error of a dying session).
type DispatchTask = (JoinHandle<()>, bool);

/// A socket which handles communication with the server. It's initialized with
/// a specific address as well as an optional namespace to connect to. If `None`
/// is given the client will connect to the default namespace `"/"`.
#[derive(Clone)]
pub struct Client {
    /// The inner socket client to delegate the methods to.
    socket: Arc<RwLock<InnerSocket>>,
    outstanding_acks: Arc<RwLock<Vec<Ack>>>,
    // namespace, for multiplexing messages
    nsp: String,
    // Data send in the opening packet (commonly used as for auth)
    auth: Option<serde_json::Value>,
    builder: Arc<RwLock<ClientBuilder>>,
    disconnect_reason: Arc<RwLock<DisconnectReason>>,
    // Monotonically increasing session generation (issue #15): bumped once per
    // successful connect. `on_close_with_session` captures the dying session's
    // value at dispatch-spawn time, so a late Close can be attributed to the
    // session that actually died.
    session_epoch: Arc<AtomicU64>,
    // Tracks in-flight per-packet dispatch tasks (issue #12) so they can be
    // aborted on teardown. `true` marks a task as terminal: terminal tasks
    // (Close/Error notifications of a dead session) survive a stream-end
    // abort but are cut by a manual disconnect.
    dispatch_tasks: Arc<std::sync::Mutex<Vec<DispatchTask>>>,
}

impl Client {
    /// Creates a socket with a certain address to connect to as well as a
    /// namespace. If `None` is passed in as namespace, the default namespace
    /// `"/"` is taken.
    /// ```
    pub(crate) fn new(socket: InnerSocket, builder: ClientBuilder) -> Result<Self> {
        Ok(Client {
            socket: Arc::new(RwLock::new(socket)),
            nsp: builder.namespace.to_owned(),
            outstanding_acks: Arc::new(RwLock::new(Vec::new())),
            auth: builder.auth.clone(),
            builder: Arc::new(RwLock::new(builder)),
            disconnect_reason: Arc::new(RwLock::new(DisconnectReason::default())),
            session_epoch: Arc::new(AtomicU64::new(0)),
            dispatch_tasks: Arc::new(std::sync::Mutex::new(Vec::new())),
        })
    }

    /// Returns the current session epoch: the number of successfully connected
    /// sessions during this client's lifetime (starting at 1 after the initial
    /// connect, incremented by every successful reconnect). Every close
    /// delivered by [`ClientBuilder::on_close_with_session`] carries the epoch
    /// of the session whose transport actually died — which, for a close that
    /// runs late, may differ from the epoch this accessor reports here.
    ///
    /// # Example
    /// ```
    /// use tf_rust_socketio::asynchronous::ClientBuilder;
    ///
    /// #[tokio::main]
    /// async fn main() {
    ///     let socket = ClientBuilder::new("http://localhost:4200/")
    ///         .connect()
    ///         .await
    ///         .expect("connection failed");
    ///     println!("current session: {}", socket.session_epoch());
    /// }
    /// ```
    pub fn session_epoch(&self) -> u64 {
        self.session_epoch.load(Ordering::Relaxed)
    }

    /// Connects the client to a server. Afterwards the `emit_*` methods can be
    /// called to interact with the server.
    pub(crate) async fn connect(&self) -> Result<()> {
        // Connect the underlying socket
        self.socket.read().await.connect().await?;

        // construct the opening packet
        let auth = self.auth.as_ref().map(|data| data.to_string());
        let open_packet = Packet::new(PacketId::Connect, self.nsp.clone(), auth, None, 0, None);

        self.socket.read().await.send(open_packet).await?;

        // Only a successful handshake + CONNECT counts as a session (issue
        // #15); failed reconnect attempts return via `?` above without
        // bumping the epoch.
        self.session_epoch.fetch_add(1, Ordering::Relaxed);

        Ok(())
    }

    pub(crate) async fn reconnect(&mut self) -> Result<()> {
        // The user `on_reconnect` callback (auth refresh) must run outside the
        // builder lock: user code under the exclusive write lock would block
        // Close/event delivery, which only needs a shared lock (same rule as
        // issue #12). The callback is taken out, awaited lock-free, then put
        // back below. `reconnect()` is the only consumer of `on_reconnect`.
        let mut on_reconnect = {
            let mut builder = self.builder.write().await;
            builder.on_reconnect.take()
        };
        let reconnect_settings = match on_reconnect.as_mut() {
            Some(callback) => Some(callback().await),
            None => None,
        };

        // Apply refreshed settings under a short write lock, then build the
        // new transport under a shared lock so the network handshake cannot
        // stall event dispatch.
        {
            let mut builder = self.builder.write().await;
            if let Some(reconnect_settings) = reconnect_settings {
                if let Some(address) = reconnect_settings.address {
                    builder.address = address;
                }

                if let Some(auth) = reconnect_settings.auth {
                    self.auth = Some(auth);
                }

                if reconnect_settings.headers.is_some() {
                    builder.opening_headers = reconnect_settings.headers;
                }
            }
            if let Some(cb) = on_reconnect {
                builder.on_reconnect = Some(cb);
            }
        }

        let socket = self.builder.read().await.inner_create().await?;

        // New inner socket that can be connected
        let mut client_socket = self.socket.write().await;
        *client_socket = socket;

        // Now that we have replaced `self.socket`, we drop the write lock
        // because the `connect` method we call below will need to use it
        drop(client_socket);

        self.connect().await?;

        Ok(())
    }

    /// Drives the stream using a thread so messages are processed
    pub(crate) async fn poll_stream(&mut self) -> Result<()> {
        let builder = self.builder.read().await;
        let reconnect_delay_min = builder.reconnect_delay_min;
        let reconnect_delay_max = builder.reconnect_delay_max;
        let max_reconnect_attempts = builder.max_reconnect_attempts;
        let reconnect = builder.reconnect;
        let reconnect_on_disconnect = builder.reconnect_on_disconnect;
        drop(builder);

        let mut client_clone = self.clone();

        tokio::runtime::Handle::current().spawn(async move {
            loop {
                let mut stream = client_clone.as_stream().await;
                // Consume the stream until it returns None and the stream is closed.
                while let Some(item) = stream.next().await {
                    if let Err(e) = item {
                        trace!("Network error occurred: {}", e);
                    }
                }

                // Drop the stream so we can once again use `socket_clone` as mutable
                drop(stream);

                let should_reconnect = match *(client_clone.disconnect_reason.read().await) {
                    DisconnectReason::Unknown => {
                        // If we disconnected for an unknown reason, the client might not have noticed
                        // the closure yet. Hence, fire a transport close event to notify it.
                        // We don't need to do that in the other cases, since proper server close
                        // and manual client close are handled explicitly.
                        // The callback is spawned as a terminal dispatch task so a
                        // long Close handler cannot stall the reconnect decision
                        // (issue #12). The epoch is captured here, before the
                        // reconnect below can bump it, so the close is
                        // attributed to the dying session (issue #15).
                        let close_epoch = client_clone.session_epoch();
                        let close_client = client_clone.clone();
                        client_clone.spawn_dispatch(
                            async move {
                                if let Some(err) = close_client
                                    .callback_close(
                                        CloseReason::TransportClose.as_str(),
                                        close_epoch,
                                    )
                                    .await
                                    .err()
                                {
                                    error!("Error while notifying client of transport close: {err}")
                                }
                            },
                            true,
                        );

                        reconnect
                    }
                    DisconnectReason::Manual => false,
                    DisconnectReason::Server => reconnect_on_disconnect,
                };

                if should_reconnect {
                    let mut reconnect_attempts = 0;
                    let mut backoff = ExponentialBackoffBuilder::new()
                        .with_initial_interval(Duration::from_millis(reconnect_delay_min))
                        .with_max_interval(Duration::from_millis(reconnect_delay_max))
                        .build();

                    loop {
                        if let Some(max_reconnect_attempts) = max_reconnect_attempts {
                            reconnect_attempts += 1;
                            if reconnect_attempts > max_reconnect_attempts {
                                trace!("Max reconnect attempts reached without success");
                                break;
                            }
                        }
                        match client_clone.reconnect().await {
                            Ok(_) => {
                                trace!("Reconnected after {reconnect_attempts} attempts");
                                break;
                            }
                            Err(e) => {
                                trace!("Failed to reconnect: {e:?}");
                                if let Some(delay) = backoff.next_backoff() {
                                    let delay_ms = delay.as_millis();
                                    trace!("Waiting for {delay_ms}ms before reconnecting");
                                    sleep(delay).await;
                                }
                            }
                        }
                    }
                } else {
                    break;
                }
            }
        });

        Ok(())
    }

    /// Sends a message to the server using the underlying `engine.io` protocol.
    /// This message takes an event, which could either be one of the common
    /// events like "message" or "error" or a custom event like "foo". But be
    /// careful, the data string needs to be valid JSON. It's recommended to use
    /// a library like `serde_json` to serialize the data properly.
    ///
    /// # Example
    /// ```
    /// use tf_rust_socketio::{asynchronous::{ClientBuilder, Client}, Payload};
    /// use serde_json::json;
    /// use futures_util::FutureExt;
    ///
    /// #[tokio::main]
    /// async fn main() {
    ///     let mut socket = ClientBuilder::new("http://localhost:4200/")
    ///         .on("test", |payload: Payload, socket: Client| {
    ///             async move {
    ///                 println!("Received: {:#?}", payload);
    ///                 socket.emit("test", json!({"hello": true})).await.expect("Server unreachable");
    ///             }.boxed()
    ///         })
    ///         .connect()
    ///         .await
    ///         .expect("connection failed");
    ///
    ///     let json_payload = json!({"token": 123});
    ///
    ///     let result = socket.emit("foo", json_payload).await;
    ///
    ///     assert!(result.is_ok());
    /// }
    /// ```
    #[inline]
    pub async fn emit<E, D>(&self, event: E, data: D) -> Result<()>
    where
        E: Into<Event>,
        D: Into<Payload>,
    {
        self.socket
            .read()
            .await
            .emit(&self.nsp, event.into(), data.into())
            .await
    }

    /// When receive server's emitwithack callback event, invoke socket.ack(..) function can react to server with ack signal
    /// use futures_util::FutureExt;
    ///
    /// # Example
    /// ```
    /// use futures_util::FutureExt;
    /// use tf_rust_socketio::{asynchronous::{ClientBuilder, Client}, Payload};
    /// use serde_json::json;
    /// use std::time::Duration;
    /// use std::thread;
    /// use bytes::Bytes;
    ///
    /// #[tokio::main]
    /// async fn main() {
    ///
    ///     let callback = |payload: Payload, socket: Client| {
    ///        async move {
    ///           match payload {
    ///               Payload::Text(values, ack_id) => {
    ///                   println!("{:#?}", values);
    ///                   if let Some(id) = ack_id {
    ///                       let _ = socket.ack_with_id(id, json!({"status": "received"})).await;
    ///                   }
    ///               },
    ///               Payload::Binary(bytes, ack_id) => {
    ///                   println!("Received bytes: {:#?}", bytes);
    ///                   if let Some(id) = ack_id {
    ///                       let _ = socket.ack_with_id(id, vec![4, 5, 6]).await;
    ///                   }
    ///               },
    ///               Payload::String(str, ack_id) => {
    ///                   println!("{}", str);
    ///                   if let Some(id) = ack_id {
    ///                       let _ = socket.ack_with_id(id, "response").await;
    ///                   }
    ///               },
    ///           }
    ///        }.boxed()
    ///     };
    ///
    ///     // get a socket that is connected to the admin namespace
    ///     let socket = ClientBuilder::new("http://localhost:4200")
    ///         .namespace("/")
    ///         .on("foo", callback)
    ///         .on("error", |err, _| {
    ///             async move { eprintln!("Error: {:#?}", err) }.boxed()
    ///         })
    ///         .connect()
    ///         .await
    ///         .expect("Connection failed");
    ///
    ///
    ///     thread::sleep(Duration::from_millis(30000));
    ///     socket.disconnect().await.expect("Disconnect failed");
    /// }
    /// ```
    #[inline]
    pub async fn ack<D>(&self, data: D) -> Result<()>
    where
        D: Into<Payload>,
    {
        // For backward compatibility, this method doesn't specify an ack_id
        // It should only be used when there's only one pending ack
        let socket = self.socket.read().await;
        socket.ack(&self.nsp, data.into(), None).await
    }

    /// Acknowledge a message with a specific ack_id
    pub async fn ack_with_id<D>(&self, ack_id: i32, data: D) -> Result<()>
    where
        D: Into<Payload>,
    {
        let socket = self.socket.read().await;
        socket.ack(&self.nsp, data.into(), Some(ack_id)).await
    }

    /// Disconnects this client from the server by sending a `socket.io` closing
    /// packet.
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{asynchronous::{ClientBuilder, Client}, Payload};
    /// use serde_json::json;
    /// use futures_util::{FutureExt, future::BoxFuture};
    ///
    /// #[tokio::main]
    /// async fn main() {
    ///     // apparently the syntax for functions is a bit verbose as rust currently doesn't
    ///     // support an `AsyncFnMut` type that conform with async functions
    ///     fn handle_test(payload: Payload, socket: Client) -> BoxFuture<'static, ()> {
    ///         async move {
    ///             println!("Received: {:#?}", payload);
    ///             socket.emit("test", json!({"hello": true})).await.expect("Server unreachable");
    ///         }.boxed()
    ///     }
    ///
    ///     let mut socket = ClientBuilder::new("http://localhost:4200/")
    ///         .on("test", handle_test)
    ///         .connect()
    ///         .await
    ///         .expect("connection failed");
    ///
    ///     let json_payload = json!({"token": 123});
    ///
    ///     socket.emit("foo", json_payload).await;
    ///
    ///     // disconnect from the server
    ///     socket.disconnect().await;
    /// }
    /// ```
    pub async fn disconnect(&self) -> Result<()> {
        *(self.disconnect_reason.write().await) = DisconnectReason::Manual;

        let disconnect_packet =
            Packet::new(PacketId::Disconnect, self.nsp.clone(), None, None, 0, None);

        self.socket.read().await.send(disconnect_packet).await?;
        self.socket.read().await.disconnect().await?;

        // Abort all in-flight dispatch tasks (including terminal ones) after
        // the teardown above: no user callback may fire late against the
        // dead connection (issue #12). Aborts are fired last so a dispatch
        // task that itself calls `disconnect()` has already sent the packet;
        // it is then cancelled at its next await point. (Task IDs are not
        // available on the pinned tokio 1.40, so per-caller exclusion is not
        // possible; the ordering above makes it unnecessary.)
        self.abort_dispatch(true);

        Ok(())
    }

    /// Sends a message to the server but `alloc`s an `ack` to check whether the
    /// server responded in a given time span. This message takes an event, which
    /// could either be one of the common events like "message" or "error" or a
    /// custom event like "foo", as well as a data parameter. But be careful,
    /// in case you send a [`Payload::String`], the string needs to be valid JSON.
    /// It's even recommended to use a library like serde_json to serialize the data properly.
    /// It also requires a timeout `Duration` in which the client needs to answer.
    /// If the ack is acked in the correct time span, the specified callback is
    /// called. The callback consumes a [`Payload`] which represents the data send
    /// by the server.
    ///
    /// Please note that the requirements on the provided callbacks are similar to the ones
    /// for [`crate::asynchronous::ClientBuilder::on`].
    /// # Example
    /// ```
    /// use tf_rust_socketio::{asynchronous::{ClientBuilder, Client}, Payload};
    /// use serde_json::json;
    /// use std::time::Duration;
    /// use std::thread::sleep;
    /// use futures_util::FutureExt;
    ///
    /// #[tokio::main]
    /// async fn main() {
    ///     let mut socket = ClientBuilder::new("http://localhost:4200/")
    ///         .on("foo", |payload: Payload, _| async move { println!("Received: {:#?}", payload) }.boxed())
    ///         .connect()
    ///         .await
    ///         .expect("connection failed");
    ///
    ///     let ack_callback = |message: Payload, socket: Client| {
    ///         async move {
    ///             match message {
    ///                 Payload::Text(values, _) => println!("{:#?}", values),
    ///                 Payload::Binary(bytes, _) => println!("Received bytes: {:#?}", bytes),
    ///                 // This is deprecated use Payload::Text instead
    ///                 #[allow(deprecated)]
    ///                 Payload::String(str, _) => println!("{}", str),
    ///             }
    ///         }.boxed()
    ///     };
    ///
    ///
    ///     let payload = json!({"token": 123});
    ///     socket.emit_with_ack("foo", payload, Duration::from_secs(2), ack_callback).await.unwrap();
    ///
    ///     sleep(Duration::from_secs(2));
    /// }
    /// ```
    #[inline]
    pub async fn emit_with_ack<F, E, D>(
        &self,
        event: E,
        data: D,
        timeout: Duration,
        callback: F,
    ) -> Result<()>
    where
        F: std::ops::Fn(Payload, Client) -> BoxFuture<'static, ()> + 'static + Send + Sync,
        E: Into<Event>,
        D: Into<Payload>,
    {
        let id = crate::ack_id::next_ack_id()?;
        let socket_packet =
            Packet::new_from_payload(data.into(), event.into(), &self.nsp, Some(id))?;

        let ack = Ack {
            id,
            time_started: Instant::now(),
            timeout,
            callback: Callback::<DynAsyncCallback>::new(callback),
        };

        {
            let mut outstanding = self.outstanding_acks.write().await;
            outstanding.retain(|ack| ack.time_started.elapsed() < ack.timeout);
            outstanding.push(ack);
        }

        let result = self.socket.read().await.send(socket_packet).await;
        if result.is_err() {
            self.outstanding_acks.write().await.retain(|ack| ack.id != id);
        }
        result
    }

    /// Spawns a per-packet dispatch task and tracks it so it can be aborted on
    /// teardown. `terminal` tasks (Close/Error notifications of a dying
    /// session) survive a stream-end abort; a manual disconnect aborts them
    /// too.
    fn spawn_dispatch(
        &self,
        task: impl std::future::Future<Output = ()> + Send + 'static,
        terminal: bool,
    ) {
        let handle = tokio::spawn(task);
        let mut tasks = self.dispatch_tasks.lock().unwrap();
        // Prune finished handles so the list only holds in-flight tasks.
        tasks.retain(|(h, _)| !h.is_finished());
        tasks.push((handle, terminal));
    }

    /// Aborts in-flight dispatch tasks, keeping terminal tasks unless
    /// `include_terminal` is set. Callers must not hold any other lock while
    /// calling this (it locks the dispatch list).
    fn abort_dispatch(&self, include_terminal: bool) {
        let mut tasks = self.dispatch_tasks.lock().unwrap();
        let mut remaining = Vec::new();
        for (handle, terminal) in tasks.drain(..) {
            if include_terminal || !terminal {
                handle.abort();
            } else {
                remaining.push((handle, terminal));
            }
        }
        *tasks = remaining;
    }

    async fn callback<P: Into<Payload>>(
        &self,
        event: &Event,
        payload: P,
        ack_id: Option<i32>,
    ) -> Result<()> {
        let payload = {
            let mut payload = payload.into();
            payload.set_ack_id(ack_id);
            payload
        };

        // Only the callback registrations are cloned out of the builder lock
        // (shared references — `Fn`, cheap Arc clones); user callbacks run
        // outside the lock so a long callback cannot stall other dispatches
        // (issue #12).
        let (on_callback, on_any_callback) = {
            let builder = self.builder.read().await;
            let on_callback = builder.on.get(event).cloned();
            let on_any_callback = match event {
                Event::Message | Event::Custom(_) => builder.on_any.clone(),
                _ => None,
            };
            (on_callback, on_any_callback)
        };

        if let Some(callback) = on_callback {
            callback(payload.clone(), self.clone()).await;
        }

        // Call on_any for all common and custom events.
        if let Some(callback) = on_any_callback {
            callback(event.clone(), payload, self.clone()).await;
        }

        Ok(())
    }

    /// Fires the close chain for the given reason: the legacy
    /// `on(Event::Close)` registration first (timing unchanged), then
    /// `on_close_with_session` with the epoch captured when the close dispatch
    /// was spawned (issue #15). Same lock discipline as [`Self::callback`]: the
    /// registration is cloned out of the builder lock and the user callback
    /// runs outside it.
    async fn callback_close(&self, reason: &str, epoch: u64) -> Result<()> {
        self.callback(&Event::Close, reason, None).await?;

        let close_callback = {
            let builder = self.builder.read().await;
            builder.on_close_with_session.clone()
        };
        if let Some(callback) = close_callback {
            callback(Payload::from(reason), epoch, self.clone()).await;
        }

        Ok(())
    }

    /// Handles an incoming ack. Matching outstanding acks are taken out under
    /// one short lock; the user callbacks run outside the lock so a slow ack
    /// callback cannot stall the reader or other ack/event dispatch (issue #12).
    /// Taking the acks out (draining) also fixes the stale-index removal bug of
    /// the old implementation: with colliding ids the index-based removal
    /// missed entries, leaking acks that later re-fired for the same id.
    #[inline]
    async fn handle_ack(&self, socket_packet: &Packet) {
        let Some(id) = socket_packet.id else {
            return;
        };

        let acks = {
            let mut outstanding = self.outstanding_acks.write().await;
            let mut matched = Vec::new();
            let mut index = 0;
            while index < outstanding.len() {
                if outstanding[index].id == id {
                    matched.push(outstanding.remove(index));
                } else {
                    index += 1;
                }
            }
            matched
        };

        for ack in acks {
            if ack.time_started.elapsed() < ack.timeout {
                // The user ack callback type is `Fn(...) -> BoxFuture<'static, ()>`
                // so there is no error channel to propagate (same as in the
                // serial-dispatch implementation); a panicking callback is
                // isolated by the task executor, consistent with event paths.
                if let Some(ref payload) = socket_packet.data {
                    let mut payload = Payload::from(payload.to_owned());
                    payload.set_ack_id(socket_packet.id);
                    let _ = ack.callback.deref()(payload, self.clone()).await;
                }
                if let Some(ref attachments) = socket_packet.attachments {
                    if let Some(payload) = attachments.first() {
                        let payload = Payload::Binary(payload.to_owned(), socket_packet.id);
                        let _ = ack.callback.deref()(payload, self.clone()).await;
                    }
                }
            } else {
                trace!("Received an Ack that is now timed out (elapsed time was longer than specified duration)");
            }
        }
    }

    /// Handles a binary event.
    #[inline]
    async fn handle_binary_event(&self, packet: &Packet) -> Result<()> {
        let event = if let Some(string_data) = &packet.data {
            string_data.replace('\"', "").into()
        } else {
            Event::Message
        };

        if let Some(attachments) = &packet.attachments {
            if let Some(binary_payload) = attachments.first() {
                self.callback(
                    &event,
                    Payload::Binary(binary_payload.to_owned(), packet.id),
                    packet.id,
                )
                .await?;
            }
        }
        Ok(())
    }

    /// A method that parses a packet and eventually calls the corresponding
    /// callback with the supplied data.
    async fn handle_event(&self, packet: &Packet) -> Result<()> {
        let Some(ref data) = packet.data else {
            return Ok(());
        };

        // a socketio message always comes in one of the following two flavors (both JSON):
        // 1: `["event", "msg", ...]`
        // 2: `["msg"]`
        // in case 2, the message is ment for the default message event, in case 1 the event
        // is specified
        if let Ok(Value::Array(contents)) = serde_json::from_str::<Value>(data) {
            let (event, payloads) = match contents.len() {
                0 => return Err(Error::IncompletePacket()),
                // Incorrect packet, ignore it
                1 => (Event::Message, contents.as_slice()),
                // it's a message event
                _ => match contents.first() {
                    Some(Value::String(ev)) => (Event::from(ev.as_str()), &contents[1..]),
                    // get rest(1..) of them as data, not just take the 2nd element
                    _ => (Event::Message, contents.as_slice()),
                    // take them all as data
                },
            };

            // call the correct callback
            self.callback(&event, payloads.to_vec(), packet.id).await?;
        }

        Ok(())
    }

    /// Schedules dispatch of an incoming socket.io packet without ever
    /// awaiting user code: state machine writes (disconnect_reason) happen
    /// inline, every user-facing callback is spawned as a tracked task
    /// (issue #12) so the reader can immediately read the next packet.
    #[inline]
    async fn handle_socketio_packet(&self, packet: &Packet) {
        if packet.nsp != self.nsp {
            return;
        }
        match packet.packet_type {
            PacketId::Ack | PacketId::BinaryAck => {
                let packet = packet.clone();
                let client = self.clone();
                self.spawn_dispatch(async move { client.handle_ack(&packet).await }, false);
            }
            PacketId::BinaryEvent => {
                let packet = packet.clone();
                let client = self.clone();
                self.spawn_dispatch(
                    async move {
                        if let Err(err) = client.handle_binary_event(&packet).await {
                            let _ = client.callback(&Event::Error, err.to_string(), None).await;
                        }
                    },
                    false,
                );
            }
            PacketId::Connect => {
                *(self.disconnect_reason.write().await) = DisconnectReason::default();
                let client = self.clone();
                // Terminal: survives a stream-end abort so a connect-then-
                // immediate-transport-drop still runs the Connect callback.
                self.spawn_dispatch(
                    async move {
                        let _ = client.callback(&Event::Connect, "", None).await;
                    },
                    true,
                );
            }
            PacketId::Disconnect => {
                *(self.disconnect_reason.write().await) = DisconnectReason::Server;
                // In-flight dispatch tasks belong to the now-dead session. They
                // are aborted (non-terminal) before the Close callback runs.
                // The epoch is captured before the spawn so the close carries
                // this dying session's generation (issue #15).
                self.abort_dispatch(false);
                let epoch = self.session_epoch();
                let client = self.clone();
                self.spawn_dispatch(
                    async move {
                        let _ = client
                            .callback_close(CloseReason::IOServerDisconnect.as_str(), epoch)
                            .await;
                    },
                    true,
                );
            }
            PacketId::ConnectError => {
                let client = self.clone();
                let message = String::from("Received an ConnectError frame: ")
                    + packet
                        .data
                        .as_ref()
                        .unwrap_or(&String::from("\"No error message provided\""));
                self.spawn_dispatch(
                    async move {
                        let _ = client.callback(&Event::Error, message, None).await;
                    },
                    false,
                );
            }
            PacketId::Event => {
                let packet = packet.clone();
                let client = self.clone();
                self.spawn_dispatch(
                    async move {
                        if let Err(err) = client.handle_event(&packet).await {
                            let _ = client.callback(&Event::Error, err.to_string(), None).await;
                        }
                    },
                    false,
                );
            }
        }
    }

    /// Returns the packet stream for the client.
    ///
    /// The reader never awaits user callbacks: every packet is scheduled as an
    /// independent dispatch task (issue #12), so Engine.IO pings and later
    /// packets keep flowing while a long callback is pending.
    pub(crate) async fn as_stream<'a>(
        &'a self,
    ) -> Pin<Box<dyn Stream<Item = Result<Packet>> + Send + 'a>> {
        let socket_clone = (*self.socket.read().await).clone();
        let state = ReaderState {
            socket: socket_clone,
            client: self.clone(),
        };

        stream::unfold(state, |mut state| async move {
            // wait for the next payload
            let packet: Option<std::result::Result<Packet, Error>> = state.socket.next().await;
            match packet {
                // end the stream if the underlying one is closed
                None => {
                    // Abort in-flight non-terminal dispatch tasks of the dead
                    // session; terminal Close/Error notifications survive.
                    state.client.abort_dispatch(false);
                    None
                }
                Some(Err(err)) => {
                    // A manual disconnect may have raced ahead of buffered
                    // packets: stop the reader instead of dispatching errors
                    // against the torn-down session.
                    if matches!(
                        *state.client.disconnect_reason.read().await,
                        DisconnectReason::Manual
                    ) {
                        state.client.abort_dispatch(false);
                        None
                    } else {
                        // Terminal: the stream yields Err and ends right after, so
                        // a plain task would be aborted before it ever runs.
                        let client = state.client.clone();
                        let message = err.to_string();
                        state.client.spawn_dispatch(
                            async move {
                                let _ = client.callback(&Event::Error, message, None).await;
                            },
                            true,
                        );
                        Some((Err(err), state))
                    }
                }
                Some(Ok(packet)) => {
                    // Same guard as above: a manual disconnect must stop
                    // dispatching the packets buffered after it (issue #12).
                    if matches!(
                        *state.client.disconnect_reason.read().await,
                        DisconnectReason::Manual
                    ) {
                        state.client.abort_dispatch(false);
                        None
                    } else {
                        state.client.handle_socketio_packet(&packet).await;
                        Some((Ok(packet), state))
                    }
                }
            }
        })
        .boxed()
    }
}

/// State carried by the reader stream of [`Client::as_stream`]. Owned (no
/// borrow of the `Client`) so the stream can be sendable, spawned-into and
/// dropped freely.
struct ReaderState {
    socket: InnerSocket,
    client: Client,
}

impl Drop for ReaderState {
    fn drop(&mut self) {
        // Belt-and-braces: if the stream is dropped without being fully
        // consumed (e.g. a connect_manual iterator aborted early), in-flight
        // non-terminal dispatch tasks are cut as well.
        self.client.abort_dispatch(false);
    }
}

#[cfg(test)]
mod test {

    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    use bytes::Bytes;
    use futures_util::{FutureExt, StreamExt};
    use native_tls::TlsConnector;
    use serde_json::json;
    use tokio::{
        sync::{mpsc, Mutex},
        time::{sleep, timeout},
    };

    use serial_test::serial;

    use crate::{
        asynchronous::{
            client::{builder::ClientBuilder, client::Client},
            ReconnectSettings,
        },
        error::Result,
        packet::{Packet, PacketId},
        CloseReason, Event, Payload, TransportType,
    };

    #[tokio::test]
    async fn socket_io_integration() -> Result<()> {
        let url = crate::test::socket_io_server();

        let socket = ClientBuilder::new(url)
            .on("test", |msg, _| {
                async {
                    match msg {
                        Payload::Text(values, _) => println!("Received json: {:#?}", values),
                        #[allow(deprecated)]
                        Payload::String(str, _) => println!("Received string: {}", str),
                        Payload::Binary(bin, _) => println!("Received binary data: {:#?}", bin),
                    }
                }
                .boxed()
            })
            .connect()
            .await?;

        let payload = json!({"token": 123_i32});
        let result = socket.emit("test", Payload::from(payload.clone())).await;

        assert!(result.is_ok());

        let ack = socket
            .emit_with_ack(
                "test",
                Payload::from(payload),
                Duration::from_secs(1),
                |message: Payload, socket: Client| {
                    async move {
                        let result = socket
                            .emit("test", Payload::from(json!({"got ack": true})))
                            .await;
                        assert!(result.is_ok());

                        println!("Yehaa! My ack got acked?");
                        if let Payload::Text(json, _) = message {
                            println!("Received json Ack");
                            println!("Ack data: {:#?}", json);
                        }
                    }
                    .boxed()
                },
            )
            .await;
        assert!(ack.is_ok());

        sleep(Duration::from_secs(2)).await;

        assert!(socket.disconnect().await.is_ok());

        Ok(())
    }

    #[tokio::test]
    async fn socket_io_async_callback() -> Result<()> {
        // Test whether asynchronous callbacks are fully executed.
        let url = crate::test::socket_io_server();

        // This synchronization mechanism is used to let the test know that the end of the
        // async callback was reached.
        let notify = Arc::new(tokio::sync::Notify::new());
        let notify_clone = notify.clone();

        let socket = ClientBuilder::new(url)
            .on("test", move |_, _| {
                let cl = notify_clone.clone();
                async move {
                    sleep(Duration::from_secs(1)).await;
                    // The async callback should be awaited and not aborted.
                    // Thus, the notification should be called.
                    cl.notify_one();
                }
                .boxed()
            })
            .connect()
            .await?;

        let payload = json!({"token": 123_i32});
        let result = socket.emit("test", Payload::from(payload)).await;

        assert!(result.is_ok());
        // If the timeout did not trigger, the async callback was fully executed.
        let timeout = timeout(Duration::from_secs(5), notify.notified()).await;
        assert!(timeout.is_ok());

        Ok(())
    }

    #[tokio::test]
    async fn socket_io_callbacks_do_not_block_reader() -> Result<()> {
        // Issue #12: a long-running event callback must not block the reader
        // from dispatching the next packet on the same connection.
        let url = crate::test::socket_io_server();

        let long_started = Arc::new(tokio::sync::Notify::new());
        let long_done = Arc::new(tokio::sync::Notify::new());
        let test_event = Arc::new(tokio::sync::Notify::new());

        let long_started_clone = long_started.clone();
        let long_done_clone = long_done.clone();
        let test_event_clone = test_event.clone();

        let socket = ClientBuilder::new(url)
            .on("message", move |_, _| {
                let started = long_started_clone.clone();
                let done = long_done_clone.clone();
                async move {
                    started.notify_one();
                    sleep(Duration::from_secs(3)).await;
                    done.notify_one();
                }
                .boxed()
            })
            .on("test", move |_, _| {
                let test_event = test_event_clone.clone();
                async move {
                    test_event.notify_one();
                }
                .boxed()
            })
            .connect()
            .await?;

        // The server emits "message" and "test" right after connect. The long
        // callback is dispatched first; the "test" event must not wait for it.
        let started = timeout(Duration::from_secs(2), long_started.notified()).await;
        assert!(started.is_ok(), "long callback should start");

        let test_rx = timeout(Duration::from_secs(1), test_event.notified()).await;
        assert!(
            test_rx.is_ok(),
            "reader must not be blocked by a long-running callback (issue #12)"
        );

        // The long callback is still awaited to completion while connected.
        let done = timeout(Duration::from_secs(10), long_done.notified()).await;
        assert!(
            done.is_ok(),
            "long callback should complete while connected"
        );

        socket.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    async fn socket_io_disconnect_aborts_pending_dispatch() -> Result<()> {
        // Issue #12: teardown must leave no leftover dispatch tasks — a
        // callback pending at manual disconnect must be aborted, not fire late.
        let url = crate::test::socket_io_server();

        let started = Arc::new(tokio::sync::Notify::new());
        let finished = Arc::new(tokio::sync::Notify::new());

        let started_clone = started.clone();
        let finished_clone = finished.clone();

        let socket = ClientBuilder::new(url)
            .on("test", move |_, _| {
                let started = started_clone.clone();
                let finished = finished_clone.clone();
                async move {
                    started.notify_one();
                    sleep(Duration::from_secs(3)).await;
                    finished.notify_one();
                }
                .boxed()
            })
            .connect()
            .await?;

        // The server emits "test" right after connect; wait until the callback is in flight.
        let started = timeout(Duration::from_secs(2), started.notified()).await;
        assert!(started.is_ok(), "long callback should start");

        socket.disconnect().await?;

        let finished = timeout(Duration::from_secs(4), finished.notified()).await;
        assert!(
            finished.is_err(),
            "pending dispatch must be aborted on manual disconnect (issue #12)"
        );

        Ok(())
    }

    #[tokio::test]
    async fn socket_io_long_callback_keeps_heartbeat_alive() -> Result<()> {
        // Issue #12: with a fast-heartbeat server (pingInterval 300ms /
        // pingTimeout 700ms), a long callback must not stall Engine.IO pings
        // — otherwise the server cuts the connection and Close fires once the
        // stalled reader resumes. The observation window must exceed the
        // callback duration: while the reader is blocked, it cannot observe
        // the already-dead transport.
        let url = crate::test::socket_io_fast_ping_server();

        let started = Arc::new(tokio::sync::Notify::new());
        let done = Arc::new(tokio::sync::Notify::new());
        let (close_tx, mut close_rx) = mpsc::channel::<Payload>(1);
        let (echo_tx, mut echo_rx) = mpsc::channel::<Payload>(1);

        let started_clone = started.clone();
        let done_clone = done.clone();
        let close_tx_clone = close_tx.clone();

        let socket = ClientBuilder::new(url)
            .on("test", move |_, _| {
                let started = started_clone.clone();
                let done = done_clone.clone();
                async move {
                    started.notify_one();
                    sleep(Duration::from_millis(2500)).await;
                    done.notify_one();
                }
                .boxed()
            })
            .on(Event::Close, move |payload, _| {
                let close_tx = close_tx_clone.clone();
                async move {
                    let _ = close_tx.send(payload).await;
                }
                .boxed()
            })
            .on("test-received", move |payload, _| {
                let echo_tx = echo_tx.clone();
                async move {
                    let _ = echo_tx.send(payload).await;
                }
                .boxed()
            })
            .connect()
            .await?;

        let started = timeout(Duration::from_secs(2), started.notified()).await;
        assert!(started.is_ok(), "long callback should start");

        // No transport close within 4s while the 2.5s callback is pending.
        let close = timeout(Duration::from_secs(4), close_rx.recv()).await;
        assert!(
            close.is_err(),
            "connection must survive a long callback (issue #12)"
        );

        let done = timeout(Duration::from_secs(5), done.notified()).await;
        assert!(done.is_ok(), "long callback should complete");

        // The connection must still be usable after the callback finished.
        socket.emit("test", json!("alive")).await?;
        let echo = timeout(Duration::from_secs(1), echo_rx.recv()).await;
        assert!(
            echo.is_ok(),
            "connection must still be usable after a long callback"
        );

        socket.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    async fn socket_io_builder_integration() -> Result<()> {
        let url = crate::test::socket_io_server();

        // test socket build logic
        let socket_builder = ClientBuilder::new(url);

        let tls_connector = TlsConnector::builder()
            .use_sni(true)
            .build()
            .expect("Found illegal configuration");

        let socket = socket_builder
            .namespace("/admin")
            .tls_config(tls_connector)
            .opening_header("accept-encoding", "application/json")
            .on("test", |str, _| {
                async move { println!("Received: {:#?}", str) }.boxed()
            })
            .on("message", |payload, _| {
                async move { println!("{:#?}", payload) }.boxed()
            })
            .connect()
            .await?;

        assert!(socket.emit("message", json!("Hello World")).await.is_ok());

        assert!(socket
            .emit("binary", Bytes::from_static(&[46, 88]))
            .await
            .is_ok());

        assert!(socket
            .emit_with_ack(
                "binary",
                json!("pls ack"),
                Duration::from_secs(1),
                |payload, _| async move {
                    println!("Yehaa the ack got acked");
                    println!("With data: {:#?}", payload);
                }
                .boxed()
            )
            .await
            .is_ok());

        sleep(Duration::from_secs(2)).await;

        Ok(())
    }

    #[tokio::test]
    #[serial(reconnect)]
    async fn socket_io_reconnect_integration() -> Result<()> {
        static CONNECT_NUM: AtomicUsize = AtomicUsize::new(0);
        static MESSAGE_NUM: AtomicUsize = AtomicUsize::new(0);
        static ON_RECONNECT_CALLED: AtomicUsize = AtomicUsize::new(0);
        let latest_message = Arc::new(Mutex::new(String::new()));
        let handler_latest_message = latest_message.clone();

        let url = crate::test::socket_io_restart_server();

        let socket = ClientBuilder::new(url.clone())
            .reconnect(true)
            .max_reconnect_attempts(100)
            .reconnect_delay(100, 100)
            .on_reconnect(move || {
                let url = url.clone();
                async move {
                    ON_RECONNECT_CALLED.fetch_add(1, Ordering::Release);

                    let mut settings = ReconnectSettings::new();

                    // Try setting the address to what we already have, just
                    // to test. This is not strictly necessary in real usage.
                    settings.address(url.to_string());
                    settings.opening_header("MESSAGE_BACK", "updated");
                    settings
                }
                .boxed()
            })
            .on("open", |_, socket| {
                async move {
                    CONNECT_NUM.fetch_add(1, Ordering::Release);
                    let r = socket.emit_with_ack(
                        "message",
                        json!(""),
                        Duration::from_millis(100),
                        |_, _| async move {}.boxed(),
                    );
                    assert!(r.await.is_ok(), "should emit message success");
                }
                .boxed()
            })
            .on("message", move |payload, _socket| {
                let latest_message = handler_latest_message.clone();
                async move {
                    // test the iterator implementation and make sure there is a constant
                    // stream of packets, even when reconnecting
                    MESSAGE_NUM.fetch_add(1, Ordering::Release);

                    let msg = match payload {
                        Payload::Text(msg, _) => msg
                            .into_iter()
                            .next()
                            .expect("there should be one text payload"),
                        _ => panic!(),
                    };

                    let msg = serde_json::from_value(msg).expect("payload should be json string");

                    *latest_message.lock().await = msg;
                }
                .boxed()
            })
            .connect()
            .await;

        assert!(socket.is_ok(), "should connect success");
        let socket = socket.unwrap();

        // waiting for server to emit message
        sleep(Duration::from_millis(500)).await;

        assert_eq!(load(&CONNECT_NUM), 1, "should connect once");
        assert_eq!(load(&MESSAGE_NUM), 1, "should receive one");
        assert_eq!(
            *latest_message.lock().await,
            "test",
            "should receive test message"
        );

        let r = socket.emit("restart_server", json!("")).await;
        assert!(r.is_ok(), "should emit restart success");

        // waiting for server to restart
        for _ in 0..10 {
            sleep(Duration::from_millis(400)).await;
            if load(&CONNECT_NUM) == 2 && load(&MESSAGE_NUM) == 2 {
                break;
            }
        }

        assert_eq!(load(&CONNECT_NUM), 2, "should connect twice");
        assert_eq!(load(&MESSAGE_NUM), 2, "should receive two messages");
        assert!(
            load(&ON_RECONNECT_CALLED) > 1,
            "should call on_reconnect at least once"
        );
        assert_eq!(
            *latest_message.lock().await,
            "updated",
            "should receive updated message"
        );

        socket.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    #[serial(reconnect)]
    async fn repro_close_callback_blocked_by_pending_reconnect_auth() -> Result<()> {
        // Give the previous `serial(reconnect)` test's server restart time
        // to finish before connecting.
        sleep(Duration::from_millis(2500)).await;
        let reconnect_started = Arc::new(tokio::sync::Notify::new());
        let release_reconnect = Arc::new(tokio::sync::Notify::new());
        let close_received = Arc::new(tokio::sync::Notify::new());
        let reconnected = Arc::new(tokio::sync::Notify::new());
        let reconnect_count = Arc::new(AtomicUsize::new(0));

        let reconnect_started_cb = reconnect_started.clone();
        let release_reconnect_cb = release_reconnect.clone();
        let close_received_cb = close_received.clone();
        let reconnected_cb = reconnected.clone();
        let reconnect_count_cb = reconnect_count.clone();
        let socket = ClientBuilder::new(crate::test::socket_io_restart_server())
            .reconnect(true)
            .max_reconnect_attempts(100)
            .reconnect_delay(100, 100)
            .on_reconnect(move || {
                let reconnect_started = reconnect_started_cb.clone();
                let release_reconnect = release_reconnect_cb.clone();
                async move {
                    reconnect_started.notify_one();
                    release_reconnect.notified().await;
                    ReconnectSettings::new()
                }
                .boxed()
            })
            .on(Event::Close, move |_, _| {
                let close_received = close_received_cb.clone();
                async move { close_received.notify_one() }.boxed()
            })
            .on("open", move |_, _| {
                let reconnected = reconnected_cb.clone();
                let count = reconnect_count_cb.clone();
                async move {
                    // Notify only on the second "open": the initial connect
                    // fires one too, and a leftover permit would make the wait
                    // below return without waiting for the reconnect.
                    if count.fetch_add(1, Ordering::Release) + 1 == 2 {
                        reconnected.notify_one();
                    }
                }
                .boxed()
            })
            .connect()
            .await?;

        sleep(Duration::from_millis(500)).await;
        socket.emit("restart_server", json!("")).await?;
        timeout(Duration::from_secs(6), reconnect_started.notified())
            .await
            .expect("reconnect auth callback did not start");

        let close_result = timeout(Duration::from_secs(1), close_received.notified()).await;
        release_reconnect.notify_one();
        assert!(
            close_result.is_ok(),
            "Close callback was blocked by pending reconnect auth"
        );

        // The server rebinds ~2s after `restart_server` is emitted; wait for
        // the reconnect (second "open") before disconnecting, so the next
        // `serial(reconnect)` test does not race the restarting server. The
        // sleep below is a redundant settle for slow machines.
        timeout(Duration::from_secs(6), reconnected.notified())
            .await
            .ok();
        sleep(Duration::from_millis(2500)).await;

        let _ = socket.disconnect().await;
        Ok(())
    }

    #[tokio::test]
    #[serial(reconnect)]
    async fn on_close_with_session_gets_dying_session_epoch() -> Result<()> {
        // Give the previous `serial(reconnect)` test's server restart time
        // to finish before connecting.
        sleep(Duration::from_millis(2500)).await;

        let close_fired = Arc::new(tokio::sync::Notify::new());
        let release_close = Arc::new(tokio::sync::Notify::new());
        let recorded_done = Arc::new(tokio::sync::Notify::new());
        // What the new close chain observed: (epoch param from the callback,
        // `session_epoch()` read when the callback body finally ran). The
        // record happens only after the reconnect has completed, so a correct
        // implementation yields (1, 2) — the accessor reports the new session
        // while the param must keep the dying session's value.
        let recorded = Arc::new(Mutex::new(None::<(u64, u64)>));

        let close_fired_cb = close_fired.clone();
        let release_close_cb = release_close.clone();
        let recorded_done_cb = recorded_done.clone();
        let recorded_cb = recorded.clone();

        let socket = ClientBuilder::new(crate::test::socket_io_restart_server())
            .reconnect(true)
            .max_reconnect_attempts(100)
            .reconnect_delay(100, 100)
            .on(Event::Close, move |_, _| {
                let close_fired = close_fired_cb.clone();
                let release_close = release_close_cb.clone();
                async move {
                    // Gate the close chain: the new chain below only runs after
                    // this legacy callback returns. The test lets the reconnect
                    // complete first, so the new chain executes with the epoch
                    // already bumped — the param must still be the dying
                    // session's value captured at dispatch-spawn time (issue
                    // #15), not re-read from the accessor mid-chain.
                    close_fired.notify_one();
                    release_close.notified().await;
                }
                .boxed()
            })
            .on_close_with_session(move |_payload, epoch, client| {
                let recorded = recorded_cb.clone();
                let recorded_done = recorded_done_cb.clone();
                async move {
                    *recorded.lock().await = Some((epoch, client.session_epoch()));
                    recorded_done.notify_one();
                }
                .boxed()
            })
            .connect()
            .await?;

        assert_eq!(socket.session_epoch(), 1, "initial connect = epoch 1");

        sleep(Duration::from_millis(500)).await;
        socket.emit("restart_server", json!("")).await?;

        // The close chain started (legacy callback entered) while the dying
        // session was still the current one.
        let close_result = timeout(Duration::from_secs(2), close_fired.notified()).await;
        assert!(
            close_result.is_ok(),
            "close did not fire after transport close"
        );

        // Let the reconnect complete (the restart server rebinds ~2s after the
        // emit) while the close chain is gated.
        timeout(Duration::from_secs(8), async {
            while socket.session_epoch() < 2 {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("reconnect did not complete");
        assert_eq!(socket.session_epoch(), 2, "successful reconnect = epoch 2");

        // Release the gate: from here the new chain runs against the new
        // session. The epoch param must still be the dying session's value
        // (1) while the accessor already reports 2.
        release_close.notify_one();
        timeout(Duration::from_secs(2), recorded_done.notified())
            .await
            .expect("on_close_with_session did not run after the release");
        assert_eq!(
            *recorded.lock().await,
            Some((1, 2)),
            "late close must carry the dying session's epoch, not the accessor's"
        );

        sleep(Duration::from_millis(2500)).await;
        let _ = socket.disconnect().await;
        Ok(())
    }

    #[tokio::test]
    async fn on_close_with_session_ioserver_disconnect_gets_current_session_epoch() -> Result<()> {
        // The 4206 restart-url-auth server closes the socket when the
        // handshake timestamp is invalid (ci/socket-io-restart-url-auth.js),
        // so the client receives a socket.io Disconnect packet and the
        // IOServerDisconnect close chain fires with the current session's
        // epoch.
        let mut url = crate::test::socket_io_restart_url_auth_server();
        url.set_query(Some("timestamp=1"));

        let close_called = Arc::new(tokio::sync::Notify::new());
        let recorded = Arc::new(Mutex::new(None::<(Payload, u64)>));
        let close_called_cb = close_called.clone();
        let recorded_cb = recorded.clone();
        // Both close chains must fire on the same close, legacy first.
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let order_legacy = order.clone();
        let order_new = order.clone();

        let socket = ClientBuilder::new(url)
            .on(Event::Close, move |_, _| {
                let order = order_legacy.clone();
                async move { order.lock().await.push("legacy") }.boxed()
            })
            .on_close_with_session(move |payload, epoch, _client| {
                let order = order_new.clone();
                let recorded = recorded_cb.clone();
                let close_called = close_called_cb.clone();
                async move {
                    order.lock().await.push("new");
                    *recorded.lock().await = Some((payload, epoch));
                    close_called.notify_one();
                }
                .boxed()
            })
            .connect()
            .await?;

        let close_result = timeout(Duration::from_secs(3), close_called.notified()).await;
        assert!(
            close_result.is_ok(),
            "on_close_with_session did not fire on server disconnect"
        );

        assert_eq!(
            *order.lock().await,
            ["legacy", "new"],
            "both close chains must fire, legacy first"
        );
        let (payload, epoch) = recorded
            .lock()
            .await
            .take()
            .expect("close callback did not record");
        assert_eq!(
            payload,
            Payload::from(CloseReason::IOServerDisconnect.as_str()),
            "close reason must be ioserverdisconnect"
        );
        assert_eq!(
            epoch, 1,
            "server-disconnect close carries the current session epoch"
        );
        assert_eq!(socket.session_epoch(), 1, "no reconnect, session stays 1");

        let _ = socket.disconnect().await;
        Ok(())
    }

    #[tokio::test]
    async fn socket_io_builder_integration_iterator() -> Result<()> {
        let url = crate::test::socket_io_server();

        // test socket build logic
        let socket_builder = ClientBuilder::new(url);

        let tls_connector = TlsConnector::builder()
            .use_sni(true)
            .build()
            .expect("Found illegal configuration");

        let socket = socket_builder
            .namespace("/admin")
            .tls_config(tls_connector)
            .opening_header("accept-encoding", "application/json")
            .on("test", |str, _| {
                async move { println!("Received: {:#?}", str) }.boxed()
            })
            .on("message", |payload, _| {
                async move { println!("{:#?}", payload) }.boxed()
            })
            .connect_manual()
            .await?;

        assert!(socket.emit("message", json!("Hello World")).await.is_ok());

        assert!(socket
            .emit("binary", Bytes::from_static(&[46, 88]))
            .await
            .is_ok());

        assert!(socket
            .emit_with_ack(
                "binary",
                json!("pls ack"),
                Duration::from_secs(1),
                |payload, _| async move {
                    println!("Yehaa the ack got acked");
                    println!("With data: {:#?}", payload);
                }
                .boxed()
            )
            .await
            .is_ok());

        test_socketio_socket(socket, "/admin".to_owned()).await
    }

    #[tokio::test]
    async fn socket_io_on_any_integration() -> Result<()> {
        let url = crate::test::socket_io_server();

        let (tx, mut rx) = mpsc::channel(2);

        let mut _socket = ClientBuilder::new(url)
            .namespace("/")
            .auth(json!({ "password": "123" }))
            .on_any(move |event, payload, _| {
                let clone_tx = tx.clone();
                async move {
                    if let Payload::Text(values, _) = payload {
                        println!("{event}: {values:#?}");
                    }
                    clone_tx.send(String::from(event)).await.unwrap();
                }
                .boxed()
            })
            .connect()
            .await?;

        // Since issue #12, events are dispatched concurrently and their
        // completion order is not guaranteed — only membership is.
        let mut events = Vec::new();
        for _ in 0..2 {
            events.push(rx.recv().await.unwrap());
        }

        assert!(events.contains(&"message".to_owned()));
        assert!(events.contains(&"test".to_owned()));

        Ok(())
    }

    #[tokio::test]
    async fn socket_io_auth_builder_integration() -> Result<()> {
        let url = crate::test::socket_io_auth_server();
        let nsp = String::from("/admin");
        let socket = ClientBuilder::new(url)
            .namespace(nsp.clone())
            .auth(json!({ "password": "123" }))
            .connect_manual()
            .await?;

        // open packet
        let mut socket_stream = socket.as_stream().await;
        let _ = socket_stream.next().await.unwrap()?;

        let packet = socket_stream.next().await.unwrap()?;
        assert_eq!(
            packet,
            Packet::new(
                PacketId::Event,
                nsp,
                Some("[\"auth\",\"success\"]".to_owned()),
                None,
                0,
                None
            )
        );

        Ok(())
    }

    #[tokio::test]
    async fn socket_io_transport_close() -> Result<()> {
        let url = crate::test::socket_io_server();

        let (tx, mut rx) = mpsc::channel(1);

        let notify = Arc::new(tokio::sync::Notify::new());
        let notify_clone = notify.clone();

        let socket = ClientBuilder::new(url)
            .on(Event::Connect, move |_, _| {
                let cl = notify_clone.clone();
                async move {
                    cl.notify_one();
                }
                .boxed()
            })
            .on(Event::Close, move |payload, _| {
                let clone_tx = tx.clone();
                async move { clone_tx.send(payload).await.unwrap() }.boxed()
            })
            .connect()
            .await?;

        // Wait until socket is connected
        let connect_timeout = timeout(Duration::from_secs(1), notify.notified()).await;
        assert!(connect_timeout.is_ok());

        // Instruct server to close transport
        let result = socket.emit("close_transport", Payload::from("")).await;
        assert!(result.is_ok());

        // Wait for Event::Close
        let rx_timeout = timeout(Duration::from_secs(1), rx.recv()).await;
        assert!(rx_timeout.is_ok());

        assert_eq!(
            rx_timeout.unwrap(),
            Some(Payload::from(CloseReason::TransportClose.as_str()))
        );

        Ok(())
    }

    #[tokio::test]
    async fn socketio_polling_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let socket = ClientBuilder::new(url.clone())
            .transport_type(TransportType::Polling)
            .connect_manual()
            .await?;
        test_socketio_socket(socket, "/".to_owned()).await
    }

    #[tokio::test]
    async fn socket_io_websocket_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let socket = ClientBuilder::new(url.clone())
            .transport_type(TransportType::Websocket)
            .connect_manual()
            .await?;
        test_socketio_socket(socket, "/".to_owned()).await
    }

    #[tokio::test]
    async fn socket_io_websocket_upgrade_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let socket = ClientBuilder::new(url)
            .transport_type(TransportType::WebsocketUpgrade)
            .connect_manual()
            .await?;
        test_socketio_socket(socket, "/".to_owned()).await
    }

    #[tokio::test]
    async fn socket_io_any_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let socket = ClientBuilder::new(url)
            .transport_type(TransportType::Any)
            .connect_manual()
            .await?;
        test_socketio_socket(socket, "/".to_owned()).await
    }

    async fn test_socketio_socket(socket: Client, nsp: String) -> Result<()> {
        // open packet
        let mut socket_stream = socket.as_stream().await;
        let _: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        let packet: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        assert!(packet.is_some());

        let packet = packet.unwrap();

        assert_eq!(
            packet,
            Packet::new(
                PacketId::Event,
                nsp.clone(),
                Some("[\"Hello from the message event!\"]".to_owned()),
                None,
                0,
                None,
            )
        );

        let packet: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        assert!(packet.is_some());

        let packet = packet.unwrap();

        assert_eq!(
            packet,
            Packet::new(
                PacketId::Event,
                nsp.clone(),
                Some("[\"test\",\"Hello from the test event!\"]".to_owned()),
                None,
                0,
                None
            )
        );
        let packet: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        assert!(packet.is_some());

        let packet = packet.unwrap();
        assert_eq!(
            packet,
            Packet::new(
                PacketId::BinaryEvent,
                nsp.clone(),
                None,
                None,
                1,
                Some(vec![Bytes::from_static(&[4, 5, 6])]),
            )
        );

        let packet: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        assert!(packet.is_some());

        let packet = packet.unwrap();
        assert_eq!(
            packet,
            Packet::new(
                PacketId::BinaryEvent,
                nsp.clone(),
                Some("\"test\"".to_owned()),
                None,
                1,
                Some(vec![Bytes::from_static(&[1, 2, 3])]),
            )
        );

        let packet: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        assert!(packet.is_some());

        let packet = packet.unwrap();
        assert_eq!(
            packet,
            Packet::new(
                PacketId::Event,
                nsp.clone(),
                Some(
                    serde_json::Value::Array(vec![
                        serde_json::Value::from("This is the first argument"),
                        serde_json::Value::from("This is the second argument"),
                        serde_json::json!({"argCount":3})
                    ])
                    .to_string()
                ),
                None,
                0,
                None,
            )
        );

        let packet: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        assert!(packet.is_some());

        let packet = packet.unwrap();
        assert_eq!(
            packet,
            Packet::new(
                PacketId::Event,
                nsp.clone(),
                Some(
                    serde_json::json!([
                        "on_abc_event",
                        "",
                        {
                        "abc": 0,
                        "some_other": "value",
                        }
                    ])
                    .to_string()
                ),
                None,
                0,
                None,
            )
        );

        let cb = |message: Payload, _| {
            async {
                println!("Yehaa! My ack got acked?");
                if let Payload::Text(values, _) = message {
                    println!("Received json ack");
                    println!("Ack data: {:#?}", values);
                }
            }
            .boxed()
        };

        assert!(socket
            .emit_with_ack(
                "test",
                Payload::from("123".to_owned()),
                Duration::from_secs(10),
                cb
            )
            .await
            .is_ok());

        let packet: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        assert!(packet.is_some());
        let packet = packet.unwrap();
        assert_eq!(
            packet,
            Packet::new(
                PacketId::Event,
                nsp.clone(),
                Some("[\"test-received\",123]".to_owned()),
                None,
                0,
                None,
            )
        );

        let packet: Option<Packet> = Some(socket_stream.next().await.unwrap()?);

        assert!(packet.is_some());
        let packet = packet.unwrap();
        assert!(matches!(
            packet,
            Packet {
                packet_type: PacketId::Ack,
                nsp: _,
                data: Some(_),
                id: Some(_),
                attachment_count: 0,
                attachments: None,
            }
        ));

        Ok(())
    }

    fn load(num: &AtomicUsize) -> usize {
        num.load(Ordering::Acquire)
    }
}
