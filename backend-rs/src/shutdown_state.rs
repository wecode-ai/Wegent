// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Graceful shutdown state shared by the /api/shutdown/* endpoints.
// Mirrors the process-local portion of source app/core/shutdown.py.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub(crate) struct ShutdownState {
    shutting_down: AtomicBool,
    python_marker: Option<PathBuf>,
}

impl ShutdownState {
    pub(crate) fn from_env() -> Self {
        Self {
            python_marker: std::env::var_os("WEGENT_HYBRID_SHUTDOWN_FILE")
                .filter(|path| !path.is_empty())
                .map(PathBuf::from),
            ..Self::default()
        }
    }

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    pub(crate) async fn is_health_shutting_down(&self) -> bool {
        // The hybrid endpoint preserves the shutdown state reported by Python.
        let Some(marker) = &self.python_marker else {
            return self.is_shutting_down();
        };
        tokio::fs::try_exists(marker).await.unwrap_or_else(|error| {
            tracing::warn!(%error, "failed to read hybrid Backend shutdown state");
            false
        })
    }

    /// `ShutdownManager.initiate_shutdown` process-local half: flip the flag
    /// once, mirroring the manager's locked check-then-set. Returns `true`
    /// only for the call that actually initiated the shutdown; later callers
    /// take the source's "Shutdown already initiated" early return.
    pub(crate) fn initiate(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initiate_flips_the_flag_exactly_once() {
        let state = ShutdownState::default();
        assert!(!state.is_shutting_down());
        assert!(state.initiate());
        assert!(state.is_shutting_down());
        assert!(!state.initiate());
        assert!(state.is_shutting_down());
    }

    #[tokio::test]
    async fn hybrid_health_reports_python_reset_during_rust_drain() {
        struct Marker(PathBuf);
        impl Drop for Marker {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let marker = std::env::temp_dir().join(format!(
            "wegent-health-shutdown-test-{}-{now}",
            std::process::id(),
        ));
        std::fs::File::create_new(&marker).unwrap();
        let marker = Marker(marker);
        let state = ShutdownState {
            python_marker: Some(marker.0.clone()),
            ..ShutdownState::default()
        };
        assert!(state.initiate());
        let before_reset = state.is_health_shutting_down().await;
        std::fs::remove_file(&marker.0).unwrap();
        assert!(before_reset);
        assert!(!state.is_health_shutting_down().await);
        assert!(state.is_shutting_down());
    }
}
