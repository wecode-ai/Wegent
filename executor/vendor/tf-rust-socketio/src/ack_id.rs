use std::sync::atomic::{AtomicI32, Ordering};

use crate::{error::Result, Error};

// Shared by client clones and reconnects. A late ACK must never match a newer
// request, even after the original request has completed or timed out.
static NEXT_ACK_ID: AtomicI32 = AtomicI32::new(0);

pub(crate) fn next_ack_id() -> Result<i32> {
    NEXT_ACK_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| Error::AckIdExhausted)
}
