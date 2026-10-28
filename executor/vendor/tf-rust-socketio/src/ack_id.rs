use std::sync::atomic::{AtomicI32, Ordering};

use crate::{error::Result, Error};

// Shared by client clones and reconnects. A late ACK must never match a newer
// request, even after the original request has completed or timed out.
static NEXT_ACK_ID: AtomicI32 = AtomicI32::new(0);

pub(crate) fn next_ack_id() -> Result<i32> {
    allocate_ack_id(&NEXT_ACK_ID)
}

fn allocate_ack_id(counter: &AtomicI32) -> Result<i32> {
    let mut current = counter.load(Ordering::Relaxed);
    loop {
        let next = current.checked_add(1).ok_or(Error::AckIdExhausted)?;
        // Unlike try_update, this supports the Executor's Rust 1.77 minimum.
        match counter.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return Ok(current),
            Err(updated) => current = updated,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn exhaustion_never_wraps_or_reuses_ids() {
        let counter = AtomicI32::new(i32::MAX - 2);

        assert_eq!(allocate_ack_id(&counter).unwrap(), i32::MAX - 2);
        assert_eq!(allocate_ack_id(&counter).unwrap(), i32::MAX - 1);
        for _ in 0..2 {
            assert!(matches!(
                allocate_ack_id(&counter),
                Err(Error::AckIdExhausted)
            ));
            assert_eq!(counter.load(Ordering::Relaxed), i32::MAX);
        }
    }

    #[test]
    fn concurrent_allocations_are_unique() {
        let counter = AtomicI32::new(0);
        let barrier = Barrier::new(4);

        let mut ids = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        (0..1_000)
                            .map(|_| allocate_ack_id(&counter).unwrap())
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });

        ids.sort_unstable();
        assert_eq!(ids, (0..4_000).collect::<Vec<_>>());
        assert_eq!(counter.load(Ordering::Relaxed), 4_000);
    }
}
