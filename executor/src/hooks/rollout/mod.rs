// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod parser;
mod scan;
mod store;

use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio::sync::broadcast;

use super::{
    command::execute_command_hook,
    host::{emit_run_event, summary},
    matcher::matches_tool,
    model::{HookHealth, HookUser, CODEX_ROLLOUT_SUBSCRIPTION},
    registry::{HookRegistryStore, ResolvedHookPlugin},
};
use store::{SessionContext, Store};

const SCAN_INTERVAL: Duration = Duration::from_secs(2);
const DELIVER_INTERVAL: Duration = Duration::from_millis(250);

/// Durable Codex rollout observer.
///
/// `PostToolUse` hooks are dispatched from the live turn stream, so they only
/// cover the thread the turn runs on and only while the executor is watching.
/// Codex persists every thread as a rollout under the isolated Codex Home, but
/// files written by a subagent thread, or while the executor was not watching,
/// never reach a hook that way. This observer tails those rollouts instead,
/// resolves every thread to the task thread that owns it, and feeds the plugins
/// subscribed to [`CODEX_ROLLOUT_SUBSCRIPTION`] with the resulting file
/// changes. Pending deliveries live in SQLite, so a plugin that cannot accept
/// one yet is retried instead of silently dropped.
#[derive(Clone)]
pub struct CodexRolloutObserver {
    inner: Arc<Inner>,
}

struct Inner {
    database: PathBuf,
    codex_home: PathBuf,
    started: AtomicBool,
    unresolved: AtomicU64,
}

impl CodexRolloutObserver {
    pub fn new(database: PathBuf, codex_home: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                database,
                codex_home,
                started: AtomicBool::new(false),
                unresolved: AtomicU64::new(0),
            }),
        }
    }

    /// Registers the Codex thread a routed turn runs on. Rollout edits are
    /// reported with the user and workspace of that turn, and a thread no
    /// routed turn started is only adopted when a registered thread spawned it.
    pub fn register_root(
        &self,
        thread_id: &str,
        user: HookUser,
        cwd: PathBuf,
        model: Option<String>,
    ) -> Result<(), String> {
        if thread_id.trim().is_empty() {
            return Ok(());
        }
        self.inner.with_store(|store| {
            store.register_root(
                thread_id,
                &SessionContext {
                    user,
                    cwd,
                    model,
                    git_url: None,
                    since: now(),
                },
            )
        })
    }

    pub(super) fn start(
        &self,
        registry: HookRegistryStore,
        events: Arc<Mutex<Option<broadcast::Sender<Value>>>>,
    ) {
        // The observer is driven by background tasks, so it only starts from a
        // Tokio runtime. Constructions outside one simply never observe.
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        if self.inner.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        let scan_registry = registry.clone();
        tokio::spawn(async move {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let home = inner.codex_home.clone();
            // Rollouts that already exist are history: only what is appended
            // from now on belongs to the turns this process observes.
            let startup = tokio::task::spawn_blocking(move || {
                let mut paths = BTreeSet::new();
                let mut collected = Vec::new();
                for dir in ["sessions", "archived_sessions"] {
                    if let Err(error) = scan::collect_paths(&home.join(dir), &mut collected) {
                        eprintln!("codex rollout startup scan failed: {error}");
                    }
                }
                paths.extend(collected);
                paths
            })
            .await
            .unwrap_or_default();
            drop(inner);
            while let Some(inner) = weak.upgrade() {
                let registry = scan_registry.clone();
                let startup = startup.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let subscribers = subscribed_plugins(&registry);
                    if !subscribers.installed {
                        // Nothing subscribes yet, so there is nothing to
                        // observe. An install is picked up on the next pass.
                        return Ok(());
                    }
                    inner.with_store(|store| {
                        scan::scan(store, &inner.codex_home, subscribers.enabled, &startup)
                            .map(|outcome| log_scan_outcome(&inner, &outcome))
                    })
                })
                .await;
                match result {
                    Ok(Ok(())) => {}
                    other => eprintln!("codex rollout observer failed: {other:?}"),
                }
                tokio::time::sleep(SCAN_INTERVAL).await;
            }
        });
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            while let Some(inner) = weak.upgrade() {
                if let Err(error) = deliver(&inner, &registry, &events).await {
                    eprintln!("codex rollout delivery failed: {error}");
                }
                drop(inner);
                tokio::time::sleep(DELIVER_INTERVAL).await;
            }
        });
    }
}

