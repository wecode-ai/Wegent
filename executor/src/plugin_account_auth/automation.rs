// SPDX-License-Identifier: Apache-2.0
//! Reconcile installed account adapters without depending on a renderer window.

use super::{
    migration::{migrate_prepared, prepare_package_python},
    AuthError, NativeAuthGateway, PreparedPackage,
};
#[cfg(test)]
use crate::local::backend::LocalBackendTransport;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    id: String,
    installed_plugin_id: u64,
    connector_slug: String,
}

pub(super) struct Reconciler {
    retries: HashMap<(u64, String), Instant>,
    failures: HashMap<(u64, String), (u32, Instant)>,
    foreground_registrations: HashSet<(u64, String)>,
    foreground_revision: u64,
    pending_logins: Arc<PendingLogins>,
    inventory: HashMap<u64, Value>,
    retry_signal: Option<PathBuf>,
    retry_signal_value: Option<Vec<u8>>,
}

#[derive(Default)]
pub(super) struct PendingLogins {
    state: Mutex<PendingLoginState>,
    ready: Notify,
}

#[derive(Default)]
struct PendingLoginState {
    revision: u64,
    entries: HashSet<(u64, String)>,
    processing: HashMap<u64, usize>,
}

// Keep the login visible to other Native writers while its registration is being prepared.
pub(super) struct PendingLoginBatch {
    logins: Arc<PendingLogins>,
    revision: u64,
    entries: HashSet<(u64, String)>,
}

impl Drop for PendingLoginBatch {
    fn drop(&mut self) {
        let mut state = self
            .logins
            .state
            .lock()
            .expect("pending plugin logins lock poisoned");
        if state.revision != self.revision {
            return;
        }
        for (id, _) in &self.entries {
            if let std::collections::hash_map::Entry::Occupied(mut entry) =
                state.processing.entry(*id)
            {
                if *entry.get() == 1 {
                    entry.remove();
                } else {
                    *entry.get_mut() -= 1;
                }
            }
        }
    }
}

impl PendingLogins {
    pub(super) fn submit(&self, installed_id: u64, connector_slug: String) {
        self.state
            .lock()
            .expect("pending plugin logins lock poisoned")
            .entries
            .insert((installed_id, connector_slug));
        self.ready.notify_one();
    }

    pub(super) async fn notified(&self) {
        self.ready.notified().await;
    }

    pub(super) fn clear_owner(&self) {
        let mut state = self
            .state
            .lock()
            .expect("pending plugin logins lock poisoned");
        state.revision += 1;
        state.entries.clear();
        state.processing.clear();
    }

    fn revision(&self) -> u64 {
        self.state
            .lock()
            .expect("pending plugin logins lock poisoned")
            .revision
    }

    pub(super) fn take(self: &Arc<Self>) -> PendingLoginBatch {
        let mut state = self
            .state
            .lock()
            .expect("pending plugin logins lock poisoned");
        let entries = std::mem::take(&mut state.entries);
        for (id, _) in &entries {
            *state.processing.entry(*id).or_default() += 1;
        }
        PendingLoginBatch {
            logins: self.clone(),
            revision: state.revision,
            entries,
        }
    }

    pub(super) fn contains_installation(&self, installed_id: u64) -> bool {
        let state = self
            .state
            .lock()
            .expect("pending plugin logins lock poisoned");
        // Old revocation records may lack resolvable installation metadata.
        if installed_id == 0 {
            return !state.processing.is_empty() || !state.entries.is_empty();
        }
        state.processing.contains_key(&installed_id)
            || state.entries.iter().any(|(id, _)| *id == installed_id)
    }
}

impl Default for Reconciler {
    fn default() -> Self {
        Self::new(Arc::default())
    }
}

