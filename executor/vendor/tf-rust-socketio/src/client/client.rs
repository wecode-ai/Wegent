use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};

use super::{ClientBuilder, RawClient};
use crate::{
    error::Result,
    packet::{Packet, PacketId},
    Error,
};
pub(crate) use crate::{event::Event, payload::Payload};
use backoff::ExponentialBackoff;
use backoff::{backoff::Backoff, ExponentialBackoffBuilder};

#[derive(Clone)]
pub struct Client {
    builder: Arc<Mutex<ClientBuilder>>,
    client: Arc<RwLock<RawClient>>,
    backoff: ExponentialBackoff,
    // Shared session counter (issue #15): lives on the builder so it survives
    // reconnects, each of which builds a fresh RawClient.
    session_epoch: Arc<AtomicU64>,
}

impl Client {
    pub(crate) fn new(builder: ClientBuilder) -> Result<Self> {
        let builder_clone = builder.clone();
        let client = builder_clone.connect_raw()?;
        let session_epoch = builder.session_epoch.clone();
        let backoff = ExponentialBackoffBuilder::new()
            .with_initial_interval(Duration::from_millis(builder.reconnect_delay_min))
            .with_max_interval(Duration::from_millis(builder.reconnect_delay_max))
            .build();

        let s = Self {
            builder: Arc::new(Mutex::new(builder)),
            client: Arc::new(RwLock::new(client)),
            backoff,
            session_epoch,
        };
        s.poll_callback();

        Ok(s)
    }

    /// Returns the current session epoch: the number of successfully connected
    /// sessions during this client's lifetime (starting at 1 after the initial
    /// connect, incremented by every successful reconnect). Every close
    /// delivered by [`ClientBuilder::on_close_with_session`] carries the epoch
    /// of the session whose transport actually died (issue #15).
    ///
    /// # Example
    /// ```
    /// use tf_rust_socketio::ClientBuilder;
    ///
    /// let socket = ClientBuilder::new("http://localhost:4200/")
    ///     .connect()
    ///     .expect("connection failed");
    /// println!("current session: {}", socket.session_epoch());
    /// ```
    pub fn session_epoch(&self) -> u64 {
        self.session_epoch.load(Ordering::Relaxed)
    }

    /// Updates the URL the client will connect to when reconnecting.
    /// This is especially useful for updating query parameters.
    pub fn set_reconnect_url<T: Into<String>>(&self, address: T) -> Result<()> {
        self.builder.lock()?.address = address.into();
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
    pub fn emit<E, D>(&self, event: E, data: D) -> Result<()>
    where
        E: Into<Event>,
        D: Into<Payload>,
    {
        let client = self.client.read()?;
        // TODO(#230): like js client, buffer emit, resend after reconnect
        client.emit(event, data)
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
    ///         // This is deprecated, use Payload::Text instead.
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
        let client = self.client.read()?;
        // TODO(#230): like js client, buffer emit, resend after reconnect
        client.emit_with_ack(event, data, timeout, callback)
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
        let client = self.client.read()?;
        client.disconnect()
    }

    fn reconnect(&mut self) -> Result<()> {
        let mut reconnect_attempts = 0;
        let (reconnect, max_reconnect_attempts) = {
            let builder = self.builder.lock()?;
            (builder.reconnect, builder.max_reconnect_attempts)
        };

        if reconnect {
            loop {
                if let Some(max_reconnect_attempts) = max_reconnect_attempts {
                    reconnect_attempts += 1;
                    if reconnect_attempts > max_reconnect_attempts {
                        break;
                    }
                }

                if let Some(backoff) = self.backoff.next_backoff() {
                    std::thread::sleep(backoff);
                }

                if self.do_reconnect().is_ok() {
                    break;
                }
            }
        }

        Ok(())
    }

    fn do_reconnect(&self) -> Result<()> {
        let builder = self.builder.lock()?;
        let new_client = builder.clone().connect_raw()?;
        let mut client = self.client.write()?;
        *client = new_client;

        Ok(())
    }

    pub(crate) fn iter(&self) -> Iter {
        Iter {
            socket: self.client.clone(),
        }
    }

    fn poll_callback(&self) {
        let mut self_clone = self.clone();
        // Use thread to consume items in iterator in order to call callbacks
        std::thread::spawn(move || {
            // tries to restart a poll cycle whenever a 'normal' error occurs,
            // it just panics on network errors, in case the poll cycle returned
            // `Result::Ok`, the server receives a close frame so it's safe to
            // terminate
            for packet in self_clone.iter() {
                let should_reconnect = match packet {
                    Err(Error::IncompleteResponseFromEngineIo(_)) => {
                        //TODO: 0.3.X handle errors
                        //TODO: logging error
                        true
                    }
                    Ok(Packet {
                        packet_type: PacketId::Disconnect,
                        ..
                    }) => match self_clone.builder.lock() {
                        Ok(builder) => builder.reconnect_on_disconnect,
                        Err(_) => false,
                    },
                    _ => false,
                };
                if should_reconnect {
                    let _ = self_clone.disconnect();
                    let _ = self_clone.reconnect();
                }
            }
        });
    }
}

pub(crate) struct Iter {
    socket: Arc<RwLock<RawClient>>,
}

impl Iterator for Iter {
    type Item = Result<Packet>;