impl Inner {
    fn with_store<T>(
        &self,
        action: impl FnOnce(&mut Store) -> Result<T, String>,
    ) -> Result<T, String> {
        // Separate connections keep a long log scan from holding a process-wide
        // mutex across thread registration or delivery acknowledgements.
        action(&mut Store::open(&self.database)?)
    }
}

/// Registry state of the plugins that take `PostToolUse` from the rollout log
/// rather than from the live turn stream.
struct Subscribers {
    installed: bool,
    enabled: bool,
    delivering: Vec<ResolvedHookPlugin>,
}

fn subscribed_plugins(registry: &HookRegistryStore) -> Subscribers {
    let mut subscribers = Subscribers {
        installed: false,
        enabled: false,
        delivering: Vec::new(),
    };
    for plugin in registry.discover() {
        if !plugin.manifest.subscribes(CODEX_ROLLOUT_SUBSCRIPTION) {
            continue;
        }
        subscribers.installed = true;
        subscribers.enabled |= plugin.enabled;
        if plugin.enabled && plugin.health == HookHealth::Ready {
            subscribers.delivering.push(plugin);
        }
    }
    subscribers
}

async fn deliver(
    inner: &Inner,
    registry: &HookRegistryStore,
    events: &Arc<Mutex<Option<broadcast::Sender<Value>>>>,
) -> Result<(), String> {
    let Some((id, input)) = inner.with_store(|store| store.next(now()))? else {
        return Ok(());
    };
    let subscribers = subscribed_plugins(registry);
    if subscribers.delivering.is_empty() {
        return Ok(());
    }
    let mut deliveries = 0;
    let mut succeeded = true;
    for plugin in subscribers.delivering {
        let plugin_dir = plugin.directory.clone();
        let plugin_id = plugin.manifest.id.clone();
        for hook in plugin
            .hooks
            .into_iter()
            .filter(|hook| matches_tool(&hook.matcher, &input.tool_name))
        {
            deliveries += 1;
            let started = Instant::now();
            let started_at = now();
            // Workspace removal must not strand reports: the payload carries
            // absolute paths and the hook runs from its own plugin directory.
            let outcome =
                execute_command_hook(&hook.config, &plugin_dir, &plugin_dir, &input).await;
            succeeded &= outcome.exit_code == Some(0) && !outcome.timed_out;
            let run = summary(
                plugin_id.clone(),
                hook.handler_id,
                started_at,
                started.elapsed(),
                outcome,
            );
            if let Err(error) = registry.record_run(run.clone()) {
                eprintln!("codex rollout run summary write failed: {error}");
            }
            emit_run_event(events, &run);
        }
    }
    inner.with_store(|store| {
        if deliveries > 0 && succeeded {
            store.complete(id)
        } else {
            store.retry(id, now())
        }
    })
}

fn log_scan_outcome(inner: &Inner, outcome: &scan::ScanOutcome) {
    if outcome.errors > 0 {
        eprintln!("codex rollout scan errors: {}", outcome.errors);
    }
    let previous = inner
        .unresolved
        .swap(outcome.unresolved as u64, Ordering::Relaxed);
    if outcome.unresolved as u64 != previous {
        eprintln!(
            "codex rollout unresolved sessions: {} (files={})",
            outcome.unresolved, outcome.files
        );
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests;
