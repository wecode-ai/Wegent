//! Filesystem paths for isolated runtime-work tests.
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn runtime_work_index_path_at(label: &str, timestamp: i64) -> PathBuf {
    let sequence = TEMP_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "wegent-runtime-work-{label}-{}-{timestamp}-{sequence}.json",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, sync::Barrier, thread};

    #[test]
    fn same_timestamp_calls_keep_index_and_directory_paths_distinct() {
        let first = runtime_work_index_path_at("preparation-terminal-state", 1234);
        let second = runtime_work_index_path_at("preparation-terminal-state", 1234);

        assert_ne!(first, second);
        assert_ne!(
            first.with_extension("directory"),
            second.with_extension("directory")
        );
    }

    #[test]
    fn concurrent_same_timestamp_calls_have_distinct_directories() {
        const THREADS: usize = 8;
        const PATHS_PER_THREAD: usize = 8;
        let barrier = Barrier::new(THREADS);
        let paths = thread::scope(|scope| {
            let workers = (0..THREADS)
                .map(|_| {
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        (0..PATHS_PER_THREAD)
                            .map(|_| runtime_work_index_path_at("preparation-terminal-state", 1234))
                            .collect::<Vec<_>>()
                    })
                })
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .flat_map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });

        assert_eq!(
            paths.iter().collect::<HashSet<_>>().len(),
            THREADS * PATHS_PER_THREAD
        );
        assert_eq!(
            paths
                .iter()
                .map(|path| path.with_extension("directory"))
                .collect::<HashSet<_>>()
                .len(),
            THREADS * PATHS_PER_THREAD
        );
    }
}
