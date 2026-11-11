//! Scan outside foreground leases, then merge only still-current evidence.
use super::*;
use std::path::PathBuf;

pub(super) struct LocalSyncLease {
    _file: std::fs::File,
    _serial: tokio::sync::OwnedMutexGuard<()>,
}

pub(super) struct ForegroundOperation {
    active: Arc<std::sync::Mutex<std::collections::HashMap<PathBuf, usize>>>,
    path: PathBuf,
}

impl ForegroundOperation {
    pub(super) fn begin(
        active: Arc<std::sync::Mutex<std::collections::HashMap<PathBuf, usize>>>,
        path: &Path,
    ) -> Self {
        *active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(path.to_owned())
            .or_default() += 1;
        Self {
            active,
            path: path.to_owned(),
        }
    }
}

impl Drop for ForegroundOperation {
    fn drop(&mut self) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(count) = active.get_mut(&self.path) {
            *count -= 1;
            if *count == 0 {
                active.remove(&self.path);
            }
        }
    }
}

impl LocalBackendConnectionController {
    pub(super) fn has_foreground_plugin_operation(&self, path: &Path) -> bool {
        self.local_sync_foreground
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(path)
            .is_some_and(|count| *count > 0)
    }

    pub(super) async fn resume_local_sync_journal(
        &self,
        connection: &ConnectionConfig,
        path: &Path,
        lease: &mut Option<LocalSyncLease>,
    ) -> Result<Value, AppIpcError> {
        drop(lease.take());
        *lease = Some(self.acquire_local_sync_lease(connection, path).await?);
        load_journal(path)
    }

    pub(super) async fn acquire_local_sync_lease(
        &self,
        connection: &ConnectionConfig,
        path: &Path,
    ) -> Result<LocalSyncLease, AppIpcError> {
        let serial = self.local_sync_lock.clone().lock_owned().await;
        let lock_path = path.with_extension("lock");
        let file = tokio::task::spawn_blocking(move || recovery::lock_file(&lock_path))
            .await
            .map_err(|_| error("plugin_local_journal_unavailable"))??;
        // Socket replacement invalidates the captured installer; Runtime token
        // renewal preserves it and must not reject queued work or scan results.
        if !self.state.lock().await.profile.as_ref().is_some_and(|p| {
            same_account_connection(&p.connection, connection)
                && p.connection.socket_url == connection.socket_url
        }) {
            return Err(error("plugin_route_profile_mismatch"));
        }
        Ok(LocalSyncLease {
            _serial: serial,
            _file: file,
        })
    }

    pub(super) async fn scan_local_plugin_content(
        &self,
        session: &LocalSyncSession<'_>,
        journal: &mut Value,
        lease: &mut Option<LocalSyncLease>,
    ) -> Result<Option<String>, AppIpcError> {
        // New foreground intents advance this durable sequence; recovery only
        // settles existing IDs. Publication is fenced separately by the manifest.
        let foreground_order = journal["nextIntentOrder"].clone();
        let revision = session.handler.local_plugin_revision();
        let handler = session.handler.clone();
        let scan_lock = session.path.with_extension("scan.lock");
        drop(lease.take());
        let scanned = tokio::task::spawn_blocking(move || {
            // Cancellation cannot release the scan slot while its worker lives.
            let _scanning = recovery::lock_file(&scan_lock)?;
            Ok::<_, AppIpcError>((
                handler.local_plugin_digest(),
                handler.local_plugin_revision(),
            ))
        })
        .await;
        let current = self
            .resume_local_sync_journal(session.connection, session.path, lease)
            .await?;
        if current["nextIntentOrder"] != foreground_order {
            return Err(error("plugin_local_sync_busy"));
        }
        let (digest, after) = scanned.map_err(|_| error("plugin_local_scan_failed"))??;
        if revision != after || after != session.handler.local_plugin_revision() {
            return Err(error("plugin_local_sync_busy"));
        }
        // Recovery updates are merged, never replaced by the scan's old copy.
        *journal = current;
        // A handler without a publication stamp cannot attest a reusable digest.
        Ok(revision.and(digest))
    }
}