impl Reconciler {
    pub(super) fn new(pending_logins: Arc<PendingLogins>) -> Self {
        Self {
            retries: HashMap::new(),
            failures: HashMap::new(),
            foreground_registrations: HashSet::new(),
            foreground_revision: 0,
            pending_logins,
            inventory: HashMap::new(),
            retry_signal: super::e2e_retry_signal(),
            retry_signal_value: None,
        }
    }
    pub async fn reconcile<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
    ) -> Result<(), AuthError> {
        let inventory = installed_inventory(home)?;
        let mut ids: Vec<_> = inventory.keys().copied().collect();
        ids.sort_unstable();
        self.inventory = inventory;
        self.reconcile_selected(transport, home, &ids).await
    }

    pub async fn reconcile_changes<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
    ) -> Result<(), AuthError> {
        let inventory = installed_inventory(home)?;
        let ids: Vec<_> = inventory
            .iter()
            .filter_map(|(id, entry)| (self.inventory.get(id) != Some(entry)).then_some(*id))
            .collect();
        self.inventory = inventory;
        for id in &ids {
            self.invalidate(*id);
        }
        self.reconcile_selected(transport, home, &ids).await
    }

    pub fn invalidate(&mut self, id: u64) {
        self.retries.retain(|(target, _), _| *target != id);
        self.failures.retain(|(target, _), _| *target != id);
    }

    pub fn next_retry(&self) -> Option<Instant> {
        self.failures.values().map(|(_, due)| *due).min()
    }

    pub async fn reconcile_due<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
    ) -> Result<(), AuthError> {
        let ids: Vec<_> = self
            .failures
            .iter()
            .filter_map(|((id, _), (_, due))| (*due <= Instant::now()).then_some(*id))
            .collect();
        for (key, (_, due)) in &mut self.failures {
            if ids.contains(&key.0) {
                *due = Instant::now() + Duration::from_secs(30);
            }
        }
        self.reconcile_selected(transport, home, &ids).await
    }

    pub async fn reconcile_selected<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
        requested: &[u64],
    ) -> Result<(), AuthError> {
        let ids = self.select_targets(home, requested)?;
        for selected in ids.chunks(16) {
            self.reconcile_logins(transport.clone(), home).await?;
            self.reconcile_batch(transport.clone(), home, selected, false)
                .await?;
        }
        Ok(())
    }

    pub async fn reconcile_logins<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
    ) -> Result<(), AuthError> {
        loop {
            let batch = self.pending_logins.take();
            let Some((id, _)) = batch.entries.iter().next() else {
                return Ok(());
            };
            // Pin discovery and the subsequent writes to the login's Native owner.
            let scoped = transport.for_plugin(*id, false);
            if self.pending_logins.revision() != batch.revision {
                continue;
            }
            self.sync_foreground_owner(batch.revision);
            let requested: Vec<_> = batch.entries.iter().map(|(id, _)| *id).collect();
            for key in &batch.entries {
                self.retries.remove(key);
                self.failures.remove(key);
                self.foreground_registrations.insert(key.clone());
            }
            let ids = self.select_targets(home, &requested)?;
            for selected in ids.chunks(16) {
                self.reconcile_batch(scoped.clone(), home, selected, true)
                    .await?;
            }
        }
    }

    fn sync_foreground_owner(&mut self, revision: u64) {
        if self.foreground_revision != revision {
            self.foreground_registrations.clear();
            self.foreground_revision = revision;
        }
    }

    fn select_targets(&mut self, home: &Path, requested: &[u64]) -> Result<Vec<u64>, AuthError> {
        self.consume_retry_signal();
        let owned = installed_ids(home)?;
        self.retries
            .retain(|(id, _), until| owned.contains(id) && *until > Instant::now());
        self.failures.retain(|(id, _), _| owned.contains(id));
        self.foreground_registrations
            .retain(|(id, _)| owned.contains(id));
        let mut ids: Vec<_> = requested
            .iter()
            .copied()
            .filter(|id| owned.contains(id))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        Ok(ids)
    }

    async fn reconcile_batch<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
        selected: &[u64],
        foreground_only: bool,
    ) -> Result<(), AuthError> {
        let Some(id) = selected.first() else {
            return Ok(());
        };
        let revision = self.pending_logins.revision();
        let transport = transport.for_plugin(*id, false);
        if self.pending_logins.revision() != revision {
            return Err(AuthError("plugin_auth_backend_unavailable"));
        }
        self.sync_foreground_owner(revision);
        let response = NativeAuthGateway::new(transport.clone())
            .call(
                "plugin.auth.automatic",
                json!({"installed_plugin_ids": selected, "prepare_only": true}),
            )
            .await?;
        let packages: Vec<PreparedPackage> =
            serde_json::from_value(response["packages"].clone())
                .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
        if packages.len() > 256 {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        if super::e2e_reconcile_marker().is_some() {
            crate::logging::log_executor_event(
                "plugin auth automatic cycle",
                &[
                    ("installed_count", selected.len().to_string()),
                    ("target_count", packages.len().to_string()),
                    ("cooldown_count", self.retries.len().to_string()),
                ],
            );
        }
        let still_eligible = |key: &(u64, String)| {
            !selected.contains(&key.0)
                || packages.iter().any(|package| {
                    package.installed_plugin_id == key.0 && package.connector_slug == key.1
                })
        };
        self.failures.retain(|key, _| still_eligible(key));
        self.foreground_registrations.retain(still_eligible);
        let mut groups = BTreeMap::<_, Vec<_>>::new();
        let mut seen = HashSet::new();
        for package in packages {
            let key = (package.installed_plugin_id, package.connector_slug.clone());
            let foreground = self.foreground_registrations.contains(&key);
            if !selected.contains(&key.0)
                || self.retries.contains_key(&key)
                || foreground_only && !foreground
                || !seen.insert(key.clone())
            {
                continue;
            }
            groups
                .entry(key.0)
                .or_default()
                .push((key, package, foreground));
        }
        let mut pending = tokio::task::JoinSet::new();
        let actions = Arc::new(tokio::sync::Semaphore::new(4));
        for (installed_id, mut group) in groups {
            group.sort_by_key(|(_, _, foreground)| !foreground);
            let transport = transport.clone();
            let home = home.to_owned();
            let actions = actions.clone();
            pending.spawn(async move {
                let mut results = Vec::with_capacity(group.len());
                for (key, package, foreground) in group {
                    let scoped = transport.for_plugin(installed_id, foreground);
                    let result = reconcile_target(scoped, &home, &package, &actions).await;
                    crate::logging::log_executor_event(
                        "plugin auth automatic enrollment finished",
                        &[
                            ("installed_plugin_id", key.0.to_string()),
                            ("connector_slug", key.1.clone()),
                            ("ok", result.is_ok().to_string()),
                            (
                                "code",
                                result.as_ref().err().map_or("", |error| error.0).to_owned(),
                            ),
                        ],
                    );
                    results.push((key, result));
                }
                results
            });
        }
        while let Some(result) = pending.join_next().await {
            if let Ok(results) = result {
                for (key, result) in results {
                    self.record(key, result);
                }
            }
        }
        Ok(())
    }

    fn record(&mut self, key: (u64, String), result: Result<(), AuthError>) {
        // Logout/login can replace an intent while a previous cycle is in flight.
        // An obsolete intent says nothing about the new login's native credentials.
        if result == Err(AuthError("plugin_auth_migration_expired")) {
            self.retries.remove(&key);
            self.failures.remove(&key);
            self.foreground_registrations.remove(&key);
            return;
        }
        let delay = if result.is_ok() {
            self.failures.remove(&key);
            self.foreground_registrations.remove(&key);
            Duration::from_secs(60)
        } else {
            let attempt = self
                .failures
                .get(&key)
                .map_or(1, |(attempt, _)| attempt.saturating_add(1));
            let delay = Duration::from_secs(match attempt {
                1 => 30,
                2 => 60,
                _ => 300,
            });
            self.failures
                .insert(key.clone(), (attempt, Instant::now() + delay));
            delay
        };
        self.retries.insert(key, Instant::now() + delay);
    }

    fn consume_retry_signal(&mut self) {
        let Some(path) = self.retry_signal.as_ref() else {
            return;
        };
        let Ok(value) = fs::read(path) else {
            return;
        };
        if self.retry_signal_value.as_ref() == Some(&value) {
            return;
        }
        self.retry_signal_value = Some(value);
        self.retries.clear();
        self.failures.clear();
    }
}

