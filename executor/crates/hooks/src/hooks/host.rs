// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tokio::sync::broadcast;
use tokio::sync::Semaphore;
use wegent_workspace::turn_file_changes::GitTurnRange;

use super::{
    command::execute_command_hook,
    matcher::matches_tool,
    model::{
        HookEventName, HookHealth, HookRunStatus, HookRunSummary, HookUser, PostToolUseInput,
        ResolvedHookPluginView, TurnCompletedInput, TurnHookReceipt, CODEX_ROLLOUT_SUBSCRIPTION,
    },
    registry::{HookRegistryStore, ResolvedCommandHook},
    rollout::CodexRolloutObserver,
    turn_delivery::TurnHookOutbox,
};

const MAX_ASYNC_HOOKS: usize = 4;
const DEDUP_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_DEDUP_ENTRIES: usize = 4096;
static TEST_EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct HookService {
    pub rollout: CodexRolloutObserver,
    registry: HookRegistryStore,
    capacity: Arc<Semaphore>,
    seen: Arc<Mutex<HashMap<String, Instant>>>,
    event_tx: Arc<Mutex<Option<broadcast::Sender<serde_json::Value>>>>,
    turn_outbox: TurnHookOutbox,
}

impl HookService {
    pub fn new(registry: HookRegistryStore, codex_home: PathBuf) -> Self {
        let event_tx = Arc::new(Mutex::new(None));
        let turn_outbox = TurnHookOutbox::new(registry.clone(), Arc::clone(&event_tx));
        Self {
            rollout: CodexRolloutObserver::new(
                registry
                    .plugins_dir()
                    .parent()
                    .expect("hooks directory")
                    .join("codex-rollout.sqlite"),
                codex_home,
            ),
            registry,
            capacity: Arc::new(Semaphore::new(MAX_ASYNC_HOOKS)),
            seen: Arc::new(Mutex::new(HashMap::new())),
            event_tx,
            turn_outbox,
        }
    }

    pub fn set_event_sender(&self, sender: broadcast::Sender<serde_json::Value>) {
        *self
            .event_tx
            .lock()
            .expect("hook event sender lock should not be poisoned") = Some(sender);
        self.rollout
            .start(self.registry.clone(), Arc::clone(&self.event_tx));
        self.turn_outbox.start();
    }

    pub fn list(&self) -> Vec<ResolvedHookPluginView> {
        self.registry.list()
    }
    pub fn registry(&self) -> &HookRegistryStore {
        &self.registry
    }

    pub async fn dispatch(&self, input: PostToolUseInput) {
        self.dispatch_post_tool_use(input).await;
    }

    pub fn has_turn_completed_hooks(&self) -> bool {
        self.registry.discover().iter().any(|plugin| {
            plugin.enabled
                && plugin.health == HookHealth::Ready
                && plugin
                    .hooks
                    .iter()
                    .any(|hook| hook.event_name == HookEventName::TurnCompleted)
        })
    }

    pub async fn enqueue_turn_completed(
        &self,
        input: TurnCompletedInput,
        range: Option<GitTurnRange>,
    ) -> Result<TurnHookReceipt, String> {
        self.turn_outbox.enqueue(input, range).await
    }

    pub async fn flush_turn_hooks(&self) -> Result<(), String> {
        self.turn_outbox.flush().await
    }

