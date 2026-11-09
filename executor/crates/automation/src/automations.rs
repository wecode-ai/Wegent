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

mod stand_in_memory;
mod stand_in_review;
pub use stand_in_memory::{memory_review, MEMORY_REVIEW_INSTRUCTIONS, MEMORY_REVIEW_TEMPLATE};
pub use stand_in_review::{weekly_review, WEEKLY_REVIEW_INSTRUCTIONS, WEEKLY_REVIEW_TEMPLATE};

const AUTOMATION_STORE_VERSION: u64 = 2;
const DEFAULT_TIMEZONE: &str = "UTC";
const MAX_RUNS_PER_AUTOMATION: usize = 100;
type SharedAutomationState = Arc<Mutex<AutomationState>>;
type AutomationStateRegistry = Mutex<HashMap<PathBuf, Weak<Mutex<AutomationState>>>>;

static AUTOMATION_STATE_REGISTRY: OnceLock<AutomationStateRegistry> = OnceLock::new();

#[derive(Clone)]
pub struct AutomationStore {
    path: PathBuf,
    state: Arc<Mutex<AutomationState>>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct AutomationState {
    version: u64,
    automations: HashMap<String, Automation>,
    runs: Vec<AutomationRun>,
    stand_in_onboarding: HashMap<i64, Value>,
    stand_in_memory_initialized: std::collections::HashSet<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
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
    pub task_request: Value,
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
pub enum AutomationSchedule {
    Cron { expression: String },
    Interval { value: i64, unit: IntervalUnit },
    OneTime { execute_at: DateTime<Utc> },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntervalUnit {
    Minutes,
    Hours,
    Days,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationMode {
    #[default]
    Independent,
    ContinueThread,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationPolicy {
    #[default]
    AllRuns,
    AttentionOnly,
    Never,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub scheduled_for: DateTime<Utc>,
    pub trigger: String,
    pub status: AutomationRunStatus,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordination: Option<ArrangementBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangementBinding {
    pub user_id: i64,
    pub role_id: String,
    pub automation_version: u64,
    pub task_id: String,
}

impl ArrangementBinding {
    fn from_automation(automation: &Automation, run_id: &str) -> Option<Self> {
        let owner = &automation.task_request["standInOwner"];
        let user_id = owner["userId"].as_i64().filter(|user| *user >= 0)?;
        let task_id = match automation.conversation_mode {
            ConversationMode::Independent => format!("stand-in-arrangement-{user_id}-{run_id}"),
            ConversationMode::ContinueThread => {
                let payload = automation
                    .continuation_payload
                    .as_ref()
                    .unwrap_or(&automation.task_payload);
                payload
                    .get("taskId")
                    .or_else(|| payload.get("task_id"))
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())?
                    .to_owned()
            }
        };
        Some(Self {
            user_id,
            role_id: owner["roleId"]
                .as_str()
                .filter(|role| !role.is_empty())?
                .into(),
            automation_version: automation.version,
            task_id,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    NeedsAttention,
    Cancelled,
}

impl AutomationStore {
    pub fn new(path: PathBuf) -> Self {
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
        if stand_in_review::duplicate_review(&state, &automation) {
            return Err("This stand-in review template already exists for the account".into());
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
        if stand_in_review::duplicate_review(&state, &automation) {
            return Err("This stand-in review template already exists for the account".into());
        }
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
            let active_count = state
                .runs
                .iter()
                .filter(|run| {
                    run.automation_id == automation_id
                        && matches!(
                            run.status,
                            AutomationRunStatus::Pending | AutomationRunStatus::Running
                        )
                })
                .count();
            let calendar = automation.task_request["standInCalendar"].is_object();
            // Backpressure preserves queued occurrences and their next due time.
            if calendar && active_count >= MAX_RUNS_PER_AUTOMATION {
                continue;
            }
            let active = active_count > 0;
            let missed = scheduled_for + Duration::minutes(1) < now;
            let status = if (active && !automation.task_request["standInCalendar"].is_object())
                || (missed
                    && !automation.task_request["standInOwner"].is_object()
                    && !matches!(automation.schedule, AutomationSchedule::OneTime { .. }))
            {
                AutomationRunStatus::Skipped
            } else {
                AutomationRunStatus::Pending
            };
            let run_id = Uuid::new_v4().to_string();
            let coordination = ArrangementBinding::from_automation(&automation, &run_id);
            let run = AutomationRun {
                id: run_id,
                automation_id: automation_id.clone(),
                scheduled_for,
                trigger: "scheduled".to_owned(),
                status,
                task_id: None,
                error: if status == AutomationRunStatus::Skipped && active {
                    Some("previous automation run is still active".to_owned())
                } else if status == AutomationRunStatus::Skipped {
                    Some("scheduled time was missed while Wework was not running".to_owned())
                } else {
                    None
                },
                created_at: now,
                updated_at: now,
                coordination,
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
        let run_id = Uuid::new_v4().to_string();
        let coordination = ArrangementBinding::from_automation(&automation, &run_id);
        let run = AutomationRun {
            id: run_id,
            automation_id: automation.id.clone(),
            scheduled_for: now,
            trigger: "manual".to_owned(),
            status: if active {
                AutomationRunStatus::Skipped
            } else {
                AutomationRunStatus::Pending
            },
            task_id: None,
            error: active.then(|| "previous automation run is still active".to_owned()),
            created_at: now,
            updated_at: now,
            coordination,
        };
        state.runs.push(run.clone());
        prune_runs(&mut state);
        self.write_state(&state)?;
        Ok((automation, run))
    }

    pub fn mark_running(&self, run_id: &str, task_id: String) -> Result<(), String> {
        self.update_run(run_id, |run| {
            run.task_id = Some(task_id);
            if matches!(
                run.status,
                AutomationRunStatus::Pending | AutomationRunStatus::Running
            ) {
                run.status = AutomationRunStatus::Running;
                run.error = None;
            }
        })
    }

    pub fn mark_failed(&self, run_id: &str, error: String) -> Result<(), String> {
        self.update_run(run_id, |run| {
            run.status = AutomationRunStatus::Failed;
            run.error = Some(error);
        })
    }

    pub fn mark_needs_attention(&self, run_id: &str, error: String) -> Result<(), String> {
        self.update_run(run_id, |run| {
            run.status = AutomationRunStatus::NeedsAttention;
            run.error = Some(error);
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
            if run.coordination.is_none()
                && run.task_id.as_deref() == Some(task_id)
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

    pub fn settle_coordinated_run(
        &self,
        run_id: &str,
        status: AutomationRunStatus,
        task_id: Option<String>,
        error: Option<String>,
    ) -> Result<(), String> {
        self.update_run(run_id, |run| {
            if matches!(
                run.status,
                AutomationRunStatus::Pending | AutomationRunStatus::Running
            ) {
                run.status = status;
                if task_id.is_some() {
                    run.task_id = task_id;
                }
                run.error = error;
            }
        })
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
        write_state_file(&self.path, state)
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

pub fn next_run_after(
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
        5 => Some(format!(
            "0 {} {} {} {} {}",
            fields[0],
            fields[1],
            fields[2],
            fields[3],
            normalize_standard_days_of_week(fields[4])?
        )),
        6 | 7 => Some(expression.to_owned()),
        _ => None,
    }
}

fn normalize_standard_days_of_week(field: &str) -> Option<String> {
    field
        .split(',')
        .map(|part| {
            let (range, step) = part
                .split_once('/')
                .map_or((part, None), |(range, step)| (range, Some(step)));
            let range = if range == "*" {
                range.to_owned()
            } else if let Some((start, end)) = range.split_once('-') {
                format!(
                    "{}-{}",
                    standard_day_of_week_name(start)?,
                    standard_day_of_week_name(end)?
                )
            } else {
                standard_day_of_week_name(range)?.to_owned()
            };
            Some(match step {
                Some(step) => format!("{range}/{step}"),
                None => range,
            })
        })
        .collect::<Option<Vec<_>>>()
        .map(|parts| parts.join(","))
}

fn standard_day_of_week_name(value: &str) -> Option<&str> {
    match value.parse::<u8>() {
        Ok(0 | 7) => Some("SUN"),
        Ok(1) => Some("MON"),
        Ok(2) => Some("TUE"),
        Ok(3) => Some("WED"),
        Ok(4) => Some("THU"),
        Ok(5) => Some("FRI"),
        Ok(6) => Some("SAT"),
        Ok(_) => None,
        Err(_) => Some(value),
    }
}

fn validate_automation(automation: &Automation) -> Result<(), String> {
    if let Some(calendar) = automation.task_request.get("standInCalendar") {
        let owner = &automation.task_request["standInOwner"];
        if (calendar["template"] == WEEKLY_REVIEW_TEMPLATE
            || calendar["template"] == MEMORY_REVIEW_TEMPLATE)
            && owner["roleId"] != "@primary"
        {
            return Err("Stand-in reviews belong to the primary stand-in".into());
        }
        if !calendar.is_object()
            || !owner["userId"].as_i64().is_some_and(|id| id >= 0)
            || !owner["roleId"].as_str().is_some_and(|id| !id.is_empty())
            || !matches!(automation.conversation_mode, ConversationMode::Independent)
            || automation.continuation_payload.is_some()
            || ["initialGoal", "modelId", "modelOptions", "workspacePath"]
                .iter()
                .any(|key| automation.task_request.get(*key).is_some())
        {
            return Err("calendar entries require an owner and processing policy, without execution overrides".into());
        }
    }
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
        if matches!(
            run.status,
            AutomationRunStatus::Pending | AutomationRunStatus::Running
        ) {
            return true;
        }
        let count = counts.entry(run.automation_id.clone()).or_default();
        *count += 1;
        *count <= MAX_RUNS_PER_AUTOMATION
    });
}

fn read_state(path: &PathBuf) -> AutomationState {
    let mut state = fs::read(path)
        .ok()
        .and_then(|payload| serde_json::from_slice(&payload).ok())
        .unwrap_or_else(|| AutomationState {
            version: AUTOMATION_STORE_VERSION,
            ..AutomationState::default()
        });
    if migrate_automation_state(&mut state, Utc::now()) {
        let _ = write_state_file(path, &state);
    }
    state
}

fn migrate_automation_state(state: &mut AutomationState, now: DateTime<Utc>) -> bool {
    if state.version >= AUTOMATION_STORE_VERSION {
        return false;
    }
    for automation in state.automations.values_mut() {
        if automation.enabled && matches!(&automation.schedule, AutomationSchedule::Cron { .. }) {
            automation.next_run_at =
                initial_next_run(&automation.schedule, &automation.timezone, now);
        }
    }
    state.version = AUTOMATION_STORE_VERSION;
    true
}

fn write_state_file(path: &PathBuf, state: &AutomationState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(&AutomationState {
        version: AUTOMATION_STORE_VERSION,
        ..state.clone()
    })
    .map_err(|error| error.to_string())?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, payload).map_err(|error| error.to_string())?;
    fs::rename(temp_path, path).map_err(|error| error.to_string())
}

fn default_timezone() -> String {
    DEFAULT_TIMEZONE.to_owned()
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
#[path = "automations_tests.rs"]
mod tests;
