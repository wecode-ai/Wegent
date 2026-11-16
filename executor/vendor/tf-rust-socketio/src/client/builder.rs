use super::super::{event::Event, payload::Payload};
use super::callback::Callback;
use super::client::Client;
use crate::RawClient;
use native_tls::TlsConnector;
use tf_rust_engineio::client::ClientBuilder as EngineIoClientBuilder;
use tf_rust_engineio::header::{HeaderMap, HeaderValue};
use url::Url;

use crate::client::callback::{SocketAnyCallback, SocketCallback, SocketCloseCallback};
use crate::error::Result;
use std::collections::HashMap;
use std::sync::{atomic::AtomicU64, Arc, Mutex};

use crate::socket::Socket as InnerSocket;

/// Flavor of Engine.IO transport.
#[derive(Clone, Eq, PartialEq)]
pub enum TransportType {
    /// Handshakes with polling, upgrades if possible
    Any,
    /// Handshakes with websocket. Does not use polling.
    Websocket,
    /// Handshakes with polling, errors if upgrade fails
    WebsocketUpgrade,
    /// Handshakes with polling
    Polling,
}

/// A builder class for a `socket.io` socket. This handles setting up the client and
/// configuring the callback, the namespace and metadata of the socket. If no
/// namespace is specified, the default namespace `/` is taken. The `connect` method
/// acts the `build` method and returns a connected [`Client`].
#[derive(Clone)]
pub struct ClientBuilder {
    pub(crate) address: String,
    on: Arc<Mutex<HashMap<Event, Callback<SocketCallback>>>>,
    on_any: Arc<Mutex<Option<Callback<SocketAnyCallback>>>>,
    on_close_with_session: Arc<Mutex<Option<Callback<SocketCloseCallback>>>>,
    // Session counter shared with every RawClient this builder creates, so it
    // survives reconnects (each reconnect builds a fresh RawClient).
    pub(crate) session_epoch: Arc<AtomicU64>,
    namespace: String,
    tls_config: Option<TlsConnector>,
    opening_headers: Option<HeaderMap>,
    transport_type: TransportType,
    auth: Option<serde_json::Value>,
    pub(crate) reconnect: bool,
    pub(crate) reconnect_on_disconnect: bool,
    // None reconnect attempts represent infinity.
    pub(crate) max_reconnect_attempts: Option<u8>,
    pub(crate) reconnect_delay_min: u64,
    pub(crate) reconnect_delay_max: u64,
}