async fn reconcile_target<T: super::PluginAuthTransport>(
    transport: T,
    home: &Path,
    package: &PreparedPackage,
    actions: &tokio::sync::Semaphore,
) -> Result<(), AuthError> {
    prepare_package_python(home, package).await?;
    // Waiting for Python must not occupy a provider slot or consume an intent's TTL.
    let _permit = actions
        .acquire()
        .await
        .map_err(|_| AuthError("plugin_auth_owner_unavailable"))?;
    let response = NativeAuthGateway::new(transport.clone())
        .call(
            "plugin.auth.automatic",
            json!({"installed_plugin_ids": [package.installed_plugin_id], "targets": [{
                "installed_plugin_id": package.installed_plugin_id,
                "connector_slug": package.connector_slug,
            }]}),
        )
        .await?;
    let intents: Vec<Intent> = serde_json::from_value(response["migrations"].clone())
        .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
    if intents.len() > 1 {
        return Err(AuthError("plugin_auth_invalid_response"));
    }
    if let Some(intent) = intents.into_iter().next() {
        if intent.installed_plugin_id != package.installed_plugin_id
            || intent.connector_slug != package.connector_slug
        {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        migrate_prepared(transport, home, &intent.id, package).await?;
    }
    Ok(())
}

fn installed_ids(home: &Path) -> Result<Vec<u64>, AuthError> {
    installed_ids_at(&super::migration::manifest_path_for_home(home))
}

fn installed_ids_at(path: &Path) -> Result<Vec<u64>, AuthError> {
    let mut ids: Vec<_> = installed_inventory_at(path)?.into_keys().collect();
    ids.sort_unstable();
    Ok(ids)
}

fn installed_inventory(home: &Path) -> Result<HashMap<u64, Value>, AuthError> {
    installed_inventory_at(&super::migration::manifest_path_for_home(home))
}

fn installed_inventory_at(path: &Path) -> Result<HashMap<u64, Value>, AuthError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err(AuthError("plugin_auth_invalid_package")),
    };
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Err(AuthError("plugin_auth_invalid_package"));
    }
    let manifest: Value = serde_json::from_slice(
        &fs::read(path).map_err(|_| AuthError("plugin_auth_invalid_package"))?,
    )
    .map_err(|_| AuthError("plugin_auth_invalid_package"))?;
    Ok(manifest["plugins"]
        .as_object()
        .ok_or(AuthError("plugin_auth_invalid_package"))?
        .values()
        .filter(|entry| entry["managed"] == true && entry["enabled"] == true)
        .filter_map(|entry| {
            entry["installed_plugin_id"]
                .as_u64()
                .filter(|id| *id > 0)
                .map(|id| (id, entry.clone()))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::backend::{EventHandler, LocalBackendConfig};
    use std::{
        collections::VecDeque,
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
    };

    type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

    #[derive(Clone)]
    struct Transport(Arc<Mutex<VecDeque<(&'static str, Value)>>>);

    impl LocalBackendTransport for Transport {
        fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
            panic!("reconciliation uses an established transport")
        }
        fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
            panic!("reconciliation must not disconnect")
        }
        fn call<'a>(&'a self, event: &'a str, _: Value, _: Duration) -> TransportFuture<'a, Value> {
            let (expected, response) = self.0.lock().unwrap().pop_front().expect("unexpected call");
            assert_eq!(event, expected);
            Box::pin(async move { Ok(response) })
        }
        fn emit<'a>(&'a self, _: &'a str, _: Value) -> TransportFuture<'a, ()> {
            panic!("reconciliation uses request/reply")
        }
        fn on(&self, _: &str, _: EventHandler) {
            panic!("no subscription")
        }
        fn on_close(&self, _: crate::local::backend::ConnectionClosedHandler) {
            panic!("no subscription")
        }
    }

    #[tokio::test]
    async fn failed_login_discovery_releases_background_priority() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("capabilities")).unwrap();
        fs::write(
            home.path().join("capabilities/manifest-v2.json"),
            json!({"plugins":{
                "mail":{"installed_plugin_id":42,"managed":true,"enabled":true},
            }})
            .to_string(),
        )
        .unwrap();
        let transport = Transport(Arc::new(Mutex::new(VecDeque::from([(
            "plugin.auth.automatic",
            json!({"success":false,"error":"plugin_auth_invalid_request"}),
        )]))));
        let logins = Arc::new(PendingLogins::default());
        logins.submit(42, "mail".into());

        let error = Reconciler::new(logins.clone())
            .reconcile_logins(transport, home.path())
            .await
            .unwrap_err();

        assert_eq!(error, AuthError("plugin_auth_invalid_request"));
        assert!(!logins.contains_installation(42));
    }

    #[tokio::test]
    async fn expired_intent_does_not_suppress_the_next_login() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("capabilities")).unwrap();
        let root = home
            .path()
            .join("workbench/shared/plugins")
            .join("a".repeat(64));
        fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        let definition =
            json!({"protocolVersion":1,"credentialType":"bearer","adapter":"auth.mjs"});
        fs::write(root.join("auth.mjs"), "// not executed").unwrap();
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            json!({"connectors":[{
                "slug":"mail","accountAuth":definition
            }]})
            .to_string(),
        )
        .unwrap();
        let package = json!({"installed_plugin_id":42,"connector_slug":"mail",
            "checksum":format!("sha256:{}", "a".repeat(64)),"auth_definition":definition});
        fs::write(
            home.path().join("capabilities/manifest-v2.json"),
            json!({"plugins": {
                "mail": {"installed_plugin_id":42,"managed":true,"enabled":true,
                    "checksum":package["checksum"],"store_path":root}
            }})
            .to_string(),
        )
        .unwrap();
        let intents = |id: &str| {
            json!({"success": true, "migrations": [{
                "id": id.repeat(64), "installed_plugin_id": 42, "connector_slug": "mail"
            }]})
        };
        let calls = Arc::new(Mutex::new(VecDeque::from([
            (
                "plugin.auth.automatic",
                json!({"success":true,"packages":[package.clone(),package.clone()]}),
            ),
            ("plugin.auth.automatic", intents("a")),
            (
                "plugin.auth.prepare",
                json!({"success": false, "error": "plugin_auth_migration_expired"}),
            ),
            (
                "plugin.auth.automatic",
                json!({"success":true,"packages":[package.clone()]}),
            ),
            ("plugin.auth.automatic", intents("b")),
            (
                "plugin.auth.prepare",
                json!({"success": false, "error": "plugin_auth_owner_unavailable"}),
            ),
            (
                "plugin.auth.automatic",
                json!({"success":true,"packages":[package]}),
            ),
        ])));
        let transport = Transport(calls.clone());
        let mut reconciler = Reconciler {
            retry_signal: None,
            ..Reconciler::default()
        };
        for _ in 0..3 {
            reconciler
                .reconcile(transport.clone(), home.path())
                .await
                .unwrap();
        }
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn claimed_intent_must_match_the_package_whose_runtime_was_prepared() {
        let home = tempfile::tempdir().unwrap();
        let original = json!({"installed_plugin_id":42,"connector_slug":"native",
            "checksum":format!("sha256:{}", "a".repeat(64)),
            "auth_definition":{"adapter":"auth.mjs"}});
        for field in ["checksum", "auth_definition"] {
            let mut changed = original.clone();
            changed[field] = if field == "checksum" {
                json!(format!("sha256:{}", "b".repeat(64)))
            } else {
                json!({"adapter":"new-python-auth.py"})
            };
            let calls = Arc::new(Mutex::new(VecDeque::from([(
                "plugin.auth.prepare",
                json!({"success":true,"operation":"export","package":changed}),
            )])));
            let expected = serde_json::from_value(original.clone()).unwrap();
            let result = migrate_prepared(
                Transport(calls.clone()),
                home.path(),
                &"a".repeat(64),
                &expected,
            )
            .await;
            // Reject before loading a replacement adapter or starting another wait.
            assert_eq!(
                result.err(),
                Some(AuthError("plugin_auth_definition_mismatch"))
            );
            assert!(calls.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn discovery_reads_explicit_relocated_manifest_without_legacy_home() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp
            .path()
            .join("workbench/wework/test/capabilities/manifest.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            json!({"plugins": {
                "mail": {"installed_plugin_id":42,"managed":true,"enabled":true}
            }})
            .to_string(),
        )
        .unwrap();
        assert_eq!(installed_ids_at(&path).unwrap(), vec![42]);
        assert!(!temp.path().join("capabilities").exists());
    }

    #[test]
    fn discovery_only_reports_enabled_managed_installations() {
        let home = tempfile::tempdir().unwrap();
        assert!(installed_ids(home.path()).unwrap().is_empty());
        fs::create_dir(home.path().join("capabilities")).unwrap();
        fs::write(
            home.path().join("capabilities/manifest-v2.json"),
            json!({"plugins": {
                "managed": {"installed_plugin_id": 12, "managed": true, "enabled": true},
                "disabled": {"installed_plugin_id": 13, "managed": true, "enabled": false},
                "personal": {"installed_plugin_id": 14, "managed": false, "enabled": true},
                "duplicate": {"installed_plugin_id": 12, "managed": true, "enabled": true}
            }})
            .to_string(),
        )
        .unwrap();
        fs::write(
            home.path().join("capabilities/manifest.json"),
            json!({"plugins": {
                "stale": {"installed_plugin_id": 99, "managed": true, "enabled": true}
            }})
            .to_string(),
        )
        .unwrap();
        assert_eq!(installed_ids(home.path()).unwrap(), vec![12]);
    }

    #[test]
    fn e2e_retry_signal_clears_cooldowns_only_when_it_changes() {
        let home = tempfile::tempdir().unwrap();
        let signal = home.path().join("retry.signal");
        let key = (12, "mail".to_owned());
        let mut reconciler = Reconciler {
            retries: HashMap::from([(key.clone(), Instant::now() + Duration::from_secs(60))]),
            retry_signal: Some(signal.clone()),
            ..Reconciler::default()
        };

        fs::write(&signal, "1").unwrap();
        reconciler.consume_retry_signal();
        assert!(reconciler.retries.is_empty());

        reconciler
            .retries
            .insert(key.clone(), Instant::now() + Duration::from_secs(60));
        reconciler.consume_retry_signal();
        assert!(reconciler.retries.contains_key(&key));

        fs::write(signal, "2").unwrap();
        reconciler.consume_retry_signal();
        assert!(reconciler.retries.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn discovery_rejects_symlinked_manifests() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("capabilities")).unwrap();
        fs::write(home.path().join("untrusted.json"), r#"{"plugins":{}}"#).unwrap();
        std::os::unix::fs::symlink(
            home.path().join("untrusted.json"),
            home.path().join("capabilities/manifest-v2.json"),
        )
        .unwrap();
        assert_eq!(
            installed_ids(home.path()),
            Err(AuthError("plugin_auth_invalid_package"))
        );
    }
    #[test]
    fn failures_back_off_and_login_invalidates_only_its_own_target() {
        let mut reconciler = Reconciler::default();
        let key = (42, "mail".to_owned());
        let other = (43, "mail".to_owned());
        reconciler.record(other.clone(), Ok(()));
        for seconds in [30, 60, 300, 300] {
            let before = Instant::now();
            reconciler.record(key.clone(), Err(AuthError("plugin_auth_owner_unavailable")));
            let due = reconciler.next_retry().unwrap();
            assert!(due >= before + Duration::from_secs(seconds));
            assert!(due <= Instant::now() + Duration::from_secs(seconds));
        }
        reconciler.invalidate(42);
        assert!(reconciler.next_retry().is_none());
        assert!(reconciler.retries.contains_key(&other));
        reconciler.record(key, Ok(()));
        assert!(reconciler.next_retry().is_none());
    }

    #[tokio::test]
    async fn unchanged_or_removed_inventory_does_not_rediscover_credentials() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("capabilities")).unwrap();
        let path = home.path().join("capabilities/manifest-v2.json");
        let manifest =
            json!({"plugins":{"mail":{"installed_plugin_id":42,"managed":true,"enabled":true}}});
        fs::write(&path, manifest.to_string()).unwrap();
        let calls = Arc::new(Mutex::new(VecDeque::new()));
        let mut reconciler = Reconciler {
            inventory: installed_inventory(home.path()).unwrap(),
            ..Default::default()
        };
        reconciler
            .reconcile_changes(Transport(calls.clone()), home.path())
            .await
            .unwrap();
        fs::write(path, json!({"plugins":{}}).to_string()).unwrap();
        reconciler.record(
            (42, "mail".into()),
            Err(AuthError("plugin_auth_owner_unavailable")),
        );
        reconciler
            .reconcile_changes(Transport(calls.clone()), home.path())
            .await
            .unwrap();
        assert!(reconciler.next_retry().is_none());
        assert!(calls.lock().unwrap().is_empty());
    }
}
