// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cumulative, process-local counters for committed assistant execution attempts.
//!
//! Callers record a terminal result only after its guarded state transition has
//! committed. Callback replay and attempt identity belong to that lifecycle;
//! this registry does not retain task, response, or user identifiers.

use std::{
    collections::BTreeMap,
    fmt::Write,
    sync::{Mutex, MutexGuard, OnceLock},
};

use serde_json::{Value, json};
use wegent_protocol::chat_errors::classify_chat_error;

const ENTRYPOINTS: [&str; 5] = ["web", "wework", "api", "automation", "other"];
const SHELLS: [&str; 6] = ["Codex", "ClaudeCode", "Agno", "Dify", "Chat", "unknown"];
const EXECUTION_MODES: [&str; 3] = ["local", "remote", "unknown"];
const STAGES: [&str; 8] = [
    "validate", "dispatch", "prepare", "model", "tool", "stream", "persist", "unknown",
];

/// Fixed labels derived from trusted execution context, never raw identifiers.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct RunLabels {
    entrypoint: &'static str,
    shell: &'static str,
    execution_mode: &'static str,
}

impl RunLabels {
    pub fn new(entrypoint: &str, shell: &str, execution_mode: &str) -> Self {
        Self {
            entrypoint: known_label(entrypoint, &ENTRYPOINTS, "other"),
            shell: known_label(shell, &SHELLS, "unknown"),
            execution_mode: known_label(execution_mode, &EXECUTION_MODES, "unknown"),
        }
    }

    /// Recover attempt labels persisted when execution starts. Older attempts
    /// derive only origin and executor placement from established task fields.
    pub fn from_task(
        task_json: Option<&Value>,
        result: Option<&Value>,
        executor_name: Option<&str>,
        client_origin: Option<&str>,
    ) -> Self {
        let entrypoint = task_entrypoint(task_json, client_origin);
        let execution_mode = match executor_name.map(str::trim) {
            Some(name) if name.starts_with("device-") => "local",
            Some(name) if !name.is_empty() => "remote",
            _ => "unknown",
        };
        let metadata = result
            .and_then(|value| value.get("_chat_metrics"))
            .and_then(Value::as_object);
        let label = |name: &str| {
            metadata
                .and_then(|value| value.get(name))
                .and_then(Value::as_str)
        };
        let persisted_mode = label("execution_mode")
            .map(|mode| known_label(mode, &EXECUTION_MODES, "unknown"))
            .unwrap_or("unknown");
        Self {
            entrypoint: known_label(
                label("entrypoint").unwrap_or(entrypoint),
                &ENTRYPOINTS,
                entrypoint,
            ),
            shell: known_label(label("shell").unwrap_or("unknown"), &SHELLS, "unknown"),
            // Executor binding normally persists the final placement. A startup
            // snapshot can race it and record `unknown`; the bound executor is
            // then the authoritative fallback for the terminal observation.
            execution_mode: if persisted_mode == "unknown" {
                execution_mode
            } else {
                persisted_mode
            },
        }
    }

    pub fn metadata(self) -> Value {
        json!({
            "entrypoint": self.entrypoint,
            "shell": self.shell,
            "execution_mode": self.execution_mode,
        })
    }

    pub fn with_shell(self, shell: &str) -> Self {
        Self::new(self.entrypoint, shell, self.execution_mode)
    }
}

fn task_entrypoint(task_json: Option<&Value>, client_origin: Option<&str>) -> &'static str {
    let labels = task_json.and_then(|value| value.pointer("/metadata/labels"));
    if labels
        .and_then(|value| value.get("is_api_call"))
        .and_then(Value::as_str)
        == Some("true")
    {
        "api"
    } else if labels
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        == Some("subscription")
        || labels
            .and_then(|value| value.get("source"))
            .and_then(Value::as_str)
            == Some("project_automation")
    {
        "automation"
    } else {
        match client_origin {
            Some("frontend") => "web",
            Some("wework") => "wework",
            _ => "other",
        }
    }
}

