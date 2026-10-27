mod client;
mod generator;
mod socket;

#[cfg(feature = "async")]
pub use client::builder::ClientBuilder;
pub use client::client::{Client, ReconnectSettings};

// re-export the macro
pub use crate::{async_any_callback, async_callback};

#[doc = r#"
A macro to wrap an async callback function to be used in the client.

This macro is used to wrap a callback function that can handle a specific event.

```rust
use tf_rust_socketio::async_callback;
use tf_rust_socketio::asynchronous::{Client, ClientBuilder};
use tf_rust_socketio::{Event, Payload};

pub async fn callback(payload: Payload, client: Client) {}

#[tokio::main]
async fn main() {
    let socket = ClientBuilder::new("http://example.com")
            .on("message", async_callback!(callback))
            .connect()
            .await;
}
```
"#]
#[macro_export]
macro_rules! async_callback {
    ($f:expr) => {{
        use futures_util::FutureExt;
        |payload: Payload, client: Client| $f(payload, client).boxed()
    }};
}

#[doc = r#"
A macro to wrap an async callback function to be used in the client.

This macro is used to wrap a callback function that can handle any event.

```rust
use tf_rust_socketio::async_any_callback;
use tf_rust_socketio::asynchronous::{Client, ClientBuilder};
use tf_rust_socketio::{Event, Payload};

pub async fn callback_any(event: Event, payload: Payload, client: Client) {}

#[tokio::main]
async fn main() {
    let socket = ClientBuilder::new("http://example.com")
            .on_any(async_any_callback!(callback_any))
            .connect()
            .await;
}
```
"#]
#[macro_export]
macro_rules! async_any_callback {
    ($f:expr) => {{
        use futures_util::FutureExt;
        |event: Event, payload: Payload, client: Client| $f(event, payload, client).boxed()
    }};
}