impl ClientBuilder {
    /// Create as client builder from a URL. URLs must be in the form
    /// `[ws or wss or http or https]://[domain]:[port]/[path]`. The
    /// path of the URL is optional and if no port is given, port 80
    /// will be used.
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder, Payload, RawClient};
    /// use serde_json::json;
    ///
    ///
    /// let callback = |payload: Payload, socket: RawClient| {
    ///            match payload {
    ///                Payload::Text(values, _) => println!("Received: {:#?}", values),
    ///                Payload::Binary(bin_data, _) => println!("Received bytes: {:#?}", bin_data),
    ///                // This payload type is deprecated, use Payload::Text instead
    ///                #[allow(deprecated)]
    ///                Payload::String(str, _) => println!("Received: {}", str),
    ///            }
    /// };
    ///
    /// let mut socket = ClientBuilder::new("http://localhost:4200")
    ///     .namespace("/admin")
    ///     .on("test", callback)
    ///     .connect()
    ///     .expect("error while connecting");
    ///
    /// // use the socket
    /// let json_payload = json!({"token": 123});
    ///
    /// let result = socket.emit("foo", json_payload);
    ///
    /// assert!(result.is_ok());
    /// ```
    pub fn new<T: Into<String>>(address: T) -> Self {
        Self {
            address: address.into(),
            on: Arc::new(Mutex::new(HashMap::new())),
            on_any: Arc::new(Mutex::new(None)),
            on_close_with_session: Arc::new(Mutex::new(None)),
            session_epoch: Arc::new(AtomicU64::new(0)),
            namespace: "/".to_owned(),
            tls_config: None,
            opening_headers: None,
            transport_type: TransportType::Any,
            auth: None,
            reconnect: true,
            reconnect_on_disconnect: false,
            // None means infinity
            max_reconnect_attempts: None,
            reconnect_delay_min: 1000,
            reconnect_delay_max: 5000,
        }
    }

    /// Sets the target namespace of the client. The namespace should start
    /// with a leading `/`. Valid examples are e.g. `/admin`, `/foo`.
    pub fn namespace<T: Into<String>>(mut self, namespace: T) -> Self {
        let mut nsp = namespace.into();
        if !nsp.starts_with('/') {
            nsp = "/".to_owned() + &nsp;
        }
        self.namespace = nsp;
        self
    }

    pub fn reconnect(mut self, reconnect: bool) -> Self {
        self.reconnect = reconnect;
        self
    }

    /// If set to `true` automatically set try to reconnect when the server
    /// disconnects the client.
    /// Defaults to `false`.
    ///
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::ClientBuilder;
    ///
    /// let socket = ClientBuilder::new("http://localhost:4200/")
    ///     .reconnect_on_disconnect(true)
    ///     .connect();
    /// ```
    pub fn reconnect_on_disconnect(mut self, reconnect_on_disconnect: bool) -> Self {
        self.reconnect_on_disconnect = reconnect_on_disconnect;
        self
    }

    pub fn reconnect_delay(mut self, min: u64, max: u64) -> Self {
        self.reconnect_delay_min = min;
        self.reconnect_delay_max = max;

        self
    }

    pub fn max_reconnect_attempts(mut self, reconnect_attempts: u8) -> Self {
        self.max_reconnect_attempts = Some(reconnect_attempts);
        self
    }

    /// Registers a new callback for a certain [`crate::event::Event`]. The event could either be
    /// one of the common events like `message`, `error`, `open`, `close` or a custom
    /// event defined by a string, e.g. `onPayment` or `foo`.
    ///
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder, Payload};
    ///
    /// let socket = ClientBuilder::new("http://localhost:4200/")
    ///     .namespace("/admin")
    ///     .on("test", |payload: Payload, _| {
    ///            match payload {
    ///                Payload::Text(values, _) => println!("Received: {:#?}", values),
    ///                Payload::Binary(bin_data, _) => println!("Received bytes: {:#?}", bin_data),
    ///                // This payload type is deprecated, use Payload::Text instead
    ///                #[allow(deprecated)]
    ///                Payload::String(str, _) => println!("Received: {}", str),
    ///            }
    ///     })
    ///     .on("error", |err, _| eprintln!("Error: {:#?}", err))
    ///     .connect();
    ///
    /// ```
    // While present implementation doesn't require mut, it's reasonable to require mutability.
    #[allow(unused_mut)]
    pub fn on<T: Into<Event>, F>(mut self, event: T, callback: F) -> Self
    where
        F: FnMut(Payload, RawClient) + 'static + Send,
    {
        let callback = Callback::<SocketCallback>::new(callback);
        // SAFETY: Lock is held for such amount of time no code paths lead to a panic while lock is held
        self.on.lock().unwrap().insert(event.into(), callback);
        self
    }

    /// Registers a Callback for all [`crate::event::Event::Custom`] and [`crate::event::Event::Message`].
    ///
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder, Payload};
    ///
    /// let client = ClientBuilder::new("http://localhost:4200/")
    ///     .namespace("/admin")
    ///     .on_any(|event, payload, _client| {
    ///         #[allow(deprecated)]
    ///         if let Payload::String(str, _) = payload {
    ///           println!("{} {}", String::from(event), str);
    ///         }
    ///     })
    ///     .connect();
    ///
    /// ```
    // While present implementation doesn't require mut, it's reasonable to require mutability.
    #[allow(unused_mut)]
    pub fn on_any<F>(mut self, callback: F) -> Self
    where
        F: FnMut(Event, Payload, RawClient) + 'static + Send,
    {
        let callback = Some(Callback::<SocketAnyCallback>::new(callback));
        // SAFETY: Lock is held for such amount of time no code paths lead to a panic while lock is held
        *self.on_any.lock().unwrap() = callback;
        self
    }

    /// Registers a close callback that carries the session epoch of the dying
    /// session. The existing `on(Event::Close, ...)` chain keeps firing; both
    /// may be registered at the same time.
    ///
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::ClientBuilder;
    ///
    /// let client = ClientBuilder::new("http://localhost:4200/")
    ///     .on_close_with_session(|payload, epoch, _client| {
    ///         println!("{:?} from session {epoch}", payload);
    ///     })
    ///     .connect();
    /// ```
    #[allow(unused_mut)]
    pub fn on_close_with_session<F>(mut self, callback: F) -> Self
    where
        F: FnMut(Payload, u64, RawClient) + 'static + Send,
    {
        let callback = Some(Callback::<SocketCloseCallback>::new(callback));
        // SAFETY: Lock is held for such amount of time no code paths lead to a panic while lock is held
        *self.on_close_with_session.lock().unwrap() = callback;
        self
    }

    /// Uses a preconfigured TLS connector for secure communication. This configures
    /// both the `polling` as well as the `websocket` transport type.
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder, Payload};
    /// use native_tls::TlsConnector;
    ///
    /// let tls_connector =  TlsConnector::builder()
    ///            .use_sni(true)
    ///            .build()
    ///            .expect("Found illegal configuration");
    ///
    /// let socket = ClientBuilder::new("http://localhost:4200/")
    ///     .namespace("/admin")
    ///     .on("error", |err, _| eprintln!("Error: {:#?}", err))
    ///     .tls_config(tls_connector)
    ///     .connect();
    ///
    /// ```
    pub fn tls_config(mut self, tls_config: TlsConnector) -> Self {
        self.tls_config = Some(tls_config);
        self
    }

    /// Sets custom http headers for the opening request. The headers will be passed to the underlying
    /// transport type (either websockets or polling) and then get passed with every request thats made.
    /// via the transport layer.
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder, Payload};
    ///
    ///
    /// let socket = ClientBuilder::new("http://localhost:4200/")
    ///     .namespace("/admin")
    ///     .on("error", |err, _| eprintln!("Error: {:#?}", err))
    ///     .opening_header("accept-encoding", "application/json")
    ///     .connect();
    ///
    /// ```
    pub fn opening_header<T: Into<HeaderValue>, K: Into<String>>(mut self, key: K, val: T) -> Self {
        match self.opening_headers {
            Some(ref mut map) => {
                map.insert(key.into(), val.into());
            }
            None => {
                let mut map = HeaderMap::default();
                map.insert(key.into(), val.into());
                self.opening_headers = Some(map);
            }
        }
        self
    }

    /// Sets data sent in the opening request.
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder};
    /// use serde_json::json;
    ///
    /// let socket = ClientBuilder::new("http://localhost:4204/")
    ///     .namespace("/admin")
    ///     .auth(json!({ "password": "1337" }))
    ///     .on("error", |err, _| eprintln!("Error: {:#?}", err))
    ///     .connect()
    ///     .expect("Connection error");
    ///
    /// ```
    pub fn auth(mut self, auth: serde_json::Value) -> Self {
        self.auth = Some(auth);

        self
    }

    /// Specifies which EngineIO [`TransportType`] to use.
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder, TransportType};
    /// use serde_json::json;
    ///
    /// let socket = ClientBuilder::new("http://localhost:4200/")
    ///     // Use websockets to handshake and connect.
    ///     .transport_type(TransportType::Websocket)
    ///     .connect()
    ///     .expect("connection failed");
    ///
    /// // use the socket
    /// let json_payload = json!({"token": 123});
    ///
    /// let result = socket.emit("foo", json_payload);
    ///
    /// assert!(result.is_ok());
    /// ```
    pub fn transport_type(mut self, transport_type: TransportType) -> Self {
        self.transport_type = transport_type;

        self
    }

    /// Connects the socket to a certain endpoint. This returns a connected
    /// [`Client`] instance. This method returns an [`std::result::Result::Err`]
    /// value if something goes wrong during connection. Also starts a separate
    /// thread to start polling for packets. Used with callbacks.
    /// # Example
    /// ```rust
    /// use tf_rust_socketio::{ClientBuilder, Payload};
    /// use serde_json::json;
    ///
    ///
    /// let mut socket = ClientBuilder::new("http://localhost:4200/")
    ///     .namespace("/admin")
    ///     .on("error", |err, _| eprintln!("Client error!: {:#?}", err))
    ///     .connect()
    ///     .expect("connection failed");
    ///
    /// // use the socket
    /// let json_payload = json!({"token": 123});
    ///
    /// let result = socket.emit("foo", json_payload);
    ///
    /// assert!(result.is_ok());
    /// ```
    pub fn connect(self) -> Result<Client> {
        Client::new(self)
    }

    pub fn connect_raw(self) -> Result<RawClient> {
        // Parse url here rather than in new to keep new returning Self.
        let mut url = Url::parse(&self.address)?;

        if url.path() == "/" {
            url.set_path("/socket.io/");
        }

        let mut builder = EngineIoClientBuilder::new(url);

        if let Some(tls_config) = self.tls_config {
            builder = builder.tls_config(tls_config);
        }
        if let Some(headers) = self.opening_headers {
            builder = builder.headers(headers);
        }

        let engine_client = match self.transport_type {
            TransportType::Any => builder.build_with_fallback()?,
            TransportType::Polling => builder.build_polling()?,
            TransportType::Websocket => builder.build_websocket()?,
            TransportType::WebsocketUpgrade => builder.build_websocket_with_upgrade()?,
        };

        let inner_socket = InnerSocket::new(engine_client)?;

        let socket = RawClient::new(
            inner_socket,
            &self.namespace,
            self.on,
            self.on_any,
            self.on_close_with_session,
            self.session_epoch,
            self.auth,
        )?;
        socket.connect()?;

        Ok(socket)
    }
}
