//! Scan outside foreground leases, then merge only still-current evidence.
use super::*;

pub(super) struct LocalSyncLease {
    _file: std::fs::File,
    _serial: tokio::sync::OwnedMutexGuard<()>,
}

fn execution_stamp(journal: &Value) -> Value {
    let mut pending = journal["pending"].clone();
    for entry in pending.as_array_mut().unwrap() {
        for field in ["accepted", "lastAttemptAt", "lastErrorCode"] {
            entry.as_object_mut().unwrap().remove(field);
        }
    }
    json!({
        "version":journal["version"],"nextIntentOrder":journal["nextIntentOrder"],
        "pending":pending,"snapshot":journal["snapshot"],"revision":journal["revision"],
        "verifiedDigest":journal["verifiedDigest"],"lastResult":journal["lastResult"]
    })
}

impl LocalBackendConnectionController {
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
        if self
            .state
            .lock()
            .await
            .profile
            .as_ref()
            .map(|p| &p.connection)
            != Some(connection)
        {
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
        let expected = execution_stamp(journal);
        let revision = session.handler.local_plugin_revision();
        let handler = session.handler.clone();
        let scanning = recovery::lock_file(&session.path.with_extension("scan.lock"))?;
        drop(lease.take());
        let scanned = tokio::task::spawn_blocking(move || {
            // Cancellation cannot release the scan slot while its worker lives.
            let _scanning = scanning;
            (
                handler.local_plugin_digest(),
                handler.local_plugin_revision(),
            )
        })
        .await;
        *lease = Some(
            self.acquire_local_sync_lease(session.connection, session.path)
                .await?,
        );
        let current = load_journal(session.path)?;
        if execution_stamp(&current) != expected {
            return Err(error("plugin_local_sync_busy"));
        }
        let (digest, after) = scanned.map_err(|_| error("plugin_local_scan_failed"))?;
        if revision != after || after != session.handler.local_plugin_revision() {
            return Err(error("plugin_local_sync_busy"));
        }
        // Recovery updates are merged, never replaced by the scan's old copy.
        *journal = current;
        // A handler without a publication stamp cannot attest a reusable digest.
        Ok(revision.and(digest))
    }
}
