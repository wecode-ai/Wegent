// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicU64, Ordering};

pub(super) static TERMINAL_OUTPUT_BATCHES_TOTAL: AtomicU64 = AtomicU64::new(0);
pub(super) static TERMINAL_OUTPUT_BYTES_TOTAL: AtomicU64 = AtomicU64::new(0);
pub(super) static TERMINAL_REPLAYED_BATCHES_TOTAL: AtomicU64 = AtomicU64::new(0);
pub(super) static TERMINAL_REPLAY_BYTES: AtomicU64 = AtomicU64::new(0);
pub(super) static TERMINAL_ACK_LAG_BYTES: AtomicU64 = AtomicU64::new(0);
pub(super) static TERMINAL_BACKPRESSURED_SESSIONS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalMetricsSnapshot {
    pub output_batches_total: u64,
    pub output_bytes_total: u64,
    pub replayed_batches_total: u64,
    pub replay_bytes: u64,
    pub ack_lag_bytes: u64,
    pub backpressured_sessions: u64,
}

pub(crate) fn terminal_metrics_snapshot() -> TerminalMetricsSnapshot {
    TerminalMetricsSnapshot {
        output_batches_total: TERMINAL_OUTPUT_BATCHES_TOTAL.load(Ordering::Relaxed),
        output_bytes_total: TERMINAL_OUTPUT_BYTES_TOTAL.load(Ordering::Relaxed),
        replayed_batches_total: TERMINAL_REPLAYED_BATCHES_TOTAL.load(Ordering::Relaxed),
        replay_bytes: TERMINAL_REPLAY_BYTES.load(Ordering::Relaxed),
        ack_lag_bytes: TERMINAL_ACK_LAG_BYTES.load(Ordering::Relaxed),
        backpressured_sessions: TERMINAL_BACKPRESSURED_SESSIONS.load(Ordering::Relaxed),
    }
}

pub(super) fn subtract_metric(metric: &AtomicU64, value: usize) {
    let value = value as u64;
    let mut current = metric.load(Ordering::Relaxed);
    loop {
        match metric.compare_exchange_weak(
            current,
            current.saturating_sub(value),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return,
            Err(updated) => current = updated,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn subtract_metric_saturates_at_zero() {
        for (initial, amount, expected) in [(10, 4, 6), (10, 10, 0), (10, 11, 0), (0, 1, 0)] {
            let metric = AtomicU64::new(initial);

            subtract_metric(&metric, amount);

            assert_eq!(metric.load(Ordering::Relaxed), expected);
        }
    }

    #[test]
    fn concurrent_metric_updates_preserve_every_increment_and_decrement() {
        let metric = AtomicU64::new(20_000);
        let barrier = Barrier::new(4);

        std::thread::scope(|scope| {
            for worker in 0..4 {
                let metric = &metric;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..10_000 {
                        if worker % 2 == 0 {
                            subtract_metric(metric, 1);
                        } else {
                            metric.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                });
            }
        });

        assert_eq!(metric.load(Ordering::Relaxed), 20_000);
    }
}
