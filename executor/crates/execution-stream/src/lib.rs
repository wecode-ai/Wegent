//! Ordered streaming delivery, delta compaction, failure propagation, and flushing.
mod streaming;
pub use streaming::StreamingEventDispatcher;
