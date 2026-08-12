// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    str::FromStr,
    sync::{Arc, Mutex, OnceLock, Weak},
};

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use cron::Schedule as CronSchedule;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::store::runtime_work_dir;

const AUTOMATION_STORE_VERSION: u64 = 1;
const DEFAULT_TIMEZONE: &str = "UTC";
const MAX_RUNS_PER_AUTOMATION: usize = 100;
type SharedAutomationState = Arc<Mutex<AutomationState>>;
type AutomationStateRegistry = Mutex<HashMap<PathBuf, Weak<Mutex<AutomationState>>>>;

static AUTOMATION_STATE_REGISTRY: OnceLock<AutomationStateRegistry> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct AutomationStore {
    path: PathBuf,
    state: Arc<Mutex<AutomationState>>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct AutomationState {
    version: u64,
    automations: HashMap<String, Automation>,
    runs: Vec<AutomationRun>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Automation {
    pub id: String,
    pub version: u64,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub prompt: String,
    pub schedule: AutomationSchedule,
    #[serde(default = "default_timezone")]
    pub timezone: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub conversation_mode: ConversationMode,
    #[serde(default)]
    pub notification_policy: NotificationPolicy,
    #[serde(default)]
    pub task_payload: Value,
    #[serde(default)]
    pub continuation_payload: Option<Value>,
    #[serde(default)]
    pub next_run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum AutomationSchedule {
    Cron { expression: String },
    Interval { value: i64, unit: IntervalUnit },
    OneTime { execute_at: DateTime<Utc> },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum IntervalUnit {
    Minutes,
    Hours,
    Days,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationMode {
    #[default]
    Independent,
    ContinueThread,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NotificationPolicy {
    #[default]
    AllRuns,
    AttentionOnly,
    Never,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub scheduled_for: DateTime<Utc>,
    pub trigger: String,
    pub status: AutomationRunStatus,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub workflow_run_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AutomationRunStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    NeedsAttention,
    Cancelled,
}

impl AutomationStore {
    pub fn from_env() -> Self {
        Self::new(runtime_work_dir().join("automations.json"))
    }

    fn new(path: PathBuf) -> Self {
        let state = shared_state(&path);
        Self { path, state }
    }

    pub fn list(&self) -> Vec<Automation> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        let mut items = state.automations.values().cloned().collect::<Vec<_>>();
        items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
        items
    }

    pub fn get(&self, automation_id: &str) -> Option<Automation> {
        self.state
            .lock()
            .ok()?
            .automations
            .get(automation_id)
            .cloned()
    }

    pub fn create(&self, mut automation: Automation) -> Result<Automation, String> {
        validate_automation(&automation)?;
        let now = Utc::now();
        if automation.id.trim().is_empty() {
            automation.id = Uuid::new_v4().to_string();
        }
        automation.version = 1;
        automation.created_at = now;
        automation.updated_at = now;
        automation.next_run_at = automation
            .enabled
            .then(|| initial_next_run(&automation.schedule, &automation.timezone, now))
            .flatten();
        let mut state = self.lock_state()?;
        if state.automations.contains_key(&automation.id) {
            return Err("automation already exists".to_owned());
        }
        state
            .automations
            .insert(automation.id.clone(), automation.clone());
        self.write_state(&state)?;
        Ok(automation)
    }

    pub fn update(&self, automation: Automation) -> Result<Automation, String> {
        validate_automation(&automation)?;
        let mut state = self.lock_state()?;
        let existing = state
            .automations
            .get(&automation.id)
            .cloned()
            .ok_or_else(|| "automation not found".to_owned())?;
        if existing.version != automation.version {
            return Err("automation version conflict".to_owned());
        }
        let now = Utc::now();
        let mut next = automation;
        next.version += 1;
        next.created_at = existing.created_at;
        next.updated_at = now;
        next.next_run_at = next
            .enabled
            .then(|| initial_next_run(&next.schedule, &next.timezone, now))
            .flatten();
        state.automations.insert(next.id.clone(), next.clone());
        self.write_state(&state)?;
        Ok(next)
    }

    pub fn delete(&self, automation_id: &str) -> Result<bool, String> {
        let mut state = self.lock_state()?;
        let removed = state.automations.remove(automation_id).is_some();
        if removed {
            self.write_state(&state)?;
        }
        Ok(removed)
    }

    pub fn toggle(&self, automation_id: &str, enabled: bool) -> Result<Automation, String> {
        let automation = self
            .get(automation_id)
            .ok_or_else(|| "automation not found".to_owned())?;
        self.update(Automation {
            enabled,
            ..automation
        })
    }

    pub fn due(&self, now: DateTime<Utc>) -> Result<Vec<(Automation, AutomationRun)>, String> {
        let mut state = self.lock_state()?;
        let mut due = Vec::new();
        let automation_ids = state.automations.keys().cloned().collect::<Vec<_>>();
        for automation_id in automation_ids {
            let Some(existing) = state.automations.get(&automation_id).cloned() else {
                continue;
            };
            let automation = existing;
            if !automation.enabled {
                continue;
            }
            let Some(scheduled_for) = automation.next_run_at else {
                continue;
            };
            if scheduled_for > now {
                continue;
            }
            let active = state.runs.iter().any(|run| {
                run.automation_id == automation_id
                    && matches!(
                        run.status,
                        AutomationRunStatus::Pending | AutomationRunStatus::Running
                    )
            });
            let missed = scheduled_for + Duration::minutes(1) < now;
            let status = if active
                || (missed && !matches!(automation.schedule, AutomationSchedule::OneTime { .. }))
            {
                AutomationRunStatus::Skipped
            } else {
                AutomationRunStatus::Pending
            };
            let run = AutomationRun {
                id: Uuid::new_v4().to_string(),
                automation_id: automation_id.clone(),
                scheduled_for,
                trigger: "scheduled".to_owned(),
                status,
                task_id: None,
                workflow_run_id: None,
                error: if active {
                    Some("previous automation run is still active".to_owned())
                } else if status == AutomationRunStatus::Skipped {
                    Some("scheduled time was missed while Wework was not running".to_owned())
                } else {
                    None
                },
                created_at: now,
                updated_at: now,
            };
            let mut updated = automation.clone();
            updated.last_run_at = Some(now);
            updated.updated_at = now;
            if matches!(updated.schedule, AutomationSchedule::OneTime { .. }) {
                updated.enabled = false;
                updated.next_run_at = None;
            } else {
                updated.next_run_at = next_run_after(&updated.schedule, &updated.timezone, now);
            }
            state.automations.insert(automation_id, updated.clone());
            state.runs.push(run.clone());
            if status == AutomationRunStatus::Pending {
                due.push((updated, run));
            }
        }
        prune_runs(&mut state);
        self.write_state(&state)?;
        Ok(due)
    }

    pub fn start_manual_run(
        &self,
        automation_id: &str,
    ) -> Result<(Automation, AutomationRun), String> {
        let automation = self
            .get(automation_id)
            .ok_or_else(|| "automation not found".to_owned())?;
        let now = Utc::now();
        let mut state = self.lock_state()?;
        let active = state.runs.iter().any(|run| {
            run.automation_id == automation_id
                && matches!(
                    run.status,
                    AutomationRunStatus::Pending | AutomationRunStatus::Running
                )
        });
        let run = AutomationRun {
            id: Uuid::new_v4().to_string(),
            automation_id: automation.id.clone(),
            scheduled_for: now,
            trigger: "manual".to_owned(),
            status: if active {
                AutomationRunStatus::Skipped
            } else {
                AutomationRunStatus::Pending
            },
            task_id: None,
            workflow_run_id: None,
            error: active.then(|| "previous automation run is still active".to_owned()),
            created_at: now,
            updated_at: now,
        };
        state.runs.push(run.clone());
        prune_runs(&mut state);
        self.write_state(&state)?;
        Ok((automation, run))
    }

    pub fn mark_running(&self, run_id: &str, task_id: String) -> Result<(), String> {
        self.update_run(run_id, |run| {
            run.status = AutomationRunStatus::Running;
            run.task_id = Some(task_id);
            run.error = None;
        })
    }

    pub fn mark_failed(&self, run_id: &str, error: String) -> Result<(), String> {
        self.update_run(run_id, |run| {
            run.status = AutomationRunStatus::Failed;
            run.error = Some(error);
        })
    }

    pub fn mark_project_workflow_succeeded(
        &self,
        run_id: &str,
        task_id: String,
        workflow_run_id: String,
    ) -> Result<(), String> {
        self.update_run(run_id, |run| {
            run.status = AutomationRunStatus::Succeeded;
            run.task_id = Some(task_id);
            run.workflow_run_id = Some(workflow_run_id);
            run.error = None;
        })
    }

    pub fn complete_task(
        &self,
        task_id: &str,
        status: AutomationRunStatus,
        error: Option<String>,
    ) -> Option<String> {
        let Ok(mut state) = self.state.lock() else {
            return None;
        };
        let now = Utc::now();
        let mut automation_id = None;
        for run in &mut state.runs {
            if run.task_id.as_deref() == Some(task_id)
                && matches!(
                    run.status,
                    AutomationRunStatus::Pending | AutomationRunStatus::Running
                )
            {
                run.status = status;
                run.error = error.clone();
                run.updated_at = now;
                automation_id = Some(run.automation_id.clone());
            }
        }
        if automation_id.is_some() {
            let _ = self.write_state(&state);
        }
        automation_id
    }

    pub fn list_runs(&self, automation_id: Option<&str>) -> Vec<AutomationRun> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        let mut runs = state
            .runs
            .iter()
            .filter(|run| automation_id.map_or(true, |id| run.automation_id == id))
            .cloned()
            .collect::<Vec<_>>();
        runs.sort_by_key(|run| std::cmp::Reverse(run.created_at));
        runs
    }

    fn update_run(
        &self,
        run_id: &str,
        updater: impl FnOnce(&mut AutomationRun),
    ) -> Result<(), String> {
        let mut state = self.lock_state()?;
        let run = state
            .runs
            .iter_mut()
            .find(|run| run.id == run_id)
            .ok_or_else(|| "automation run not found".to_owned())?;
        updater(run);
        run.updated_at = Utc::now();
        self.write_state(&state)
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, AutomationState>, String> {
        self.state
            .lock()
            .map_err(|_| "automation store lock is poisoned".to_owned())
    }

    fn write_state(&self, state: &AutomationState) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let payload = serde_json::to_vec_pretty(&AutomationState {
            version: AUTOMATION_STORE_VERSION,
            ..state.clone()
        })
        .map_err(|error| error.to_string())?;
        let temp_path = self.path.with_extension("json.tmp");
        fs::write(&temp_path, payload).map_err(|error| error.to_string())?;
        fs::rename(temp_path, &self.path).map_err(|error| error.to_string())
    }
}

fn shared_state(path: &PathBuf) -> SharedAutomationState {
    let registry = AUTOMATION_STATE_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut states) = registry.lock() else {
        return Arc::new(Mutex::new(read_state(path)));
    };
    if let Some(state) = states.get(path).and_then(Weak::upgrade) {
        return state;
    }
    let state = Arc::new(Mutex::new(read_state(path)));
    states.insert(path.clone(), Arc::downgrade(&state));
    state
}

fn initial_next_run(
    schedule: &AutomationSchedule,
    timezone: &str,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    match schedule {
        AutomationSchedule::OneTime { execute_at } => Some((*execute_at).max(now)),
        _ => next_run_after(schedule, timezone, now),
    }
}

pub(crate) fn next_run_after(
    schedule: &AutomationSchedule,
    timezone: &str,
    after: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    match schedule {
        AutomationSchedule::OneTime { execute_at } => (*execute_at > after).then_some(*execute_at),
        AutomationSchedule::Interval { value, unit } => {
            let duration = match unit {
                IntervalUnit::Minutes => Duration::minutes(*value),
                IntervalUnit::Hours => Duration::hours(*value),
                IntervalUnit::Days => Duration::days(*value),
            };
            (duration > Duration::zero()).then_some(after + duration)
        }
        AutomationSchedule::Cron { expression } => {
            let timezone = timezone.parse::<Tz>().ok()?;
            let expression = normalize_cron_expression(expression)?;
            let schedule = CronSchedule::from_str(&expression).ok()?;
            let local_after = after.with_timezone(&timezone);
            schedule
                .after(&local_after)
                .next()
                .map(|value| value.with_timezone(&Utc))
        }
    }
}

fn normalize_cron_expression(expression: &str) -> Option<String> {
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    match fields.len() {
        5 => Some(format!("0 {expression}")),
        6 | 7 => Some(expression.to_owned()),
        _ => None,
    }
}

fn validate_automation(automation: &Automation) -> Result<(), String> {
    if automation.name.trim().is_empty() {
        return Err("automation name is required".to_owned());
    }
    if automation.prompt.trim().is_empty() {
        return Err("automation prompt is required".to_owned());
    }
    if automation.task_payload.as_object().is_none() {
        return Err("taskPayload is required".to_owned());
    }
    automation
        .timezone
        .parse::<Tz>()
        .map_err(|_| "invalid IANA timezone".to_owned())?;
    match &automation.schedule {
        AutomationSchedule::Cron { expression } => {
            let expression = normalize_cron_expression(expression)
                .ok_or_else(|| "cron expression must contain 5, 6, or 7 fields".to_owned())?;
            CronSchedule::from_str(&expression)
                .map_err(|error| format!("invalid cron expression: {error}"))?;
        }
        AutomationSchedule::Interval { value, .. } if *value <= 0 => {
            return Err("interval value must be positive".to_owned());
        }
        AutomationSchedule::OneTime { .. } | AutomationSchedule::Interval { .. } => {}
    }
    Ok(())
}

fn prune_runs(state: &mut AutomationState) {
    let mut counts = HashMap::<String, usize>::new();
    state
        .runs
        .sort_by_key(|run| std::cmp::Reverse(run.created_at));
    state.runs.retain(|run| {
        let count = counts.entry(run.automation_id.clone()).or_default();
        *count += 1;
        *count <= MAX_RUNS_PER_AUTOMATION
    });
}

fn read_state(path: &PathBuf) -> AutomationState {
    fs::read(path)
        .ok()
        .and_then(|payload| serde_json::from_slice(&payload).ok())
        .unwrap_or_else(|| AutomationState {
            version: AUTOMATION_STORE_VERSION,
            ..AutomationState::default()
        })
}

fn default_timezone() -> String {
    DEFAULT_TIMEZONE.to_owned()
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::{TimeZone, Utc};
    use tempfile::tempdir;

    use super::{
        initial_next_run, next_run_after, Automation, AutomationRunStatus, AutomationSchedule,
        AutomationStore, ConversationMode, IntervalUnit, NotificationPolicy,
    };
    use serde_json::json;

    #[test]
    fn cron_schedule_respects_timezone() {
        let after = Utc.with_ymd_and_hms(2026, 7, 28, 0, 30, 0).unwrap();
        let next = next_run_after(
            &AutomationSchedule::Cron {
                expression: "0 9 * * *".to_owned(),
            },
            "Asia/Shanghai",
            after,
        )
        .unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 7, 28, 1, 0, 0).unwrap());
    }

    #[test]
    fn interval_schedule_uses_fixed_duration() {
        let after = Utc.with_ymd_and_hms(2026, 7, 28, 0, 0, 0).unwrap();
        let next = next_run_after(
            &AutomationSchedule::Interval {
                value: 2,
                unit: IntervalUnit::Hours,
            },
            "UTC",
            after,
        )
        .unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 7, 28, 2, 0, 0).unwrap());
    }

    #[test]
    fn missed_one_time_schedule_runs_once_after_restart() {
        let now = Utc.with_ymd_and_hms(2026, 7, 28, 2, 0, 0).unwrap();
        let execute_at = Utc.with_ymd_and_hms(2026, 7, 28, 1, 0, 0).unwrap();

        assert_eq!(
            initial_next_run(&AutomationSchedule::OneTime { execute_at }, "UTC", now),
            Some(now)
        );
    }

    #[test]
    fn manual_run_is_skipped_while_previous_run_is_active() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("automations.json");
        let store = AutomationStore::new(path.clone());
        let automation = store
            .create(Automation {
                id: String::new(),
                version: 0,
                name: "Daily".to_owned(),
                description: String::new(),
                prompt: "Summarize".to_owned(),
                schedule: AutomationSchedule::Interval {
                    value: 1,
                    unit: IntervalUnit::Hours,
                },
                timezone: "UTC".to_owned(),
                enabled: true,
                conversation_mode: ConversationMode::Independent,
                notification_policy: NotificationPolicy::AllRuns,
                task_payload: json!({"workspacePath": "/tmp"}),
                continuation_payload: None,
                next_run_at: None,
                last_run_at: None,
                created_at: Default::default(),
                updated_at: Default::default(),
            })
            .unwrap();

        let (_, first) = store.start_manual_run(&automation.id).unwrap();
        let (_, second) = store.start_manual_run(&automation.id).unwrap();

        assert_eq!(first.status, AutomationRunStatus::Pending);
        assert_eq!(second.status, AutomationRunStatus::Skipped);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn stores_for_the_same_path_share_live_state() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("shared-automations.json");
        let first = AutomationStore::new(path.clone());
        let second = AutomationStore::new(path.clone());

        let automation = first
            .create(Automation {
                id: String::new(),
                version: 0,
                name: "Shared".to_owned(),
                description: String::new(),
                prompt: "Summarize".to_owned(),
                schedule: AutomationSchedule::Interval {
                    value: 1,
                    unit: IntervalUnit::Hours,
                },
                timezone: "UTC".to_owned(),
                enabled: true,
                conversation_mode: ConversationMode::Independent,
                notification_policy: NotificationPolicy::AllRuns,
                task_payload: json!({"workspacePath": "/tmp"}),
                continuation_payload: None,
                next_run_at: None,
                last_run_at: None,
                created_at: Default::default(),
                updated_at: Default::default(),
            })
            .unwrap();

        assert_eq!(second.list().len(), 1);
        assert_eq!(second.get(&automation.id).unwrap().name, "Shared");
        fs::remove_file(path).unwrap();
    }
}
