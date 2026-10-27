//! Rust-socket.io is a socket.io client written in the Rust Programming Language.
//! ## Example usage
//!
//! ``` rust
//! use tf_rust_socketio::{ClientBuilder, Payload, RawClient};
//! use serde_json::json;
//! use std::time::Duration;
//!
//! // define a callback which is called when a payload is received
//! // this callback gets the payload as well as an instance of the
//! // socket to communicate with the server
//! let callback = |payload: Payload, socket: RawClient| {
//!        match payload {
//!            Payload::Text(values, _) => println!("Received: {:#?}", values),
//!            Payload::Binary(bin_data, _) => println!("Received bytes: {:#?}", bin_data),
//!            // This variant is deprecated, use Payload::Text instead
//!            #[allow(deprecated)]
//!            Payload::String(str, _) => println!("Received: {}", str),
//!        }
//!        socket.emit("test", json!({"got ack": true})).expect("Server unreachable")
//! };
//!
//! // get a socket that is connected to the admin namespace
//! let mut socket = ClientBuilder::new("http://localhost:4200/")
//!      .namespace("/admin")
//!      .on("test", callback)
//!      .on("error", |err, _| eprintln!("Error: {:#?}", err))
//!      .connect()
//!      .expect("Connection failed");
//!
//! // emit to the "foo" event
//! let json_payload = json!({"token": 123});
//!
//! socket.emit("foo", json_payload).expect("Server unreachable");
//!
//! // define a callback, that's executed when the ack got acked
//! let ack_callback = |message: Payload, _: RawClient| {
//!     println!("Yehaa! My ack got acked?");
//!     println!("Ack data: {:#?}", message);
//! };
//!
//! let json_payload = json!({"myAckData": 123});
//!
//! // emit with an ack
//! let ack = socket
//!     .emit_with_ack("test", json_payload, Duration::from_secs(2), ack_callback)
//!     .expect("Server unreachable");
//! ```
//!
//! The main entry point for using this crate is the [`ClientBuilder`] which provides
//! a way to easily configure a socket in the needed way. When the `connect` method
//! is called on the builder, it returns a connected client which then could be used
//! to emit messages to certain events. One client can only be connected to one namespace.
//! If you need to listen to the messages in different namespaces you need to
//! allocate multiple sockets.
//!
//! ## Current features
//!
//! This implementation now supports all of the features of the socket.io protocol mentioned
//! [here](https://github.com/socketio/socket.io-protocol).
//! It generally tries to make use of websockets as often as possible. This means most times
//! only the opening request uses http and as soon as the server mentions that he is able to use
//! websockets, an upgrade  is performed. But if this upgrade is not successful or the server
//! does not mention an upgrade possibility, http-long polling is used (as specified in the protocol specs).
//!
//! Here's an overview of possible use-cases:
//!
//! - connecting to a server.
//! - register callbacks for the following event types:
//!     - open
//!     - close
//!     - error
//!     - message
//!     - custom events like "foo", "on_payment", etc.
//! - send JSON data to the server (via `serde_json` which provides safe
//! handling).
//! - send JSON data to the server and receive an `ack`.
//! - send and handle Binary data.
#![cfg_attr(
    feature = "async",
    doc = r#"
## Async version
This library provides an ability for being executed in an asynchronous context using `tokio` as
the execution runtime.
Please note that the current async implementation is in beta, the interface can be object to
drastic changes.
The async `Client` and `ClientBuilder` support a similar interface to the sync version and live
in the [`asynchronous`] module. In order to enable the support, you need to enable the `async`
feature flag:
```toml
tf_rust_socketio = { version = "^0.4.1", features = ["async"] }
```

The following code shows the example above in async fashion:

``` rust
use futures_util::FutureExt;
use tf_rust_socketio::{
    asynchronous::{Client, ClientBuilder},
    Payload,
};
use serde_json::json;
use std::time::Duration;

#[tokio::main]
async fn main() {
    // define a callback which is called when a payload is received
    // this callback gets the payload as well as an instance of the
    // socket to communicate with the server
    let callback = |payload: Payload, socket: Client| {
        async move {
            match payload {
                Payload::Text(values, _) => println!("Received: {:#?}", values),
                Payload::Binary(bin_data, _) => println!("Received bytes: {:#?}", bin_data),
                // This is deprecated use Payload::Text instead
                #[allow(deprecated)]
                Payload::String(str, _) => println!("Received: {}", str),
            }
            socket
                .emit("test", json!({"got ack": true}))
                .await
                .expect("Server unreachable");
        }
        .boxed()
    };

    // get a socket that is connected to the admin namespace
    let socket = ClientBuilder::new("http://localhost:4200/")
        .namespace("/admin")
        .on("test", callback)
        .on("error", |err, _| {
            async move { eprintln!("Error: {:#?}", err) }.boxed()
        })
        .connect()
        .await
        .expect("Connection failed");

    // emit to the "foo" event
    let json_payload = json!({"token": 123});
    socket
        .emit("foo", json_payload)
        .await
        .expect("Server unreachable");

    // define a callback, that's executed when the ack got acked
    let ack_callback = |message: Payload, _: Client| {
        async move {
            println!("Yehaa! My ack got acked?");
            println!("Ack data: {:#?}", message);
        }
        .boxed()
    };

    let json_payload = json!({"myAckData": 123});
    // emit with an ack
    socket
        .emit_with_ack("test", json_payload, Duration::from_secs(2), ack_callback)
        .await
        .expect("Server unreachable");

    socket.disconnect().await.expect("Disconnect failed");
}
```"#
)]
#![allow(clippy::rc_buffer)]
#![warn(clippy::complexity)]
#![warn(clippy::style)]
#![warn(clippy::perf)]
#![warn(clippy::correctness)]
// Allow large error types - Error enum contains rich context from engineio
// which is intentional for debugging. Boxing would add indirection overhead.
#![allow(clippy::result_large_err)]

