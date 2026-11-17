// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

mod store;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio::sync::{broadcast, Notify};
use wegent_workspace::turn_file_changes::GitTurnRange;

use super::{
    command::execute_command_hook,
    host::{emit_run_event, summary},
    model::{HookEventName, HookHealth, TurnCompletedInput, TurnHookReceipt},
    registry::HookRegistryStore,
};
use store::{Event, Store, Target};

#[derive(Clone)]
pub(super) struct TurnHookOutbox {
    inner: Arc<Inner>,
}

struct Inner {
    registry: HookRegistryStore,
    database: PathBuf,
    artifacts: PathBuf,
    events: Arc<Mutex<Option<broadcast::Sender<Value>>>>,
    started: AtomicBool,
    wake: Arc<Notify>,
    progress: Notify,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // The idle worker keeps only this Notify alive. Store a wake permit so
        // dropping the last service also terminates an idle worker reliably.
        self.wake.notify_one();
    }
}

impl TurnHookOutbox {
    pub fn new(
        registry: HookRegistryStore,
        events: Arc<Mutex<Option<broadcast::Sender<Value>>>>,
    ) -> Self {
        let root = registry
            .plugins_dir()
            .parent()
            .expect("hooks directory")
            .to_path_buf();
        let outbox = Self {
            inner: Arc::new(Inner {
                wake: registry.change_signal(),
                registry,
                database: root.join("turn-completed.sqlite"),
                artifacts: root.join("artifacts/turn-completed"),
                events,
                started: AtomicBool::new(false),
                progress: Notify::new(),
            }),
        };
        if outbox.inner.database.exists() {
            outbox.start();
        }
        outbox
    }

    pub async fn enqueue(
        &self,
        input: TurnCompletedInput,
        range: Option<GitTurnRange>,
    ) -> Result<TurnHookReceipt, String> {
        let status = input.status.clone();
        let targets = self
            .inner
            .registry
            .discover()
            .into_iter()
            .filter(|plugin| plugin.enabled && plugin.health == HookHealth::Ready)
            .flat_map(|plugin| {
                let status = status.clone();
                plugin.hooks.into_iter().filter_map(move |hook| {
                    (hook.event_name == HookEventName::TurnCompleted
                        && hook.matcher.is_match(&status))
                    .then(|| Target {
                        plugin_id: plugin.manifest.id.clone(),
                        handler_id: hook.handler_id,
                        config: hook.config,
                    })
                })
            })
            .collect();
        let artifacts = self.inner.artifacts.clone();
        let path = self.inner.database.clone();
        let receipt = tokio::task::spawn_blocking(move || {
            Store::enqueue_at(&path, input, range, targets, &artifacts)
        })
        .await
        .map_err(|error| error.to_string())??;
        self.start();
        self.inner.wake.notify_one();
        Ok(receipt)
    }

    pub fn start(&self) {
        if !self.inner.database.exists()
            || tokio::runtime::Handle::try_current().is_err()
            || self.inner.started.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        let owner = format!(
            "{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        // Exactly one bounded worker owns this outbox instance. SQLite leases
        // also prevent overlap with an older executor that is still stopping.
        tokio::spawn(async move {
            let _guard = WorkerGuard {
                inner: weak.clone(),
                owner: owner.clone(),
            };
            while let Some(inner) = weak.upgrade() {
                if let Err(error) = release_discarded(&inner).await {
                    eprintln!("turn hook duplicate range cleanup failed: {error}");
                }
                let claim_owner = owner.clone();
                let plugins = active_plugins(&inner);
                let event = database(&inner, move |store| {
                    store.claim(now(), &claim_owner, &plugins)
                })
                .await;
                match event {
                    Ok(Some(event)) => {
                        let id = event.id;
                        if let Err(error) =
                            process_with_lease(Arc::clone(&inner), event, &owner).await
                        {
                            eprintln!("turn hook delivery failed: {error}");
                            let retry_owner = owner.clone();
                            if let Err(error) = database(&inner, move |store| {
                                store.retry_event(id, &retry_owner, now(), &error)
                            })
                            .await
                            {
                                eprintln!("turn hook retry persistence failed: {error}");
                            }
                        }
                        inner.progress.notify_waiters();
                        continue;
                    }
                    Ok(None) => {}
                    Err(error) => eprintln!("turn hook queue failed: {error}"),
                }
                let wake = Arc::clone(&inner.wake);
                inner.progress.notify_waiters();
                let plugins = active_plugins(&inner);
                let due = match database(&inner, move |store| store.next_due(&plugins)).await {
                    Ok(due) => due,
                    Err(error) => {
                        eprintln!("turn hook scheduling failed: {error}");
                        Some(now() + 5000)
                    }
                };
                drop(inner);
                if let Some(due) = due {
                    let delay = Duration::from_millis((due - now()).max(1) as u64);
                    tokio::select! { _ = wake.notified() => {}, _ = tokio::time::sleep(delay) => {} }
                } else {
                    wake.notified().await;
                }
            }
        });
    }

    /// Waits for currently available consumers, including retries. Unavailable
    /// plugins retain pending work without holding this barrier. Callers that
    /// require a shutdown deadline should wrap this in their own timeout.
    pub async fn flush(&self) -> Result<(), String> {
        if !self.inner.database.exists() {
            return Ok(());
        }
        self.start();
        loop {
            let progress = self.inner.progress.notified();
            tokio::pin!(progress);
            progress.as_mut().enable();
            let plugins = active_plugins(&self.inner);
            if database(&self.inner, move |store| store.deliverable(&plugins)).await? == 0 {
                return Ok(());
            }
            self.inner.wake.notify_one();
            progress.await;
        }
    }
}

fn active_plugins(inner: &Inner) -> Vec<String> {
    inner
        .registry
        .discover()
        .into_iter()
        .filter(|plugin| plugin.enabled && plugin.health == HookHealth::Ready)
        .map(|plugin| plugin.manifest.id)
        .collect()
}

struct WorkerGuard {
    inner: std::sync::Weak<Inner>,
    owner: String,
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            // A runtime shutdown drops the worker. Release its leases before
            // the same service is reused by a replacement runtime.
            if let Err(error) =
                Store::open(&inner.database).and_then(|store| store.release_owner(&self.owner))
            {
                eprintln!("turn hook worker lease cleanup failed: {error}");
            }
            inner.started.store(false, Ordering::SeqCst);
            inner.progress.notify_waiters();
            inner.wake.notify_one();
        }
    }
}