    fn next(&mut self) -> Option<Self::Item> {
        let socket = self.socket.read();
        match socket {
            Ok(socket) => match socket.poll() {
                Err(err) => Some(Err(err)),
                Ok(Some(packet)) => Some(Ok(packet)),
                // If the underlying engineIO connection is closed,
                // throw an error so we know to reconnect
                Ok(None) => Some(Err(Error::StoppedEngineIoSocket)),
            },
            Err(_) => {
                // Lock is poisoned, our iterator is useless.
                None
            }
        }
    }
}

#[cfg(test)]
mod test {
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::UNIX_EPOCH,
    };

    use super::*;
    use crate::error::Result;
    use crate::ClientBuilder;
    use serde_json::json;
    use serial_test::serial;
    use std::time::{Duration, SystemTime};
    use url::Url;

    #[test]
    #[serial(reconnect)]
    fn socket_io_reconnect_integration() -> Result<()> {
        static CONNECT_NUM: AtomicUsize = AtomicUsize::new(0);
        static CLOSE_NUM: AtomicUsize = AtomicUsize::new(0);
        static MESSAGE_NUM: AtomicUsize = AtomicUsize::new(0);

        let url = crate::test::socket_io_restart_server();

        let socket = ClientBuilder::new(url)
            .reconnect(true)
            .max_reconnect_attempts(100)
            .reconnect_delay(100, 100)
            .on(Event::Connect, move |_, socket| {
                CONNECT_NUM.fetch_add(1, Ordering::Release);
                let r = socket.emit_with_ack(
                    "message",
                    json!(""),
                    Duration::from_millis(100),
                    |_, _| {},
                );
                assert!(r.is_ok(), "should emit message success");
            })
            .on(Event::Close, move |_, _| {
                CLOSE_NUM.fetch_add(1, Ordering::Release);
            })
            .on("message", move |_, _socket| {
                // test the iterator implementation and make sure there is a constant
                // stream of packets, even when reconnecting
                MESSAGE_NUM.fetch_add(1, Ordering::Release);
            })
            .connect();

        assert!(socket.is_ok(), "should connect success");
        let socket = socket.unwrap();

        // waiting for server to emit message
        std::thread::sleep(std::time::Duration::from_millis(500));

        assert_eq!(load(&CONNECT_NUM), 1, "should connect once");
        assert_eq!(load(&MESSAGE_NUM), 1, "should receive one");
        assert_eq!(load(&CLOSE_NUM), 0, "should not close");

        let r = socket.emit("restart_server", json!(""));
        assert!(r.is_ok(), "should emit restart success");

        // waiting for server to restart
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            if load(&CONNECT_NUM) == 2 && load(&MESSAGE_NUM) == 2 {
                break;
            }
        }

