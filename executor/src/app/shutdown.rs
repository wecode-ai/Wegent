// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Stop requests that reach this executor from outside the app IPC channel.
//!
//! The desktop app owns this executor. It asks the executor to stop by closing
//! the app IPC owner channel, and escalates to a hard kill when the executor
//! does not exit within its grace budget. That channel carries the request on
//! every platform, but it is not the only source: on Unix the app signals the
//! process as well, and an operator, a service manager, or a host shutdown
//! sends the same signals without touching the channel.
//!
//! Treating those signals as a stop request keeps one shutdown semantics on
//! every platform: the executor stops the agent processes it owns and then
//! exits through the same path as an owner disconnect. Dying on the signal
//! instead would skip that path and leave the agent processes it was driving to
//! be reaped only as a side effect of the stdio pipes closing.

#[cfg(unix)]
use tokio::signal::unix::{signal, SignalKind};

/// Stop requests for this process, installed for the rest of its lifetime.
pub(crate) struct ShutdownRequest {
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
}

impl ShutdownRequest {
    /// Installs the host stop requests for this process.
    ///
    /// Must be called from within a Tokio runtime: the returned request owns
    /// signal streams that are registered with that runtime's driver.
    pub(crate) fn install() -> Self {
        #[cfg(unix)]
        {
            Self {
                terminate: signal(SignalKind::terminate()).expect("SIGTERM handler should install"),
                interrupt: signal(SignalKind::interrupt()).expect("SIGINT handler should install"),
            }
        }
        #[cfg(not(unix))]
        {
            Self {}
        }
    }

    /// Resolves when the host asks this executor to stop, naming the request
    /// that carried it.
    pub(crate) async fn wait(&mut self) -> &'static str {
        #[cfg(unix)]
        {
            tokio::select! {
                _ = self.terminate.recv() => "SIGTERM",
                _ = self.interrupt.recv() => "SIGINT",
            }
        }
        #[cfg(not(unix))]
        {
            // Windows has no graceful signal for a windowless console child, so
            // the desktop app asks this executor to stop by closing the owner
            // channel; that request never arrives here.
            std::future::pending().await
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::ShutdownRequest;
    use std::time::Duration;

    const SIGNAL_TIMEOUT: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn stop_request_resolves_when_the_host_signals_the_process() {
        let mut request = ShutdownRequest::install();

        unsafe { libc::raise(libc::SIGTERM) };
        assert_eq!(
            tokio::time::timeout(SIGNAL_TIMEOUT, request.wait())
                .await
                .expect("SIGTERM should resolve the stop request"),
            "SIGTERM"
        );

        unsafe { libc::raise(libc::SIGINT) };
        assert_eq!(
            tokio::time::timeout(SIGNAL_TIMEOUT, request.wait())
                .await
                .expect("SIGINT should resolve the stop request"),
            "SIGINT"
        );
    }
}
