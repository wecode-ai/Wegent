use super::callback::Callback;
use crate::packet::{Packet, PacketId};
use crate::Error;
pub(crate) use crate::{event::CloseReason, event::Event, payload::Payload};
use serde_json::Value;

use crate::client::callback::{SocketAnyCallback, SocketCallback, SocketCloseCallback};
use crate::error::Result;
use std::collections::HashMap;
use std::ops::DerefMut;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use std::time::Instant;

use crate::socket::Socket as InnerSocket;

/// Represents an `Ack` as given back to the caller. Holds the internal `id` as
/// well as the current ack'ed state. Holds data which will be accessible as
/// soon as the ack'ed state is set to true. An `Ack` that didn't get ack'ed
/// won't contain data.
#[derive(Debug)]
pub struct Ack {
    pub id: i32,
    timeout: Duration,
    time_started: Instant,
    callback: Callback<SocketCallback>,
}

/// A socket which handles communication with the server. It's initialized with
/// a specific address as well as an optional namespace to connect to. If `None`
/// is given the server will connect to the default namespace `"/"`.
#[derive(Clone)]
pub struct RawClient {
    /// The inner socket client to delegate the methods to.
    socket: InnerSocket,
    on: Arc<Mutex<HashMap<Event, Callback<SocketCallback>>>>,
    on_any: Arc<Mutex<Option<Callback<SocketAnyCallback>>>>,
    on_close_with_session: Arc<Mutex<Option<Callback<SocketCloseCallback>>>>,
    outstanding_acks: Arc<Mutex<Vec<Ack>>>,
    // namespace, for multiplexing messages
    nsp: String,
    // Data send in the opening packet (commonly used as for auth)
    auth: Option<Value>,
    // Shared session counter: incremented in `connect()` (one session per
    // successful connect); shared across reconnects, which build a fresh
    // RawClient while keeping this counter (issue #15).
    session_epoch: Arc<AtomicU64>,
}

impl RawClient {
    /// Creates a socket with a certain address to connect to as well as a
    /// namespace. If `None` is passed in as namespace, the default namespace
    /// `"/"` is taken.
    /// ```
    pub(crate) fn new<T: Into<String>>(
        socket: InnerSocket,
        namespace: T,
        on: Arc<Mutex<HashMap<Event, Callback<SocketCallback>>>>,
        on_any: Arc<Mutex<Option<Callback<SocketAnyCallback>>>>,
        on_close_with_session: Arc<Mutex<Option<Callback<SocketCloseCallback>>>>,
        session_epoch: Arc<AtomicU64>,
        auth: Option<Value>,
    ) -> Result<Self> {
        Ok(RawClient {
            socket,
            nsp: namespace.into(),
            on,
            on_any,
            on_close_with_session,
            outstanding_acks: Arc::new(Mutex::new(Vec::new())),
            auth,
            session_epoch,
        })
    }

