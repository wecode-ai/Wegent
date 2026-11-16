use std::time::Duration;

use crate::asynchronous::client::callback::Callback;
use tokio::time::Instant;

use super::callback::DynAsyncCallback;

/// Represents an `Ack` as given back to the caller. Holds the internal `id` as
/// well as the current ack'ed state. Holds data which will be accessible as
/// soon as the ack'ed state is set to true. An `Ack` that didn't get ack'ed
/// won't contain data.
#[derive(Debug)]
pub(crate) struct Ack {
    pub id: i32,
    pub timeout: Duration,
    pub time_started: Instant,
    pub callback: Callback<DynAsyncCallback>,
}
