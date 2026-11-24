use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};

use tokio::{
    runtime::Handle,
    sync::RwLock,
    task::JoinHandle,
    time::{timeout, Duration},
};

use super::client::DispatchTask;
use crate::asynchronous::socket::Socket;

pub(super) const CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);

/// Cleanup remains armed across awaits, including failed/cancelled setup.
pub(super) struct TransportCleanup {
    socket: Option<Arc<RwLock<Socket>>>,
    runtime: Handle,
    reader_shutdown: Option<Arc<AtomicBool>>,
    cancel_dispatch: Option<Arc<Mutex<Vec<DispatchTask>>>>,
    cancel_reader: Option<Weak<ClientLifetime>>,
}

impl TransportCleanup {
    pub(super) fn new(socket: Arc<RwLock<Socket>>) -> Self {
        Self {
            socket: Some(socket),
            runtime: Handle::current(),
            reader_shutdown: None,
            cancel_dispatch: None,
            cancel_reader: None,
        }
    }

    pub(super) fn for_reader(socket: Arc<RwLock<Socket>>, shutdown: Arc<AtomicBool>) -> Self {
        let mut cleanup = Self::new(socket);
        cleanup.reader_shutdown = Some(shutdown);
        cleanup
    }

    pub(super) fn for_disconnect(
        socket: Arc<RwLock<Socket>>,
        tasks: Arc<Mutex<Vec<DispatchTask>>>,
        lifetime: Weak<ClientLifetime>,
    ) -> Self {
        let mut cleanup = Self::new(socket);
        cleanup.cancel_dispatch = Some(tasks);
        cleanup.cancel_reader = Some(lifetime);
        cleanup
    }

    pub(super) fn disarm(&mut self) {
        self.socket = None;
        self.cancel_dispatch = None;
        self.cancel_reader = None;
    }

    /// An unresponsive Close send must not block reader shutdown or reconnect.
    pub(super) async fn disconnect(socket: &RwLock<Socket>) {
        let _ = timeout(CLEANUP_TIMEOUT, async {
            let _ = socket.read().await.disconnect().await;
        })
        .await;
    }
}

impl Drop for TransportCleanup {
    fn drop(&mut self) {
        // Manual disconnect or the last owner's Drop already owns cleanup;
        // racing it could consume the transport before its namespace send.
        if self
            .reader_shutdown
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            return;
        }
        if let Some(socket) = self.socket.take() {
            if let Some(lifetime) = self.cancel_reader.take().and_then(|weak| weak.upgrade()) {
                lifetime.abort_reader();
            }
            if let Some(tasks) = self.cancel_dispatch.take() {
                for (task, _) in tasks.lock().unwrap().drain(..) {
                    task.abort();
                }
            }
            self.runtime.spawn(async move {
                Self::disconnect(&socket).await;
            });
        }
    }
}

/// Only caller-owned clients retain this guard; background work must not form
/// a cycle through either its poll handle or its dispatch handles.
pub(super) struct ClientLifetime {
    pub(super) poll_task: Mutex<Option<JoinHandle<()>>>,
    dispatch_tasks: Arc<Mutex<Vec<DispatchTask>>>,
    shutdown: Arc<AtomicBool>,
    _cleanup: TransportCleanup,
}

impl ClientLifetime {
    pub(super) fn new(
        socket: Arc<RwLock<Socket>>,
        dispatch_tasks: Arc<Mutex<Vec<DispatchTask>>>,
        shutdown: Arc<AtomicBool>,
    ) -> Self {
        Self {
            poll_task: Mutex::new(None),
            dispatch_tasks,
            shutdown,
            _cleanup: TransportCleanup::new(socket),
        }
    }

    pub(super) fn abort_reader(&self) {
        if let Some(task) = self.poll_task.lock().unwrap().take() {
            task.abort();
        }
    }
}

impl Drop for ClientLifetime {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.abort_reader();
        for (task, _) in self.dispatch_tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}