impl Default for RunLabels {
    fn default() -> Self {
        Self::new("other", "unknown", "unknown")
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Outcome {
    Success,
    Failed,
    Cancelled,
}

impl Outcome {
    fn from_status(status: &str) -> Option<Self> {
        if status.eq_ignore_ascii_case("COMPLETED") || status.eq_ignore_ascii_case("success") {
            Some(Self::Success)
        } else if status.eq_ignore_ascii_case("FAILED") {
            Some(Self::Failed)
        } else if status.eq_ignore_ascii_case("CANCELLED") {
            Some(Self::Cancelled)
        } else {
            None
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct FailureKey {
    category: &'static str,
    code: &'static str,
    stage: &'static str,
    labels: RunLabels,
}

struct Registry {
    runs: BTreeMap<(RunLabels, Outcome), u64>,
    failures: BTreeMap<FailureKey, u64>,
    requests: BTreeMap<(&'static str, bool), u64>,
}

impl Default for Registry {
    fn default() -> Self {
        let labels = RunLabels::default();
        let unknown = classify_chat_error(None, None);
        let mut registry = Self {
            runs: BTreeMap::new(),
            failures: BTreeMap::from([(
                FailureKey {
                    category: unknown.category,
                    code: unknown.code,
                    stage: "unknown",
                    labels,
                },
                0,
            )]),
            requests: BTreeMap::new(),
        };
        // Expose a small baseline, then initialize run outcomes per observed
        // label set instead of preallocating every error/stage combination.
        registry.ensure_outcomes(labels);
        for entrypoint in ENTRYPOINTS {
            registry.requests.insert((entrypoint, false), 0);
            registry.requests.insert((entrypoint, true), 0);
        }
        registry
    }
}

impl Registry {
    fn ensure_outcomes(&mut self, labels: RunLabels) {
        for outcome in [Outcome::Success, Outcome::Failed, Outcome::Cancelled] {
            self.runs.entry((labels, outcome)).or_default();
        }
    }

    fn record_terminal(
        &mut self,
        status: &str,
        code: Option<&str>,
        message: Option<&str>,
        stage: &str,
        labels: RunLabels,
    ) {
        let Some(outcome) = Outcome::from_status(status) else {
            return;
        };
        self.ensure_outcomes(labels);
        increment(&mut self.runs, (labels, outcome));
        if outcome == Outcome::Failed {
            let error = classify_chat_error(code, message);
            increment(
                &mut self.failures,
                FailureKey {
                    category: error.category,
                    code: error.code,
                    stage: known_label(stage, &STAGES, "unknown"),
                    labels,
                },
            );
        }
    }

    fn record_request(&mut self, accepted: bool, entrypoint: &str) {
        increment(
            &mut self.requests,
            (known_label(entrypoint, &ENTRYPOINTS, "other"), accepted),
        );
    }

    fn prometheus(&self) -> String {
        let mut text = String::new();
        text.push_str(
            "# HELP wegent_chat_runs_total Committed assistant execution attempts by terminal outcome\n\
             # TYPE wegent_chat_runs_total counter\n",
        );
        for ((labels, outcome), count) in &self.runs {
            let _ = writeln!(
                text,
                "wegent_chat_runs_total{{outcome=\"{}\",entrypoint=\"{}\",shell=\"{}\",execution_mode=\"{}\"}} {}",
                outcome.label(),
                labels.entrypoint,
                labels.shell,
                labels.execution_mode,
                count,
            );
        }
        text.push_str(
            "# HELP wegent_chat_run_failures_total Failed assistant execution attempts by classified cause\n\
             # TYPE wegent_chat_run_failures_total counter\n",
        );
        for (failure, count) in &self.failures {
            let labels = failure.labels;
            let _ = writeln!(
                text,
                "wegent_chat_run_failures_total{{error_category=\"{}\",error_code=\"{}\",stage=\"{}\",entrypoint=\"{}\",shell=\"{}\",execution_mode=\"{}\"}} {}",
                failure.category,
                failure.code,
                failure.stage,
                labels.entrypoint,
                labels.shell,
                labels.execution_mode,
                count,
            );
        }
        text.push_str(
            "# HELP wegent_chat_requests_total Chat send requests by admission outcome\n\
             # TYPE wegent_chat_requests_total counter\n",
        );
        for ((entrypoint, accepted), count) in &self.requests {
            let outcome = if *accepted { "accepted" } else { "rejected" };
            let _ = writeln!(
                text,
                "wegent_chat_requests_total{{outcome=\"{outcome}\",entrypoint=\"{entrypoint}\"}} {count}",
            );
        }
        text
    }
}

fn known_label(value: &str, allowed: &[&'static str], unknown: &'static str) -> &'static str {
    allowed
        .iter()
        .copied()
        .find(|label| value.eq_ignore_ascii_case(label))
        .unwrap_or(unknown)
}

fn increment<K: Ord>(counts: &mut BTreeMap<K, u64>, key: K) {
    let count = counts.entry(key).or_default();
    *count = count.saturating_add(1);
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

fn lock_registry(registry: &Mutex<Registry>) -> MutexGuard<'_, Registry> {
    registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record exactly one guarded, committed terminal state transition.
pub fn record_terminal(
    status: &str,
    code: Option<&str>,
    message: Option<&str>,
    stage: &str,
    labels: RunLabels,
) {
    lock_registry(registry()).record_terminal(status, code, message, stage, labels);
}

pub fn record_request(accepted: bool, entrypoint: &str) {
    lock_registry(registry()).record_request(accepted, entrypoint);
}

/// Observe one request, including rejected admissions and early-return paths.
pub struct RequestObservation {
    entrypoint: &'static str,
    accepted: bool,
}

impl RequestObservation {
    pub fn new(entrypoint: &str) -> Self {
        Self {
            entrypoint: known_label(entrypoint, &ENTRYPOINTS, "other"),
            accepted: false,
        }
    }

    /// Mark admission only after its transaction successfully commits.
    pub fn accept(&mut self) {
        self.accepted = true;
    }
}

impl Drop for RequestObservation {
    fn drop(&mut self) {
        record_request(self.accepted, self.entrypoint);
    }
}

/// Scrape one coherent snapshot without draining any cumulative counter.
pub fn prometheus() -> String {
    lock_registry(registry()).prometheus()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_attempt_labels_survive_task_and_executor_changes() {
        let labels = RunLabels::new("wework", "Codex", "local");
        let result = json!({"_chat_metrics": labels.metadata()});
        let task = json!({"metadata": {"labels": {"is_api_call": "true"}}});
        assert_eq!(
            RunLabels::from_task(
                Some(&task),
                Some(&result),
                Some("remote-executor"),
                Some("frontend")
            ),
            labels,
        );
        assert_eq!(
            labels.with_shell("ClaudeCode"),
            RunLabels::new("wework", "ClaudeCode", "local"),
        );
    }

    #[test]
    fn bound_executor_refines_an_unknown_startup_mode() {
        let startup = json!({"_chat_metrics": {
            "entrypoint": "wework",
            "shell": "Codex",
            "execution_mode": "unknown",
        }});
        assert_eq!(
            RunLabels::from_task(None, Some(&startup), Some("device-123"), None),
            RunLabels::new("wework", "Codex", "local"),
        );
        assert_eq!(
            RunLabels::from_task(None, Some(&startup), Some("remote-executor"), None),
            RunLabels::new("wework", "Codex", "remote"),
        );
    }

    #[test]
    fn older_attempts_use_established_origin_and_executor_fields() {
        let api_task = json!({"metadata": {"labels": {"is_api_call": "true"}}});
        let subscription = json!({"metadata": {"labels": {"type": "subscription"}}});
        let automation = json!({"metadata": {"labels": {"source": "project_automation"}}});
        assert_eq!(
            RunLabels::from_task(
                Some(&api_task),
                None,
                Some("remote-executor"),
                Some("frontend")
            ),
            RunLabels::new("api", "unknown", "remote"),
        );
        assert_eq!(
            RunLabels::from_task(Some(&subscription), None, None, Some("frontend")),
            RunLabels::new("automation", "unknown", "unknown"),
        );
        assert_eq!(
            RunLabels::from_task(Some(&automation), None, None, Some("frontend")),
            RunLabels::new("automation", "unknown", "unknown"),
        );
        assert_eq!(
            RunLabels::from_task(None, None, Some(" device-123 "), Some("wework")),
            RunLabels::new("wework", "unknown", "local"),
        );
        assert_eq!(
            RunLabels::from_task(None, None, Some("  "), Some("frontend")),
            RunLabels::new("web", "unknown", "unknown"),
        );
    }

    #[test]
    fn invalid_metadata_and_unproven_task_aliases_do_not_become_labels() {
        let task = json!({
            "clientOrigin": "wework",
            "taskSource": "automation",
            "metadata": {"labels": {"source": "chat_shell"}},
        });
        let result = json!({"_chat_metrics": {
            "entrypoint": "private-user-123",
            "shell": "private-device-123",
            "execution_mode": "private-executor-123",
        }});
        assert_eq!(
            RunLabels::from_task(
                Some(&task),
                Some(&result),
                Some("device-123"),
                Some("frontend")
            ),
            RunLabels::new("web", "unknown", "local"),
        );
        assert_eq!(
            RunLabels::from_task(Some(&task), None, None, None),
            RunLabels::default(),
        );
    }

    #[test]
    fn failed_outcomes_match_classified_counts_and_scrapes_do_not_drain() {
        let mut registry = Registry::default();
        let labels = RunLabels::new("web", "Codex", "remote");
        registry.record_terminal(
            "FAILED",
            None,
            Some("Agent Skills directory contains unmanaged entries"),
            "prepare",
            labels,
        );
        registry.record_terminal("FAILED", Some("rate_limit"), None, "model", labels);
        registry.record_terminal("COMPLETED", None, None, "model", labels);
        registry.record_request(true, "web");
        registry.record_request(false, "web");

        let body = registry.prometheus();
        assert_eq!(body, registry.prometheus());
        assert_eq!(registry.runs[&(labels, Outcome::Failed)], 2);
        assert_eq!(registry.failures.values().sum::<u64>(), 2);
        assert!(body.contains(
            "wegent_chat_run_failures_total{error_category=\"runtime\",error_code=\"skills_unmanaged_entries\",stage=\"prepare\",entrypoint=\"web\",shell=\"Codex\",execution_mode=\"remote\"} 1\n",
        ));
        assert!(
            body.contains(
                "wegent_chat_requests_total{outcome=\"accepted\",entrypoint=\"web\"} 1\n",
            )
        );
        assert!(
            body.contains(
                "wegent_chat_requests_total{outcome=\"rejected\",entrypoint=\"web\"} 1\n",
            )
        );
    }

    #[test]
    fn cancellation_is_a_terminal_outcome_and_pending_states_are_not() {
        let mut registry = Registry::default();
        let labels = RunLabels::new("wework", "ClaudeCode", "local");
        registry.record_terminal("CANCELLED", Some("network_error"), None, "stream", labels);
        registry.record_terminal("RUNNING", None, None, "model", labels);
        registry.record_terminal("DELETE", None, None, "persist", labels);
        assert_eq!(registry.runs[&(labels, Outcome::Cancelled)], 1);
        assert_eq!(registry.runs[&(labels, Outcome::Failed)], 0);
        assert_eq!(registry.failures.values().sum::<u64>(), 0);
        assert_eq!(registry.runs.values().sum::<u64>(), 1);
    }

    #[test]
    fn unknown_codes_and_dynamic_labels_do_not_leak_or_drop_failures() {
        let mut registry = Registry::default();
        let private = "private-task-123\"\nsensitive-token-value";
        let labels = RunLabels::new(private, private, private);
        registry.record_terminal("FAILED", Some(private), Some(private), private, labels);
        registry.record_request(false, private);
        let body = registry.prometheus();
        assert!(!body.contains("private-task"));
        assert!(!body.contains("sensitive-token-value"));
        assert_eq!(registry.failures.values().sum::<u64>(), 1);
        assert_eq!(registry.runs[&(RunLabels::default(), Outcome::Failed)], 1);
        assert!(
            body.contains(
                "error_category=\"unknown\",error_code=\"generic_error\",stage=\"unknown\"",
            )
        );
        assert_eq!(registry.requests[&("other", false)], 1);
    }

    #[test]
    fn poisoned_registry_remains_available_for_recording_and_scraping() {
        let registry = Mutex::new(Registry::default());
        std::thread::scope(|scope| {
            let result = scope
                .spawn(|| {
                    let _guard = registry.lock().unwrap();
                    panic!("Simulate a metrics writer failure");
                })
                .join();
            assert!(result.is_err());
        });
        assert!(registry.is_poisoned());
        lock_registry(&registry).record_request(true, "api");
        assert!(
            lock_registry(&registry).prometheus().contains(
                "wegent_chat_requests_total{outcome=\"accepted\",entrypoint=\"api\"} 1\n",
            )
        );
    }
}