    /// Connects the client to a server. Afterwards the `emit_*` methods can be
    /// called to interact with the server. Attention: it's not allowed to add a
    /// callback after a call to this method.
    pub(crate) fn connect(&self) -> Result<()> {
        // Connect the underlying socket
        self.socket.connect()?;

        let auth = self.auth.as_ref().map(|data| data.to_string());

        // construct the opening packet
        let open_packet = Packet::new(PacketId::Connect, self.nsp.clone(), auth, None, 0, None);

        self.socket.send(open_packet)?;

        // Only a successful handshake + CONNECT counts as a session (issue
        // #15); failed reconnect attempts return via `?` above without
        // bumping the epoch.
        self.session_epoch.fetch_add(1, Ordering::Relaxed);

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
    /// use tf_rust_socketio::{ClientBuilder, RawClient, Payload};
    /// use serde_json::json;
    ///
    /// let mut socket = ClientBuilder::new("http://localhost:4200/")
    ///     .on("test", |payload: Payload, socket: RawClient| {
    ///         println!("Received: {:#?}", payload);
    ///         socket.emit("test", json!({"hello": true})).expect("Server unreachable");
    ///      })
    ///     .connect()
    ///     .expect("connection failed");
    ///
    /// let json_payload = json!({"token": 123});
    ///
    /// let result = socket.emit("foo", json_payload);
    ///
    /// assert!(result.is_ok());
    /// ```
    #[inline]
    pub fn emit<E, D>(&self, event: E, data: D) -> Result<()>
    where
        E: Into<Event>,
        D: Into<Payload>,
    {
        self.socket.emit(&self.nsp, event.into(), data.into())
    }

    /// Example code for handling ACK response when calling emitWithAck on the server
    ///
    /// # Example
    /// ```
    /// use tf_rust_socketio::{ClientBuilder, Payload, RawClient};
    /// use std::time::Duration;
    /// use std::thread::sleep;
    ///
    ///
    /// let ack_callback = |message: Payload, socket: RawClient| {
    ///     match message {
    ///         Payload::Text(values, ack_id) => {
    ///             println!("{:#?}", values);
    ///             // Respond with the specific ack_id
    ///             if let Some(id) = ack_id {
    ///                 socket.ack_with_id(id, "response").unwrap();
    ///             }
    ///         },
    ///         Payload::Binary(bytes, ack_id) => {
    ///             println!("Received bytes: {:#?}", bytes);
    ///             if let Some(id) = ack_id {
    ///                 socket.ack_with_id(id, vec![1, 2, 3]).unwrap();
    ///             }
    ///         },
    ///         // This is deprecated, use Payload::Text instead
    ///         Payload::String(str, ack_id) => {
    ///             println!("{}", str);
    ///             if let Some(id) = ack_id {
    ///                 socket.ack_with_id(id, "response").unwrap();
    ///             }
    ///         },
    ///    }
    /// };
    ///
    /// let mut socket = ClientBuilder::new("http://localhost:4200/")
    ///     .on("foo", ack_callback)
    ///     .connect()
    ///     .expect("connection failed");
    ///
    ///
    ///
    /// sleep(Duration::from_secs(2));
    /// ```
    #[inline]
    pub fn ack<D>(&self, data: D) -> Result<()>
    where
        D: Into<Payload>,
    {
        // For backward compatibility, this method doesn't specify an ack_id
        // It should only be used when there's only one pending ack
        self.socket.ack(&self.nsp, data.into(), None)
    }

    /// Acknowledge a message with a specific ack_id
    #[inline]
    pub fn ack_with_id<D>(&self, ack_id: i32, data: D) -> Result<()>
    where
        D: Into<Payload>,
    {
        self.socket.ack(&self.nsp, data.into(), Some(ack_id))
    }

    /// Disconnects this client from the server by sending a `socket.io` closing
    /// packet.
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder, Payload, RawClient};
    /// use serde_json::json;
    ///
    /// fn handle_test(payload: Payload, socket: RawClient) {
    ///     println!("Received: {:#?}", payload);
    ///     socket.emit("test", json!({"hello": true})).expect("Server unreachable");
    /// }
    ///
    /// let mut socket = ClientBuilder::new("http://localhost:4200/")
    ///     .on("test", handle_test)
    ///     .connect()
    ///     .expect("connection failed");
    ///
    /// let json_payload = json!({"token": 123});
    ///
    /// socket.emit("foo", json_payload);
    ///
    /// // disconnect from the server
    /// socket.disconnect();
    ///
    /// ```
    pub fn disconnect(&self) -> Result<()> {
        let disconnect_packet =
            Packet::new(PacketId::Disconnect, self.nsp.clone(), None, None, 0, None);

        // TODO: logging
        let _ = self.socket.send(disconnect_packet);
        self.socket.disconnect()?;

        // trigger on_close (with the current session's epoch, issue #15)
        self.callback_close(
            CloseReason::IOClientDisconnect.as_str(),
            self.session_epoch.load(Ordering::Relaxed),
        )?;
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
    /// # Example
    /// ```
    /// use tf_rust_socketio::{ClientBuilder, Payload, RawClient};
    /// use serde_json::json;
    /// use std::time::Duration;
    /// use std::thread::sleep;
    ///
    /// let mut socket = ClientBuilder::new("http://localhost:4200/")
    ///     .on("foo", |payload: Payload, _| println!("Received: {:#?}", payload))
    ///     .connect()
    ///     .expect("connection failed");
    ///
    /// let ack_callback = |message: Payload, socket: RawClient| {
    ///     match message {
    ///         Payload::Text(values, _) => println!("{:#?}", values),
    ///         Payload::Binary(bytes, _) => println!("Received bytes: {:#?}", bytes),
    ///         // This is deprecated, use Payload::Text instead
    ///         #[allow(deprecated)]
    ///         Payload::String(str, _) => println!("{}", str),
    ///    }
    /// };
    ///
    /// let payload = json!({"token": 123});
    /// socket.emit_with_ack("foo", payload, Duration::from_secs(2), ack_callback).unwrap();
    ///
    /// sleep(Duration::from_secs(2));
    /// ```
    #[inline]
    pub fn emit_with_ack<F, E, D>(
        &self,
        event: E,
        data: D,
        timeout: Duration,
        callback: F,
    ) -> Result<()>
    where
        F: FnMut(Payload, RawClient) + 'static + Send,
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
            callback: Callback::<SocketCallback>::new(callback),
        };