    async fn dispatch_post_tool_use(&self, input: PostToolUseInput) {
        for plugin in self.registry.discover() {
            if !dispatches_from_turn_stream(&plugin) {
                continue;
            }
            for hook in plugin.hooks {
                if hook.event_name != HookEventName::PostToolUse
                    || !matches_tool(&hook.matcher, &input.tool_name)
                {
                    continue;
                }
                let key = serde_json::json!([
                    input.session_id,
                    input.turn_id,
                    input.tool_use_id,
                    plugin.manifest.id,
                    hook.handler_id
                ])
                .to_string();
                if !self.mark_once(key) {
                    continue;
                }
                let plugin_dir = plugin.directory.clone();
                let hook_input = input.clone();
                let plugin_id = plugin.manifest.id.clone();
                let cwd = input.cwd.clone();
                if hook.config.asynchronous {
                    let Ok(permit) = self.capacity.clone().try_acquire_owned() else {
                        self.record_skipped(&plugin_id, &hook.handler_id);
                        continue;
                    };
                    let service = self.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        service
                            .execute_and_record(plugin_id, hook, plugin_dir, cwd, hook_input)
                            .await;
                    });
                } else {
                    self.execute_and_record(plugin_id, hook, plugin_dir, cwd, hook_input)
                        .await;
                }
            }
        }
    }

    async fn execute_and_record(
        &self,
        plugin_id: String,
        hook: ResolvedCommandHook,
        plugin_dir: PathBuf,
        cwd: PathBuf,
        input: PostToolUseInput,
    ) {
        let started = Instant::now();
        let started_at_ms = now_ms();
        let outcome = execute_command_hook(&hook.config, &plugin_dir, &cwd, &input).await;
        let run = summary(
            plugin_id,
            hook.handler_id,
            started_at_ms,
            started.elapsed(),
            outcome,
        );
        let _ = self.registry.record_run(run.clone());
        emit_run_event(&self.event_tx, &run);
    }

    pub async fn test(
        &self,
        plugin_id: &str,
        handler_id: &str,
        cwd: PathBuf,
    ) -> Result<HookRunSummary, String> {
        let plugin = self
            .registry
            .discover()
            .into_iter()
            .find(|plugin| plugin.manifest.id == plugin_id)
            .ok_or("hook plugin not found")?;
        let hook = plugin
            .hooks
            .into_iter()
            .find(|hook| hook.handler_id == handler_id)
            .ok_or("hook handler not found")?;
        let input = match hook.event_name {
            HookEventName::PostToolUse => serde_json::to_value(PostToolUseInput {
                user: HookUser {
                    id: None,
                    name: "anonymous".to_owned(),
                },
                session_id: "hook-test-session".to_owned(),
                turn_id: "hook-test-turn".to_owned(),
                agent_id: None,
                agent_type: None,
                transcript_path: None,
                cwd: cwd.clone(),
                hook_event_name: HookEventName::PostToolUse,
                model: None,
                permission_mode: "workspace-write".to_owned(),
                tool_name: "apply_patch".to_owned(),
                tool_use_id: "hook-test-call".to_owned(),
                tool_input: serde_json::json!({"changes": []}),
                tool_response: serde_json::json!({"status":"completed"}),
            }).map_err(|error| error.to_string())?,
            HookEventName::TurnCompleted => serde_json::to_value(TurnCompletedInput {
                event_id: format!("hook-test-{}-{}-{}",std::process::id(),now_ms(),TEST_EVENT_SEQUENCE.fetch_add(1,Ordering::Relaxed)),
                sequence: 0,
                user: HookUser {
                    id: None,
                    name: "anonymous".to_owned(),
                },
                session_id: "hook-test-session".to_owned(),
                turn_id: "hook-test-turn".to_owned(),
                cwd: cwd.clone(),
                hook_event_name: HookEventName::TurnCompleted,
                model: None,
                permission_mode: "workspace-write".to_owned(),
                status: "completed".to_owned(),
                file_changes: serde_json::json!({"version":2,"status":"error","file_count":0,"additions":0,"deletions":0,"error":"Synthetic hook test has no captured turn artifacts"}),
            }).map_err(|error| error.to_string())?,
        };
        let started = Instant::now();
        let started_at_ms = now_ms();
        let outcome = execute_command_hook(&hook.config, &plugin.directory, &cwd, &input).await;
        let run = summary(
            plugin_id.to_owned(),
            handler_id.to_owned(),
            started_at_ms,
            started.elapsed(),
            outcome,
        );
        self.registry.record_run(run.clone())?;
        emit_run_event(&self.event_tx, &run);
        Ok(run)
    }

    fn record_skipped(&self, plugin_id: &str, handler_id: &str) {
        let started = now_ms();
        let _ = self.registry.record_run(HookRunSummary {
            run_id: format!("hook-{started}"),
            plugin_id: plugin_id.to_owned(),
            handler_id: handler_id.to_owned(),
            status: HookRunStatus::SkippedCapacity,
            started_at_ms: started,
            duration_ms: 0,
            exit_code: None,
            stdout_preview: String::new(),
            stderr_preview: "async hook capacity exhausted".to_owned(),
            stdout_truncated: false,
            stderr_truncated: false,
        });
    }

    fn mark_once(&self, key: String) -> bool {
        let now = Instant::now();
        let mut seen = self
            .seen
            .lock()
            .expect("hook dedup lock should not be poisoned");
        seen.retain(|_, timestamp| now.duration_since(*timestamp) < DEDUP_TTL);
        if seen.contains_key(&key) {
            return false;
        }
        if seen.len() >= MAX_DEDUP_ENTRIES {
            if let Some(oldest) = seen
                .iter()
                .min_by_key(|(_, time)| **time)
                .map(|(key, _)| key.clone())
            {
                seen.remove(&oldest);
            }
        }
        seen.insert(key, now);
        true
    }
}

