// SPDX-License-Identifier: Apache-2.0
//! Reconcile installed account adapters without depending on a renderer window.

use super::{
    migration::{migrate_prepared, prepare_package_python},
    AuthError, NativeAuthGateway, PreparedPackage,
};
#[cfg(test)]
use crate::local::backend::LocalBackendTransport;
use futures_util::{stream, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::Semaphore, task::JoinSet};

mod pending_logins;
use pending_logins::{LoginOutcome, Target};
pub(super) use pending_logins::{PendingLoginBatch, PendingLogins};

const DISCOVERY_BATCH_SIZE: usize = 16;
const ORDINARY_CONCURRENCY: usize = 4;

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
    owner_revision: u64,
    pending_logins: Arc<PendingLogins>,
    inventory: HashMap<u64, Value>,
    retry_signal: Option<PathBuf>,
    retry_signal_value: Option<Vec<u8>>,
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
            owner_revision: pending_logins.revision(),
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
        self.sync_owner();
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
        self.sync_owner();
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
        self.sync_owner();
        self.retries.retain(|(target, _), _| *target != id);
        self.failures.retain(|(target, _), _| *target != id);
        self.pending_logins
            .invalidate_registrations(self.owner_revision, Some(id));
    }

    pub fn next_retry(&mut self) -> Option<Instant> {
        self.sync_owner();
        self.failures.values().map(|(_, due)| *due).min()
    }

    pub async fn reconcile_due<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
    ) -> Result<(), AuthError> {
        self.sync_owner();
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
        let lane = RegistrationLane {
            actions: Arc::new(Semaphore::new(ORDINARY_CONCURRENCY)),
            foreground: false,
            pending_logins: self.pending_logins.clone(),
            revision: self.owner_revision,
        };
        for selected in ids.chunks(DISCOVERY_BATCH_SIZE) {
            self.reconcile_batch(transport.clone(), home, selected, &lane, None)
                .await?;
        }
        Ok(())
    }

    pub async fn reconcile_logins<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
        mut batch: PendingLoginBatch,
        actions: Arc<Semaphore>,
    ) -> Result<(), AuthError> {
        let requested: Vec<_> = batch.targets().map(|(id, _)| *id).collect();
        if requested.is_empty() {
            return Ok(());
        }
        let result = async {
            let ids = select_installed_targets(&installed_ids(home)?, &requested);
            let removed: Vec<_> = batch
                .targets()
                .filter(|(id, _)| !ids.contains(id))
                .cloned()
                .collect();
            for key in removed {
                batch.finish(&key, LoginOutcome::Finished);
            }
            let lane = RegistrationLane {
                actions,
                foreground: true,
                pending_logins: self.pending_logins.clone(),
                revision: batch.revision,
            };
            self.reconcile_batch(transport, home, &ids, &lane, Some(&mut batch))
                .await
        }
        .await;
        batch.finish_remaining(if result.is_err_and(retry_login) {
            LoginOutcome::RetryDiscovery
        } else {
            LoginOutcome::Finished
        });
        result
    }

    fn sync_owner(&mut self) {
        let revision = self.pending_logins.revision();
        if self.owner_revision != revision {
            self.retries.clear();
            self.failures.clear();
            self.inventory.clear();
            self.owner_revision = revision;
        }
    }

    fn select_targets(&mut self, home: &Path, requested: &[u64]) -> Result<Vec<u64>, AuthError> {
        self.sync_owner();
        self.consume_retry_signal();
        let owned = installed_ids(home)?;
        self.retries
            .retain(|(id, _), until| owned.contains(id) && *until > Instant::now());
        self.failures.retain(|(id, _), _| owned.contains(id));
        Ok(select_installed_targets(&owned, requested))
    }

    async fn reconcile_batch<T: super::PluginAuthTransport>(
        &mut self,
        transport: T,
        home: &Path,
        selected: &[u64],
        lane: &RegistrationLane,
        mut logins: Option<&mut PendingLoginBatch>,
    ) -> Result<(), AuthError> {
        let Some(id) = selected.first() else {
            return Ok(());
        };
        let revision = lane.revision;
        let transport = transport.for_plugin(*id, false);
        if self.pending_logins.revision() != revision {
            return Err(AuthError("plugin_auth_backend_unavailable"));
        }
        let response = NativeAuthGateway::new(transport.clone())
            .call(
                "plugin.auth.automatic",
                json!({"installed_plugin_ids": selected, "prepare_only": true}),
            )
            .await?;
        if self.pending_logins.revision() != revision {
            return Err(AuthError("plugin_auth_backend_unavailable"));
        }
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
        if let Some(batch) = &mut logins {
            let obsolete: Vec<_> = batch
                .targets()
                .filter(|key| !still_eligible(key))
                .cloned()
                .collect();
            for key in obsolete {
                batch.finish(&key, LoginOutcome::Finished);
            }
        }
        let mut groups = BTreeMap::<_, Vec<_>>::new();
        let mut seen = HashSet::new();
        for package in packages {
            let key = (package.installed_plugin_id, package.connector_slug.clone());
            if !selected.contains(&key.0)
                || logins.as_ref().is_some_and(|batch| !batch.contains(&key))
                || !seen.insert(key.clone())
            {
                continue;
            }
            if logins.is_none() {
                if self.pending_logins.recently_registered(revision, &key) {
                    self.failures.remove(&key);
                    continue;
                }
                if self.retries.contains_key(&key) {
                    continue;
                }
                if self.pending_logins.contains_installation(key.0) {
                    self.record(
                        revision,
                        key,
                        Err(AuthError("plugin_auth_background_deferred")),
                    );
                    continue;
                }
            }
            groups.entry(key.0).or_default().push((key, package));
        }
        // The discovery response bounds preparation. Only ready writes
        // occupy registration slots, so runtime waits cannot block them.
        let mut pending = std::pin::pin!(stream::iter(groups.into_values())
            .map(|group| Box::pin(reconcile_group(
                transport.clone(),
                home.to_owned(),
                group,
                lane.clone()
            )))
            .flatten_unordered(None));
        while let Some((key, result)) = pending.next().await {
            if self.pending_logins.revision() != revision {
                self.sync_owner();
                return Err(AuthError("plugin_auth_backend_unavailable"));
            }
            if let Some(batch) = &mut logins {
                // Revocations and other reconciliation work must be
                // able to run after a rejected registration attempt.
                let outcome = match result {
                    Ok(()) => LoginOutcome::Registered,
                    Err(error) if retry_login(error) => LoginOutcome::RetryRegistration,
                    Err(_) => LoginOutcome::Finished,
                };
                batch.finish(&key, outcome);
            } else {
                self.record(revision, key, result);
            }
        }
        Ok(())
    }

    fn record(&mut self, revision: u64, key: Target, result: Result<(), AuthError>) {
        self.sync_owner();
        if revision != self.owner_revision {
            return;
        }
        // Logout/login can replace an intent while a previous cycle is in flight.
        // An obsolete intent says nothing about the new login's native credentials.
        if result == Err(AuthError("plugin_auth_migration_expired")) {
            self.retries.remove(&key);
            self.failures.remove(&key);
            return;
        }
        let delay = if result.is_ok() {
            self.failures.remove(&key);
            Duration::from_secs(60)
        } else {
            let attempt = self
                .failures
                .get(&key)
                .map_or(1, |(attempt, _)| attempt.saturating_add(1));
            let delay = retry_delay(attempt);
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
        self.pending_logins
            .invalidate_registrations(self.owner_revision, None);
    }
}

