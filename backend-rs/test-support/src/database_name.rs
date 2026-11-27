// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static DATABASE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Generate process-unique MySQL schema names even when the clock repeats.
pub fn unique_database_name(prefix: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("fixture clock must follow the Unix epoch")
        .as_nanos();
    database_name_at(prefix, timestamp)
}

fn database_name_at(prefix: &str, timestamp: u128) -> String {
    let sequence = DATABASE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{}_{timestamp:x}_{sequence:x}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::database_name_at;
    use std::collections::HashSet;

    #[test]
    fn parallel_fixtures_remain_isolated_when_the_clock_repeats() {
        let names = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..32)
                .map(|_| {
                    scope.spawn(|| database_name_at("responses_json", 1_794_987_739_066_316_170))
                })
                .collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(names.iter().all(|name| name.len() <= 64));
        assert_eq!(names.iter().collect::<HashSet<_>>().len(), 32);
    }
}