        // add the ack to the tuple of outstanding acks
        self.outstanding_acks.lock()?.push(ack);

        self.socket.send(socket_packet)?;
        Ok(())
    }

    pub(crate) fn poll(&self) -> Result<Option<Packet>> {
        loop {
            match self.socket.poll() {
                Err(err) => {
                    self.callback(&Event::Error, err.to_string(), None)?;
                    return Err(err);
                }
                Ok(Some(packet)) => {
                    if packet.nsp == self.nsp {
                        self.handle_socketio_packet(&packet)?;
                        return Ok(Some(packet));
                    } else {
                        // Not our namespace continue polling
                    }
                }
                Ok(None) => return Ok(None),
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn iter(&self) -> Iter<'_> {
        Iter { socket: self }
    }

    // NOTE: follow-up of [issue #12](https://github.com/A2C-SMCP/tf-rust-socketio/issues/12).
    // Unlike the async client, this synchronous client keeps the upstream
    // "single reader, strictly serial dispatch" contract — user callbacks run
    // inline on the polling caller's thread. If a long callback is registered,
    // heartbeats and later packets stall here too. The sync side is
    // intentionally out of scope of #12; if the serial contract needs to be
    // relaxed, a per-event worker-thread dispatch (or a documented "no long
    // callbacks" rule) is the follow-up.
    fn callback<P: Into<Payload>>(
        &self,
        event: &Event,
        payload: P,
        ack_id: Option<i32>,
    ) -> Result<()> {
        let mut on = self.on.lock()?;
        let mut on_any = self.on_any.lock()?;
        let lock = on.deref_mut();
        let on_any_lock = on_any.deref_mut();

        let mut payload = payload.into();
        payload.set_ack_id(ack_id);

        if let Some(callback) = lock.get_mut(event) {
            callback(payload.clone(), self.clone());
        }
        match event {
            Event::Message | Event::Custom(_) => {
                if let Some(callback) = on_any_lock {
                    callback(event.clone(), payload, self.clone())
                }
            }
            _ => {}
        }
        drop(on);
        drop(on_any);
        Ok(())
    }

    /// Fires the close chain for the given reason: the legacy
    /// `on(Event::Close)` registration first, then `on_close_with_session`
    /// with this session's epoch (issue #15). The sync client dispatches
    /// inline on a single reader thread, so the epoch is read here — it can
    /// not have been bumped by a concurrent reconnect.
    ///
    /// The close-with-session callback is taken out of the lock and executed
    /// without the mutex held: it receives a `RawClient`, and the natural
    /// cleanup it performs (`disconnect()`) re-enters `callback_close`, which
    /// would deadlock on the non-reentrant std Mutex. The callback is put back
    /// afterwards (same serial dispatch, no lock crossed by user code).
    fn callback_close(&self, reason: &str, epoch: u64) -> Result<()> {
        self.callback(&Event::Close, reason, None)?;

        let callback = {
            let mut close = self.on_close_with_session.lock()?;
            close.take()
        };
        if let Some(mut callback) = callback {
            callback.deref_mut()(Payload::from(reason), epoch, self.clone());
            *self.on_close_with_session.lock()? = Some(callback);
        }

        Ok(())
    }

    /// Handles the incoming acks and classifies what callbacks to call and how.
    #[inline]
    fn handle_ack(&self, socket_packet: &Packet) -> Result<()> {
        let Some(id) = socket_packet.id else {
            return Ok(());
        };

        let outstanding_ack = {
            let mut outstanding_acks = self.outstanding_acks.lock()?;
            outstanding_acks
                .iter()
                .position(|ack| ack.id == id)
                .map(|pos| outstanding_acks.remove(pos))
        };

        // If we found a matching ack, call its callback otherwise ignore it.
        // The official implementation just removes the ack id on timeout:
        // https://github.com/socketio/socket.io-client/blob/main/lib/socket.ts#L467-L495
        if let Some(mut ack) = outstanding_ack {
            if ack.time_started.elapsed() < ack.timeout {
                if let Some(ref payload) = socket_packet.data {
                    let mut payload = Payload::from(payload.to_owned());
                    payload.set_ack_id(socket_packet.id);
                    ack.callback.deref_mut()(payload, self.clone());
                }

                if let Some(ref attachments) = socket_packet.attachments {
                    if let Some(payload) = attachments.first() {
                        let payload = Payload::Binary(payload.to_owned(), socket_packet.id);
                        ack.callback.deref_mut()(payload, self.clone());
                    }
                }
            }
        }

        Ok(())
    }

    /// Handles a binary event.
    #[inline]
    fn handle_binary_event(&self, packet: &Packet) -> Result<()> {
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
                )?;
            }
        }
        Ok(())
    }

    /// A method that parses a packet and eventually calls the corresponding
    /// callback with the supplied data.
    fn handle_event(&self, packet: &Packet) -> Result<()> {
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
                1 => (Event::Message, contents.as_slice()),
                // get rest of data if first is a event
                _ => match contents.first() {
                    Some(Value::String(ev)) => (Event::from(ev.as_str()), &contents[1..]),
                    // get rest(1..) of them as data, not just take the 2nd element
                    _ => (Event::Message, contents.as_slice()),
                    // take them all as data
                },
            };

            // call the correct callback
            self.callback(&event, payloads.to_vec(), packet.id)?;
        }

        Ok(())
    }

    /// Handles the incoming messages and classifies what callbacks to call and how.
    /// This method is later registered as the callback for the `on_data` event of the
    /// engineio client.
    #[inline]
    fn handle_socketio_packet(&self, packet: &Packet) -> Result<()> {
        if packet.nsp == self.nsp {
            match packet.packet_type {
                PacketId::Ack | PacketId::BinaryAck => {
                    if let Err(err) = self.handle_ack(packet) {
                        self.callback(&Event::Error, err.to_string(), None)?;
                        return Err(err);
                    }
                }
                PacketId::BinaryEvent => {
                    if let Err(err) = self.handle_binary_event(packet) {
                        self.callback(&Event::Error, err.to_string(), None)?;
                    }
                }
                PacketId::Connect => {
                    self.callback(&Event::Connect, "", None)?;
                }
                PacketId::Disconnect => {
                    self.callback_close(
                        CloseReason::IOServerDisconnect.as_str(),
                        self.session_epoch.load(Ordering::Relaxed),
                    )?;
                }
                PacketId::ConnectError => {
                    self.callback(
                        &Event::Error,
                        String::from("Received an ConnectError frame: ")
                            + &packet
                                .clone()
                                .data
                                .unwrap_or_else(|| String::from("\"No error message provided\"")),
                        None,
                    )?;
                }
                PacketId::Event => {
                    if let Err(err) = self.handle_event(packet) {
                        self.callback(&Event::Error, err.to_string(), None)?;
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub struct Iter<'a> {
    socket: &'a RawClient,
}

#[cfg(test)]
impl<'a> Iterator for Iter<'a> {
    type Item = Result<Packet>;
    fn next(&mut self) -> std::option::Option<<Self as std::iter::Iterator>::Item> {
        match self.socket.poll() {
            Err(err) => Some(Err(err)),
            Ok(Some(packet)) => Some(Ok(packet)),
            Ok(None) => None,
        }
    }
}

#[cfg(test)]
mod test {
    use std::sync::mpsc;
    use std::thread::sleep;

    use super::*;
    use crate::{client::TransportType, payload::Payload, ClientBuilder};
    use bytes::Bytes;
    use native_tls::TlsConnector;
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn socket_io_integration() -> Result<()> {
        let url = crate::test::socket_io_server();

        let socket = ClientBuilder::new(url)
            .on("test", |msg, _| match msg {
                #[allow(deprecated)]
                Payload::String(str, _) => println!("Received string: {}", str),
                Payload::Text(text, _) => println!("Received json: {:#?}", text),
                Payload::Binary(bin, _) => println!("Received binary data: {:#?}", bin),
            })
            .connect()?;

        let payload = json!({"token": 123});
        #[allow(deprecated)]
        let result = socket.emit("test", Payload::String(payload.to_string(), None));

        assert!(result.is_ok());

        let ack_callback = move |message: Payload, socket: RawClient| {
            let result = socket.emit("test", Payload::Text(vec![json!({"got ack": true})], None));
            assert!(result.is_ok());

            println!("Yehaa! My ack got acked?");
            if let Payload::Text(values, _) = message {
                println!("Received json Ack");
                println!("Ack data: {:#?}", values);
            }
        };

        let ack = socket.emit_with_ack(
            "test",
            Payload::Text(vec![payload], None),
            Duration::from_secs(1),
            ack_callback,
        );
        assert!(ack.is_ok());

        sleep(Duration::from_secs(2));

        assert!(socket.disconnect().is_ok());

        Ok(())
    }

    #[test]
    fn socket_io_builder_integration() -> Result<()> {
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
            .on("test", |str, _| println!("Received: {:#?}", str))
            .on("message", |payload, _| println!("{:#?}", payload))
            .connect()?;

        assert!(socket.emit("message", json!("Hello World")).is_ok());

        assert!(socket.emit("binary", Bytes::from_static(&[46, 88])).is_ok());

        assert!(socket
            .emit_with_ack(
                "binary",
                json!("pls ack"),
                Duration::from_secs(1),
                |payload, _| {
                    println!("Yehaa the ack got acked");
                    println!("With data: {:#?}", payload);
                }
            )
            .is_ok());

        sleep(Duration::from_secs(2));

        Ok(())
    }

    #[test]
    fn socket_io_builder_integration_iterator() -> Result<()> {
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
            .on("test", |str, _| println!("Received: {:#?}", str))
            .on("message", |payload, _| println!("{:#?}", payload))
            .connect_raw()?;

        assert!(socket.emit("message", json!("Hello World")).is_ok());

        assert!(socket.emit("binary", Bytes::from_static(&[46, 88])).is_ok());

        assert!(socket
            .emit_with_ack(
                "binary",
                json!("pls ack"),
                Duration::from_secs(1),
                |payload, _| {
                    println!("Yehaa the ack got acked");
                    println!("With data: {:#?}", payload);
                }
            )
            .is_ok());

        test_socketio_socket(socket, "/admin".to_owned())
    }

    #[test]
    fn socket_io_on_any_integration() -> Result<()> {
        let url = crate::test::socket_io_server();

        let (tx, rx) = mpsc::sync_channel(1);

        let _socket = ClientBuilder::new(url)
            .namespace("/")
            .auth(json!({ "password": "123" }))
            .on("auth", |payload, _client| {
                if let Payload::Text(payload, _) = payload {
                    println!("{:#?}", payload);
                }
            })
            .on_any(move |event, payload, _client| {
                if let Payload::Text(payload, _) = payload {
                    println!("{event} {payload:#?}");
                }
                tx.send(String::from(event)).unwrap();
            })
            .connect()?;

        // Sleep to give server enough time to send 2 events
        sleep(Duration::from_secs(2));

        let event = rx.recv().unwrap();
        assert_eq!(event, "message");
        let event = rx.recv().unwrap();
        assert_eq!(event, "test");

        Ok(())
    }

    #[test]
    fn socket_io_auth_builder_integration() -> Result<()> {
        let url = crate::test::socket_io_auth_server();
        let nsp = String::from("/admin");
        let socket = ClientBuilder::new(url)
            .namespace(nsp.clone())
            .auth(json!({ "password": "123" }))
            .connect_raw()?;

        let mut iter = socket
            .iter()
            .map(|packet| packet.unwrap())
            .filter(|packet| packet.packet_type != PacketId::Connect);

        let packet: Option<Packet> = iter.next();
        assert!(packet.is_some());

        let packet = packet.unwrap();

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

    #[test]
    fn socketio_polling_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let socket = ClientBuilder::new(url)
            .transport_type(TransportType::Polling)
            .connect_raw()?;
        test_socketio_socket(socket, "/".to_owned())
    }

    #[test]
    fn socket_io_websocket_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let socket = ClientBuilder::new(url)
            .transport_type(TransportType::Websocket)
            .connect_raw()?;
        test_socketio_socket(socket, "/".to_owned())
    }

    #[test]
    fn socket_io_websocket_upgrade_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let socket = ClientBuilder::new(url)
            .transport_type(TransportType::WebsocketUpgrade)
            .connect_raw()?;
        test_socketio_socket(socket, "/".to_owned())
    }

    #[test]
    fn socket_io_any_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let socket = ClientBuilder::new(url)
            .transport_type(TransportType::Any)
            .connect_raw()?;
        test_socketio_socket(socket, "/".to_owned())
    }

    fn test_socketio_socket(socket: RawClient, nsp: String) -> Result<()> {
        let mut iter = socket
            .iter()
            .map(|packet| packet.unwrap())
            .filter(|packet| packet.packet_type != PacketId::Connect);

        let packet: Option<Packet> = iter.next();
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

        let packet: Option<Packet> = iter.next();
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

        let packet: Option<Packet> = iter.next();
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

        let packet: Option<Packet> = iter.next();
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

        let packet: Option<Packet> = iter.next();

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

        let packet: Option<Packet> = iter.next();

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

        assert!(socket
            .emit_with_ack(
                "test",
                Payload::from("123"),
                Duration::from_secs(10),
                |message: Payload, _| {
                    println!("Yehaa! My ack got acked?");
                    if let Payload::Text(values, _) = message {
                        println!("Received ack");
                        println!("Ack data: {values:#?}");
                    }
                }
            )
            .is_ok());

        Ok(())
    }

    // TODO: add secure socketio server
}