async fn release_discarded(inner: &Inner) -> Result<(), String> {
    if let Some((serialized, range)) = database(inner, |store| store.discarded_range(now())).await?
    {
        let result = tokio::task::spawn_blocking(move || range.release())
            .await
            .map_err(|error| error.to_string())?;
        if let Err(error) = result {
            database(inner, move |store| {
                store.retry_discarded(&serialized, now())
            })
            .await?;
            return Err(error);
        }
        database(inner, move |store| store.discard_released(&serialized)).await?;
        inner.progress.notify_waiters();
    }
    Ok(())
}

fn normalize_input(input: &mut TurnCompletedInput) -> Result<(), String> {
    if input.session_id.trim().is_empty() || input.turn_id.trim().is_empty() {
        return Err("TurnCompleted requires a session and turn ID".to_owned());
    }
    let fields = input
        .file_changes
        .as_object_mut()
        .ok_or("TurnCompleted file_changes must be an object")?;
    if fields
        .get("diff")
        .is_some_and(|value| value.as_str() != Some(""))
        || fields
            .get("files")
            .is_some_and(|value| value.as_array().map_or(true, |files| !files.is_empty()))
    {
        return Err(
            "TurnCompleted requires file artifacts instead of inline diff or files".to_owned(),
        );
    }
    fields.remove("diff");
    fields.remove("files");
    Ok(())
}

async fn process_with_lease(inner: Arc<Inner>, event: Event, owner: &str) -> Result<(), String> {
    let id = event.id;
    let process = process_event(Arc::clone(&inner), event, owner);
    tokio::pin!(process);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            result = &mut process => return result,
            _ = heartbeat.tick() => {
                let owner = owner.to_owned();
                database(&inner,move |store| store.renew(id,&owner,now())).await?;
            }
        }
    }
}

async fn process_event(inner: Arc<Inner>, mut event: Event, owner: &str) -> Result<(), String> {
    if !event.ready {
        if !event.deliveries.is_empty() {
            if let Some(range) = &event.range {
                let range = range.clone();
                let directory = event.directory.clone();
                event.input.file_changes =
                    tokio::task::spawn_blocking(move || range.materialize(&directory))
                        .await
                        .map_err(|error| error.to_string())??;
            }
        }
        let input = event.input.clone();
        let owner = owner.to_owned();
        let id = event.id;
        database(&inner, move |store| store.ready(id, &owner, &input)).await?;
    }
    if let Some(range) = event.range.take() {
        tokio::task::spawn_blocking(move || range.release())
            .await
            .map_err(|error| error.to_string())??;
        let owner = owner.to_owned();
        let id = event.id;
        database(&inner, move |store| store.released(id, &owner)).await?;
    }
    for delivery in event.deliveries {
        let started_at = now();
        let started = Instant::now();
        let target = delivery.target;
        let Some(plugin) = inner.registry.discover().into_iter().find(|plugin| {
            plugin.manifest.id == target.plugin_id
                && plugin.enabled
                && plugin.health == HookHealth::Ready
        }) else {
            continue;
        };
        let outcome = execute_command_hook(
            &target.config,
            &plugin.directory,
            &event.input.cwd,
            &event.input,
        )
        .await;
        let succeeded = outcome.exit_code == Some(0) && !outcome.timed_out;
        let run = summary(
            target.plugin_id,
            target.handler_id,
            started_at,
            started.elapsed(),
            outcome,
        );
        if let Err(error) = inner.registry.record_run(run.clone()) {
            eprintln!("turn hook run summary failed: {error}");
        }
        emit_run_event(&inner.events, &run);
        let owner = owner.to_owned();
        let id = event.id;
        database(&inner, move |store| {
            if succeeded {
                store.acknowledge(delivery.id, id, &owner)
            } else {
                store.retry_delivery(delivery.id, id, &owner, now(), &run.stderr_preview)
            }
        })
        .await?;
    }
    let id = event.id;
    let finish_owner = owner.to_owned();
    if database(&inner, move |store| store.finish(id, &finish_owner)).await? {
        // Completed tombstones retain event identity, never source-code payloads.
        // All handlers have archived or consumed these immutable source files.
        let directory = event.directory;
        tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        })
        .await
        .map_err(|error| error.to_string())??;
        let owner = owner.to_owned();
        database(&inner, move |store| store.complete(id, &owner)).await?;
    }
    Ok(())
}

async fn database<T: Send + 'static>(
    inner: &Inner,
    operation: impl FnOnce(&mut Store) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let path = inner.database.clone();
    tokio::task::spawn_blocking(move || operation(&mut Store::open(&path)?))
        .await
        .map_err(|error| error.to_string())?
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
#[path = "turn_delivery/tests.rs"]
mod tests;
