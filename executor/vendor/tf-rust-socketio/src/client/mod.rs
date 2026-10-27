mod builder;
mod raw_client;

pub use builder::ClientBuilder;
pub use builder::TransportType;
pub use client::Client;
pub use raw_client::RawClient;

/// Internal callback type
mod callback;
#[allow(clippy::module_inception)]
mod client;