pub(super) fn emit_run_event(
    sender: &Arc<Mutex<Option<broadcast::Sender<serde_json::Value>>>>,
    run: &HookRunSummary,
) {
    if let Some(sender) = sender.lock().ok().and_then(|value| value.clone()) {
        let _ = sender
            .send(serde_json::json!({"event":"runtime.hooks.run_completed","payload":{"run":run}}));
    }
}

pub(super) fn summary(
    plugin_id: String,
    handler_id: String,
    started_at_ms: i64,
    duration: Duration,
    outcome: super::model::CommandHookOutcome,
) -> HookRunSummary {
    let status = if outcome.timed_out {
        HookRunStatus::TimedOut
    } else if outcome.exit_code == Some(0) {
        HookRunStatus::Succeeded
    } else {
        HookRunStatus::Failed
    };
    HookRunSummary {
        run_id: format!("hook-{started_at_ms}"),
        plugin_id,
        handler_id,
        status,
        started_at_ms,
        duration_ms: duration.as_millis().min(u128::from(u64::MAX)) as u64,
        exit_code: outcome.exit_code,
        stdout_preview: outcome.stdout,
        stderr_preview: outcome.stderr,
        stdout_truncated: outcome.stdout_truncated,
        stderr_truncated: outcome.stderr_truncated,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

/// A plugin that subscribed to the durable rollout feed receives its
/// `PostToolUse` events from the rollout observer, so the live turn stream must
/// not dispatch to it as well: every edit would be reported twice.
fn dispatches_from_turn_stream(plugin: &super::registry::ResolvedHookPlugin) -> bool {
    plugin.enabled
        && plugin.health == HookHealth::Ready
        && !plugin.manifest.subscribes(CODEX_ROLLOUT_SUBSCRIPTION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::model::HookPluginManifest;
    use crate::hooks::registry::ResolvedHookPlugin;

    fn plugin(subscriptions: &[&str], enabled: bool, health: HookHealth) -> ResolvedHookPlugin {
        ResolvedHookPlugin {
            manifest: HookPluginManifest {
                schema_version: 1,
                id: "example".to_owned(),
                name: "example".to_owned(),
                description: String::new(),
                version: "1.0.0".to_owned(),
                subscriptions: subscriptions
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
            },
            enabled,
            source: crate::hooks::model::HookSource::User,
            directory: PathBuf::from("/hooks/plugins/example"),
            policy: crate::hooks::model::HookPolicy::for_source(
                crate::hooks::model::HookSource::User,
            ),
            health,
            hooks: Vec::new(),
        }
    }

    #[test]
    fn rollout_subscribers_are_not_dispatched_from_the_turn_stream() {
        assert!(!dispatches_from_turn_stream(&plugin(
            &[CODEX_ROLLOUT_SUBSCRIPTION],
            true,
            HookHealth::Ready,
        )));
    }

    #[test]
    fn other_ready_plugins_are_dispatched_from_the_turn_stream() {
        assert!(dispatches_from_turn_stream(&plugin(
            &[],
            true,
            HookHealth::Ready
        )));
        assert!(!dispatches_from_turn_stream(&plugin(
            &[],
            false,
            HookHealth::Disabled
        )));
    }
}

#[cfg(test)]
#[path = "turn_completed_tests.rs"]
mod turn_completed_tests;
