// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tokio::sync::broadcast;
use tokio::sync::Semaphore;

use super::{
    command::execute_command_hook,
    matcher::matches_tool,
    model::{
        HookEventName, HookHealth, HookRunStatus, HookRunSummary, PostToolUseInput,
        ResolvedHookPluginView,
    },
    registry::HookRegistryStore,
};

const MAX_ASYNC_HOOKS: usize = 4;
const DEDUP_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_DEDUP_ENTRIES: usize = 4096;

#[derive(Clone)]
pub struct HookService {
    registry: HookRegistryStore,
    capacity: Arc<Semaphore>,
    seen: Arc<Mutex<HashMap<String, Instant>>>,
    event_tx: Arc<Mutex<Option<broadcast::Sender<serde_json::Value>>>>,
}

impl HookService {
    pub fn from_env() -> Self {
        Self {
            registry: HookRegistryStore::from_env(),
            capacity: Arc::new(Semaphore::new(MAX_ASYNC_HOOKS)),
            seen: Arc::new(Mutex::new(HashMap::new())),
            event_tx: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_event_sender(&self, sender: broadcast::Sender<serde_json::Value>) {
        *self
            .event_tx
            .lock()
            .expect("hook event sender lock should not be poisoned") = Some(sender);
    }

    pub fn list(&self) -> Vec<ResolvedHookPluginView> {
        self.registry.list()
    }
    pub fn registry(&self) -> &HookRegistryStore {
        &self.registry
    }

    pub async fn dispatch(&self, input: PostToolUseInput) {
        for plugin in self.registry.discover() {
            if !plugin.enabled || plugin.health != HookHealth::Ready {
                continue;
            }
            for hook in plugin.hooks {
                if !matches_tool(&hook.matcher, &input.tool_name) {
                    continue;
                }
                let key = format!(
                    "{}:{}:{}",
                    input.tool_use_id, plugin.manifest.id, hook.handler_id
                );
                if !self.mark_once(key) {
                    continue;
                }
                let config = hook.config;
                let plugin_dir = plugin.directory.clone();
                let hook_input = input.clone();
                let plugin_id = plugin.manifest.id.clone();
                let handler_id = hook.handler_id;
                if config.asynchronous {
                    let Ok(permit) = self.capacity.clone().try_acquire_owned() else {
                        self.record_skipped(&plugin_id, &handler_id);
                        continue;
                    };
                    let registry = self.registry.clone();
                    let event_tx = Arc::clone(&self.event_tx);
                    tokio::spawn(async move {
                        let _permit = permit;
                        let started = Instant::now();
                        let started_at_ms = now_ms();
                        let outcome = execute_command_hook(
                            &config,
                            &plugin_dir,
                            &hook_input.cwd,
                            &hook_input,
                        )
                        .await;
                        let run = summary(
                            plugin_id,
                            handler_id,
                            started_at_ms,
                            started.elapsed(),
                            outcome,
                        );
                        let _ = registry.record_run(run.clone());
                        emit_run_event(&event_tx, &run);
                    });
                } else {
                    let started = Instant::now();
                    let started_at_ms = now_ms();
                    let outcome =
                        execute_command_hook(&config, &plugin_dir, &hook_input.cwd, &hook_input)
                            .await;
                    let run = summary(
                        plugin_id,
                        handler_id,
                        started_at_ms,
                        started.elapsed(),
                        outcome,
                    );
                    let _ = self.registry.record_run(run.clone());
                    emit_run_event(&self.event_tx, &run);
                }
            }
        }
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
        let input = PostToolUseInput {
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

fn emit_run_event(
    sender: &Arc<Mutex<Option<broadcast::Sender<serde_json::Value>>>>,
    run: &HookRunSummary,
) {
    if let Some(sender) = sender.lock().ok().and_then(|value| value.clone()) {
        let _ = sender
            .send(serde_json::json!({"event":"runtime.hooks.run_completed","payload":{"run":run}}));
    }
}

fn summary(
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