fn select_installed_targets(owned: &[u64], requested: &[u64]) -> Vec<u64> {
    let mut ids: Vec<_> = requested
        .iter()
        .copied()
        .filter(|id| owned.contains(id))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(match attempt {
        1 => 30,
        2 => 60,
        _ => 300,
    })
}

fn retry_login(error: AuthError) -> bool {
    !matches!(
        error.0,
        "plugin_auth_invalid_request"
            | "plugin_auth_invalid_operation"
            | "plugin_auth_plugin_not_found"
            | "plugin_auth_plugin_disabled"
            | "plugin_auth_not_supported"
            | "plugin_auth_migration_expired"
    )
}

#[derive(Clone)]
struct RegistrationLane {
    actions: Arc<Semaphore>,
    foreground: bool,
    pending_logins: Arc<PendingLogins>,
    revision: u64,
}

impl RegistrationLane {
    fn check(&self, id: u64) -> Result<(), AuthError> {
        if self.pending_logins.revision() != self.revision {
            return Err(AuthError("plugin_auth_backend_unavailable"));
        }
        if !self.foreground && self.pending_logins.contains_installation(id) {
            return Err(AuthError("plugin_auth_background_deferred"));
        }
        Ok(())
    }

    async fn prepare(&self, home: &Path, package: &PreparedPackage) -> Result<(), AuthError> {
        self.check(package.installed_plugin_id)?;
        prepare_package_python(home, package).await
    }