mod ack_id;
/// Defines client only structs
pub mod client;
/// Deprecated import since 0.3.0-alpha-2, use Event in the crate root instead.
/// Defines the events that could be sent or received.
pub mod event;
pub(crate) mod packet;
/// Deprecated import since 0.3.0-alpha-2, use Event in the crate root instead.
/// Defines the types of payload (binary or string), that
/// could be sent or received.
pub mod payload;
mod socket;

/// Deprecated import since 0.3.0-alpha-2, use Error in the crate root instead.
/// Contains the error type which will be returned with every result in this
/// crate.
pub mod error;

#[cfg(test)]
mod test_concurrent_ack;

#[cfg(test)]
#[cfg(feature = "async")]
mod test_async_concurrent_ack;

#[cfg(feature = "async")]
/// Asynchronous version of the socket.io client. This module contains the async
/// [`crate::asynchronous::Client`] as well as a builder
/// ([`crate::asynchronous::ClientBuilder`]) that allows for configuring a client.
pub mod asynchronous;

pub use error::Error;

pub use {event::CloseReason, event::Event, payload::Payload};

pub use client::{ClientBuilder, RawClient, TransportType};

// TODO: 0.4.0 remove
#[deprecated(since = "0.3.0-alpha-2", note = "Socket renamed to Client")]
pub use client::{ClientBuilder as SocketBuilder, RawClient as Socket};

#[cfg(test)]
pub(crate) mod test {
    use url::Url;

    /// The socket.io server for testing runs on port 4200
    const SERVER_URL: &str = "http://localhost:4200";

    pub(crate) fn socket_io_server() -> Url {
        let url = std::env::var("SOCKET_IO_SERVER").unwrap_or_else(|_| SERVER_URL.to_owned());
        let mut url = Url::parse(&url).unwrap();

        if url.path() == "/" {
            url.set_path("/socket.io/");
        }

        url
    }

    // The socket.io auth server for testing runs on port 4204
    const AUTH_SERVER_URL: &str = "http://localhost:4204";

    pub(crate) fn socket_io_auth_server() -> Url {
        let url =
            std::env::var("SOCKET_IO_AUTH_SERVER").unwrap_or_else(|_| AUTH_SERVER_URL.to_owned());
        let mut url = Url::parse(&url).unwrap();

        if url.path() == "/" {
            url.set_path("/socket.io/");
        }

        url
    }

    // The socket.io restart server for testing runs on port 4205
    const RESTART_SERVER_URL: &str = "http://localhost:4205";

    pub(crate) fn socket_io_restart_server() -> Url {
        let url = std::env::var("SOCKET_IO_RESTART_SERVER")
            .unwrap_or_else(|_| RESTART_SERVER_URL.to_owned());
        let mut url = Url::parse(&url).unwrap();

        if url.path() == "/" {
            url.set_path("/socket.io/");
        }

        url
    }

    // The socket.io restart url auth server for testing runs on port 4206
    const RESTART_URL_AUTH_SERVER_URL: &str = "http://localhost:4206";

    pub(crate) fn socket_io_restart_url_auth_server() -> Url {
        let url = std::env::var("SOCKET_IO_RESTART_URL_AUTH_SERVER")
            .unwrap_or_else(|_| RESTART_URL_AUTH_SERVER_URL.to_owned());
        let mut url = Url::parse(&url).unwrap();

        if url.path() == "/" {
            url.set_path("/socket.io/");
        }

        url
    }

    // The socket.io fast heartbeat server for testing runs on port 4207
    const FAST_PING_SERVER_URL: &str = "http://localhost:4207";

    pub(crate) fn socket_io_fast_ping_server() -> Url {
        let url = std::env::var("SOCKET_IO_FAST_PING_SERVER")
            .unwrap_or_else(|_| FAST_PING_SERVER_URL.to_owned());
        let mut url = Url::parse(&url).unwrap();

        if url.path() == "/" {
            url.set_path("/socket.io/");
        }

        url
    }
}