        assert_eq!(load(&CONNECT_NUM), 2, "should connect twice");
        assert_eq!(load(&MESSAGE_NUM), 2, "should receive two messages");
        assert_eq!(load(&CLOSE_NUM), 1, "should close once");

        socket.disconnect()?;
        Ok(())
    }

    #[test]
    #[serial(reconnect)]
    fn session_epoch_increments_on_successful_reconnect() -> Result<()> {
        static CONNECT_NUM: AtomicUsize = AtomicUsize::new(0);
        let url = crate::test::socket_io_restart_server();

        // The restart-driven close fires while the dying session is still the
        // current one: the sync reader thread disconnects (close) before it
        // reconnects (epoch bump), so the close must carry epoch 1.
        let close_epoch = Arc::new(std::sync::Mutex::new(None::<u64>));
        let close_epoch_cb = close_epoch.clone();

        let socket = ClientBuilder::new(url)
            .reconnect(true)
            .max_reconnect_attempts(100)
            .reconnect_delay(100, 100)
            .on(Event::Connect, move |_, _| {
                CONNECT_NUM.fetch_add(1, Ordering::Release);
            })
            .on_close_with_session(move |_payload, epoch, _client| {
                *close_epoch_cb.lock().unwrap() = Some(epoch);
            })
            .connect()?;

        assert_eq!(socket.session_epoch(), 1, "initial connect = epoch 1");

        // waiting for server to emit and settle
        std::thread::sleep(Duration::from_millis(500));
        socket.emit("restart_server", json!(""))?;

        // waiting for server to restart and the client to reconnect
        for _ in 0..15 {
            std::thread::sleep(Duration::from_millis(400));
            if CONNECT_NUM.load(Ordering::Acquire) == 2 {
                break;
            }
        }

        assert_eq!(
            CONNECT_NUM.load(Ordering::Acquire),
            2,
            "should reconnect once"
        );
        assert_eq!(socket.session_epoch(), 2, "successful reconnect = epoch 2");
        assert_eq!(
            *close_epoch.lock().unwrap(),
            Some(1),
            "restart close must carry the dying session's epoch"
        );

        socket.disconnect()?;
        Ok(())
    }

    #[test]
    fn on_close_with_session_server_disconnect_epoch() -> Result<()> {
        // The 4206 restart-url-auth server closes the socket when the
        // handshake timestamp is invalid (ci/socket-io-restart-url-auth.js),
        // so the client receives a socket.io Disconnect packet and the
        // IOServerDisconnect close chain fires with the current epoch.
        let mut url = crate::test::socket_io_restart_url_auth_server();
        url.set_query(Some("timestamp=1"));

        let fired = Arc::new(AtomicUsize::new(0));
        let record = Arc::new(std::sync::Mutex::new(None::<(Payload, u64)>));
        let fired_cb = fired.clone();
        let record_cb = record.clone();
        // Both close chains must fire on the same close, legacy first.
        let order = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
        let order_legacy = order.clone();
        let order_new = order.clone();

        let socket = ClientBuilder::new(url)
            .on(Event::Close, move |_, _| {
                order_legacy.lock().unwrap().push("legacy");
            })
            .on_close_with_session(move |payload, epoch, _client| {
                order_new.lock().unwrap().push("new");
                fired_cb.fetch_add(1, Ordering::Release);
                *record_cb.lock().unwrap() = Some((payload, epoch));
            })
            .connect()?;

        // wait for the server-side disconnect packet to be processed
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(200));
            if fired.load(Ordering::Acquire) == 1 {
                break;
            }
        }

        assert_eq!(
            fired.load(Ordering::Acquire),
            1,
            "close callback did not fire"
        );
        assert_eq!(
            *order.lock().unwrap(),
            ["legacy", "new"],
            "both close chains must fire, legacy first"
        );
        let (payload, epoch) = record
            .lock()
            .unwrap()
            .take()
            .expect("close callback did not record");
        assert_eq!(
            payload,
            Payload::from(crate::CloseReason::IOServerDisconnect.as_str())
        );
        assert_eq!(epoch, 1, "server-disconnect close = current session epoch");
        assert_eq!(socket.session_epoch(), 1);

        socket.disconnect()?;
        Ok(())
    }

    #[test]
    fn socket_io_reconnect_url_auth_integration() -> Result<()> {
        static CONNECT_NUM: AtomicUsize = AtomicUsize::new(0);
        static CLOSE_NUM: AtomicUsize = AtomicUsize::new(0);
        static MESSAGE_NUM: AtomicUsize = AtomicUsize::new(0);

        fn get_url() -> Url {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            let mut url = crate::test::socket_io_restart_url_auth_server();
            url.set_query(Some(&format!("timestamp={timestamp}")));
            url
        }

        let socket = ClientBuilder::new(get_url())
            .reconnect(true)
            .max_reconnect_attempts(100)
            .reconnect_delay(100, 100)
            .on(Event::Connect, move |_, socket| {
                CONNECT_NUM.fetch_add(1, Ordering::Release);
                let result = socket.emit_with_ack(
                    "message",
                    json!(""),
                    Duration::from_millis(100),
                    |_, _| {},
                );
                assert!(result.is_ok(), "should emit message success");
            })
            .on(Event::Close, move |_, _| {
                CLOSE_NUM.fetch_add(1, Ordering::Release);
            })
            .on("message", move |_, _| {
                // test the iterator implementation and make sure there is a constant
                // stream of packets, even when reconnecting
                MESSAGE_NUM.fetch_add(1, Ordering::Release);
            })
            .connect();

        assert!(socket.is_ok(), "should connect success");
        let socket = socket.unwrap();

        // waiting for server to emit message
        std::thread::sleep(std::time::Duration::from_millis(500));

        assert_eq!(load(&CONNECT_NUM), 1, "should connect once");
        assert_eq!(load(&MESSAGE_NUM), 1, "should receive one");
        assert_eq!(load(&CLOSE_NUM), 0, "should not close");

        // waiting for timestamp in url to expire
        std::thread::sleep(std::time::Duration::from_secs(1));

        socket.set_reconnect_url(get_url())?;

        let result = socket.emit("restart_server", json!(""));
        assert!(result.is_ok(), "should emit restart success");

        // waiting for server to restart
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            if load(&CONNECT_NUM) == 2 && load(&MESSAGE_NUM) == 2 {
                break;
            }
        }

        assert_eq!(load(&CONNECT_NUM), 2, "should connect twice");
        assert_eq!(load(&MESSAGE_NUM), 2, "should receive two messages");
        assert_eq!(load(&CLOSE_NUM), 1, "should close once");

        socket.disconnect()?;
        Ok(())
    }

    #[test]
    fn socket_io_iterator_integration() -> Result<()> {
        let url = crate::test::socket_io_server();
        let builder = ClientBuilder::new(url);
        let builder_clone = builder.clone();

        let client = Arc::new(RwLock::new(builder_clone.connect_raw()?));
        let mut socket = Client {
            builder: Arc::new(Mutex::new(builder)),
            client,
            backoff: Default::default(),
            session_epoch: Arc::new(AtomicU64::new(0)),
        };
        let socket_clone = socket.clone();

        let packets: Arc<RwLock<Vec<Packet>>> = Default::default();
        let packets_clone = packets.clone();

        std::thread::spawn(move || {
            for packet in socket_clone.iter() {
                {
                    let mut packets = packets_clone.write().unwrap();
                    if let Ok(packet) = packet {
                        (*packets).push(packet);
                    }
                }
            }
        });

        // waiting for client to emit messages
        std::thread::sleep(Duration::from_millis(100));
        let lock = packets.read().unwrap();
        let pre_num = lock.len();
        drop(lock);

        let _ = socket.disconnect();
        socket.reconnect()?;

        // waiting for client to emit messages
        std::thread::sleep(Duration::from_millis(100));

        let lock = packets.read().unwrap();
        let post_num = lock.len();
        drop(lock);

        assert!(
            pre_num < post_num,
            "pre_num {} should less than post_num {}",
            pre_num,
            post_num
        );

        Ok(())
    }

    fn load(num: &AtomicUsize) -> usize {
        num.load(Ordering::Acquire)
    }
}