    async fn register<T: super::PluginAuthTransport>(
        &self,
        transport: T,
        home: &Path,
        package: &PreparedPackage,
    ) -> Result<(), AuthError> {
        let id = package.installed_plugin_id;
        self.check(id)?;
        let gate = self
            .pending_logins
            .action_gate(self.revision, id)
            .ok_or(AuthError("plugin_auth_backend_unavailable"))?;
        let acquire = async {
            self.actions
                .acquire()
                .await
                .map_err(|_| AuthError("plugin_auth_owner_unavailable"))
        };
        let (_permit, _installation) = if self.foreground {
            // Waiting on this installation must leave the foreground slot free.
            let installation = gate.lock().await;
            self.check(id)?;
            (acquire.await?, installation)
        } else {
            // A queued ordinary write cannot reserve this installation against
            // foreground work. If it is active, retry from fresh discovery.
            let permit = acquire.await?;
            self.check(id)?;
            let installation = gate
                .try_lock()
                .map_err(|_| AuthError("plugin_auth_background_deferred"))?;
            (permit, installation)
        };
        self.check(id)?;
        if !self.foreground
            && self
                .pending_logins
                .recently_registered(self.revision, &(id, package.connector_slug.clone()))
        {
            return Ok(());
        }
        reconcile_prepared_target(transport.for_plugin(id, self.foreground), home, package).await
    }
}

fn reconcile_group<T: super::PluginAuthTransport>(
    transport: T,
    home: PathBuf,
    group: Vec<(Target, PreparedPackage)>,
    lane: RegistrationLane,
) -> impl Stream<Item = (Target, Result<(), AuthError>)> {
    let preparations = group
        .into_iter()
        .map(|(key, package)| {
            let home = home.clone();
            let lane = lane.clone();
            async move {
                let prepared = lane.prepare(&home, &package).await;
                (key, package, prepared)
            }
        })
        .collect();
    register_ready_connectors(preparations, move |package| {
        let lane = lane.clone();
        let home = home.clone();
        let transport = transport.clone();
        async move { lane.register(transport, &home, &package).await }
    })
}

fn register_ready_connectors<W>(
    preparations: JoinSet<(Target, PreparedPackage, Result<(), AuthError>)>,
    register: impl FnMut(PreparedPackage) -> W,
) -> impl Stream<Item = (Target, Result<(), AuthError>)>
where
    W: std::future::Future<Output = Result<(), AuthError>>,
{
    // Preparations remain active while the previous connector's writes finish.
    stream::unfold(
        (preparations, register),
        |(mut preparations, mut register)| async move {
            while let Some(ready) = preparations.join_next().await {
                let Ok((key, package, prepared)) = ready else {
                    continue;
                };
                let result = match prepared {
                    Ok(()) => register(package).await,
                    Err(error) => Err(error),
                };
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
                return Some(((key, result), (preparations, register)));
            }
            None
        },
    )
}

async fn reconcile_prepared_target<T: super::PluginAuthTransport>(
    transport: T,
    home: &Path,
    package: &PreparedPackage,
) -> Result<(), AuthError> {
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
mod tests;
