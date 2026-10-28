//! Cursor-based executor maintenance with archive-before-delete safeguards.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use brz_mysql::{FromMysqlCol, Json, MysqlRow};
use brz_redis::{Redis, RedisBytes};
use chrono::{Local, NaiveDateTime};
use serde_json::{Value, json};

use super::{BackgroundJobRegistry, JobContext, with_lock_watchdog};
use crate::{AppState, task_store_maintenance::MaintenanceScan};

const JOB: &str = "executor_cleanup";
const CURSOR: &str = "executor_cleanup_cursor";

pub(super) fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    registry.register(JOB, move |context, _| {
        let state = state.clone();
        async move {
            Ok(with_lock_watchdog(
                &state.background_jobs,
                &context,
                "wegent:lock:executor_cleanup_lock",
                Duration::from_secs(300),
                cleanup(&state, &context),
            )
            .await?
            .unwrap_or_else(|| json!({"skipped":"lock_busy"})))
        }
    })?;
    registry.max_failures(JOB, 1)?;
    registry.timeout(JOB, None)?;
    registry.startup(JOB, Duration::ZERO)?;
    registry.interval(
        JOB,
        Duration::from_secs(number("TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS", 600)?),
        false,
    )
}

struct Settings {
    chat_hours: i64,
    code_hours: i64,
    stale_hours: i64,
    primary_batch: usize,
    lookback_hours: i64,
    lookback_limit: usize,
}

impl Settings {
    fn load() -> Result<Self> {
        Ok(Self {
            chat_hours: i64::try_from(number("CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS", 2)?)?,
            code_hours: i64::try_from(number("CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS", 24)?)?,
            stale_hours: i64::try_from(number(
                "STALE_NON_TERMINAL_TASK_EXECUTOR_DELETE_AFTER_HOURS",
                24,
            )?)?,
            primary_batch: usize::try_from(number(
                "TASK_EXECUTOR_CLEANUP_PRIMARY_SCAN_BATCH_SIZE",
                2000,
            )?)?,
            lookback_hours: i64::try_from(number("TASK_EXECUTOR_CLEANUP_LOOKBACK_HOURS", 96)?)?,
            lookback_limit: usize::try_from(number(
                "TASK_EXECUTOR_CLEANUP_LOOKBACK_SCAN_LIMIT",
                500,
            )?)?,
        })
    }
}

fn number(name: &str, default: u64) -> Result<u64> {
    let value = crate::config::env_or_dotenv(name)
        .map(|value| value.parse::<u64>())
        .transpose()?
        .unwrap_or(default);
    if value == 0 {
        anyhow::bail!("{name} must be positive");
    }
    Ok(value)
}

#[derive(Clone)]
struct Subtask {
    id: i64,
    task_id: i64,
    status: String,
    namespace: String,
    executor: String,
    deleted: bool,
    updated: NaiveDateTime,
}

impl Subtask {
    fn read(row: MysqlRow) -> Result<Self> {
        Ok(Self {
            id: required(&row, "id")?,
            task_id: required(&row, "task_id")?,
            status: required(&row, "status")?,
            namespace: column(&row, "executor_namespace")?.unwrap_or_default(),
            executor: column(&row, "executor_name")?.unwrap_or_default(),
            deleted: column::<bool>(&row, "executor_deleted_at")?.unwrap_or(false),
            updated: required(&row, "updated_at")?,
        })
    }

    fn eligible(&self, cutoff: NaiveDateTime) -> bool {
        matches!(
            self.status.as_str(),
            "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED"
        ) && self.updated <= cutoff
            && !self.executor.is_empty()
            && !self.executor.starts_with("device-")
            && !self.deleted
    }
}

fn column<T: FromMysqlCol>(row: &MysqlRow, name: &str) -> Result<Option<T>> {
    let index = crate::task_store::subtask_column_index(name)
        .context("unknown maintenance subtask field")?;
    Ok(row.get_at::<Option<T>>(index)?)
}

fn required<T: FromMysqlCol>(row: &MysqlRow, name: &str) -> Result<T> {
    column(row, name)?.with_context(|| format!("missing maintenance subtask field: {name}"))
}

struct Task {
    id: i64,
    owner: i64,
    payload: Value,
    updated: NaiveDateTime,
}

impl Task {
    fn read(row: MysqlRow) -> Option<Self> {
        use crate::internal_callback::completion::task_column;
        let kind = task_column::<String>(&row, "kind")?;
        let active = task_column::<i8>(&row, "is_active")?;
        let payload = task_column::<Json<Value>>(&row, "json")?.0;
        if kind != "Task" || ![1, 2].contains(&active) || !valid_task_payload(&payload) {
            return None;
        }
        Some(Self {
            id: task_column(&row, "id")?,
            owner: task_column(&row, "user_id")?,
            updated: task_column(&row, "updated_at")?,
            payload,
        })
    }

    fn eligible(&self, subtask: &Subtask, settings: &Settings, now: NaiveDateTime) -> bool {
        let labels = &self.payload["metadata"]["labels"];
        if labels["preserveExecutor"] == "true" {
            return false;
        }
        let status = self.payload["status"]["status"]
            .as_str()
            .unwrap_or("PENDING");
        if !matches!(status, "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED")
            && self.updated > now - chrono::Duration::hours(settings.stale_hours)
        {
            return false;
        }
        if labels["taskType"] == "code"
            && subtask.updated > now - chrono::Duration::hours(settings.code_hours)
        {
            return false;
        }
        labels["type"] == "subscription"
            || self.updated <= now - chrono::Duration::hours(settings.chat_hours)
    }
}

fn valid_task_payload(value: &Value) -> bool {
    value.get("metadata").is_some_and(Value::is_object)
        && value.get("spec").is_some_and(Value::is_object)
        && value["metadata"].get("name").is_some_and(Value::is_string)
        && value["metadata"]
            .get("namespace")
            .is_some_and(Value::is_string)
}

async fn cleanup(state: &AppState, context: &JobContext) -> Result<Value> {
    let settings = Settings::load()?;
    let now = Local::now().naive_local();
    let redis = state
        .redis
        .as_ref()
        .context("executor cleanup requires persisted Redis cursor")?;
    let saved = redis
        .get::<_, RedisBytes>(CURSOR)
        .await?
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes.as_ref()).ok());
    let interval = i64::try_from(number("TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS", 600)?)?;
    if saved
        .as_ref()
        .and_then(|value| value["updated_at"].as_str())
        .and_then(|value| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").ok())
        .is_some_and(|at| now - at < chrono::Duration::seconds(interval))
    {
        return Ok(json!({"skipped":"recently_executed"}));
    }
    let mut last_id = match saved.and_then(|value| value["last_scanned_subtask_id"].as_i64()) {
        Some(id) => id.max(0),
        None => initial_cursor(state, now).await?,
    };
    let cutoff = now - chrono::Duration::hours(settings.chat_hours);
    let mut scanned = 0;
    let mut deleted = 0;
    for _ in 0..50 {
        check_cancel(context)?;
        if deleted >= 2000 {
            break;
        }
        let rows = state
            .task_store
            .scan_maintenance_subtasks(&MaintenanceScan::CleanupPrimary {
                last_id,
                cutoff,
                limit: settings.primary_batch,
            })
            .await?;
        if rows.is_empty() {
            break;
        }
        let rows = rows
            .into_iter()
            .map(Subtask::read)
            .collect::<Result<Vec<_>>>()?;
        scanned += rows.len();
        last_id = rows.last().context("nonempty cleanup batch")?.id;
        write_cursor(state, last_id, now).await?;
        deleted += cleanup_batch(state, context, rows, &settings, now).await?;
    }
    if deleted < 2000 {
        let rows = state
            .task_store
            .scan_maintenance_subtasks(&MaintenanceScan::CleanupLookback {
                after: now - chrono::Duration::hours(settings.lookback_hours),
                cutoff,
                limit: settings.lookback_limit,
            })
            .await?;
        scanned += rows.len();
        deleted += cleanup_batch(
            state,
            context,
            rows.into_iter().map(Subtask::read).collect::<Result<_>>()?,
            &settings,
            now,
        )
        .await?;
    }
    Ok(json!({"scanned":scanned,"deleted":deleted,"last_scanned_subtask_id":last_id}))
}

async fn initial_cursor(state: &AppState, now: NaiveDateTime) -> Result<i64> {
    let recent = state
        .task_store
        .scan_maintenance_subtasks(&MaintenanceScan::CursorRecent {
            created_after: now - chrono::Duration::days(7),
        })
        .await?;
    if let Some(row) = recent.first() {
        return Ok(required::<i64>(row, "id")?.saturating_sub(1).max(0));
    }
    let latest = state
        .task_store
        .scan_maintenance_subtasks(&MaintenanceScan::CursorLatest)
        .await?;
    Ok(latest
        .first()
        .map(|row| required::<i64>(row, "id"))
        .transpose()?
        .unwrap_or(0)
        .max(0))
}

async fn write_cursor(state: &AppState, last_id: i64, now: NaiveDateTime) -> Result<()> {
    state.redis.as_ref().context("executor cleanup Redis cursor unavailable")?.set(CURSOR, json!({
        "last_scanned_subtask_id":last_id, "updated_at":now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string(),
    }).to_string()).await?;
    Ok(())
}

#[derive(Default)]
struct Group {
    tasks: BTreeSet<i64>,
    subtasks: BTreeMap<i64, BTreeSet<i64>>,
    latest: Option<NaiveDateTime>,
    blocked: bool,
}

impl Group {
    fn add(&mut self, subtask: &Subtask) {
        self.subtasks
            .entry(subtask.task_id)
            .or_default()
            .insert(subtask.id);
        self.latest = Some(
            self.latest
                .map_or(subtask.updated, |value| value.max(subtask.updated)),
        );
    }
}

async fn cleanup_batch(
    state: &AppState,
    context: &JobContext,
    rows: Vec<Subtask>,
    settings: &Settings,
    now: NaiveDateTime,
) -> Result<usize> {
    let cutoff = now - chrono::Duration::hours(settings.chat_hours);
    let candidates = rows
        .into_iter()
        .filter(|row| row.eligible(cutoff))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(0);
    }
    let ids = candidates
        .iter()
        .map(|row| row.task_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let tasks = state
        .task_store
        .list_tasks_by_ids(&ids)
        .await?
        .into_iter()
        .filter_map(Task::read)
        .map(|task| (task.id, task))
        .collect::<BTreeMap<_, _>>();
    let valid = candidates
        .iter()
        .filter(|row| {
            tasks
                .get(&row.task_id)
                .is_some_and(|task| task.eligible(row, settings, now))
        })
        .map(|row| row.task_id)
        .collect::<BTreeSet<_>>();
    let mut groups: BTreeMap<(String, String), Group> = BTreeMap::new();
    for id in valid {
        let rows = state.task_store.list_subtasks_by_task(id).await?;
        for subtask in rows.into_iter().map(Subtask::read) {
            let subtask = subtask?;
            if subtask.executor.is_empty() || subtask.deleted {
                continue;
            }
            let group = groups
                .entry((subtask.namespace.clone(), subtask.executor.clone()))
                .or_default();
            group.tasks.insert(id);
            group.add(&subtask);
        }
    }
    if groups.is_empty() {
        return Ok(0);
    }
    for row in state
        .task_store
        .scan_maintenance_subtasks(&MaintenanceScan::RuntimeExecutors)
        .await?
    {
        let subtask = Subtask::read(row)?;
        if let Some(group) = groups.get_mut(&(subtask.namespace.clone(), subtask.executor.clone()))
        {
            if !group.tasks.contains(&subtask.task_id) {
                group.blocked = true;
            }
            group.add(&subtask);
        }
    }
    let mut deleted = 0;
    for ((namespace, executor), group) in groups {
        check_cancel(context)?;
        if group.blocked || executor.starts_with("device-") {
            continue;
        }
        match delete_group(state, context, &tasks, &group, &namespace, &executor, now).await {
            Ok(true) => deleted += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(%error, executor, namespace, "executor cleanup group failed")
            }
        }
    }
    Ok(deleted)
}

async fn delete_group(
    state: &AppState,
    context: &JobContext,
    tasks: &BTreeMap<i64, Task>,
    group: &Group,
    namespace: &str,
    executor: &str,
    now: NaiveDateTime,
) -> Result<bool> {
    let mut latest = group.latest;
    let mut archive_failed = false;
    for id in &group.tasks {
        let task = tasks
            .get(id)
            .context("cleanup task disappeared from snapshot")?;
        latest = Some(latest.map_or(task.updated, |value| value.max(task.updated)));
        check_cancel(context)?;
        if let Err(error) =
            crate::workspace_archive::save::archive(state, *id, task.owner, executor, namespace)
                .await
        {
            tracing::warn!(%error, task_id=*id, "workspace archive failed before executor cleanup");
            archive_failed = true;
            break;
        }
    }
    // All task activity must be included even when one archive failed early.
    for id in &group.tasks {
        if let Some(task) = tasks.get(id) {
            latest = Some(latest.map_or(task.updated, |value| value.max(task.updated)));
        }
    }
    if archive_failed && !latest.is_some_and(|at| at <= now - chrono::Duration::days(7)) {
        return Ok(false);
    }
    check_cancel(context)?;
    if let Err(error) = state
        .executor_manager
        .delete_executor_task(executor, namespace)
        .await
    {
        let detail = error.to_string().to_ascii_lowercase();
        if !(detail.contains("pod") && detail.contains("not found")) {
            return Err(error);
        }
    }
    for (task_id, ids) in &group.subtasks {
        let owner = tasks
            .get(task_id)
            .context("executor group contains an unapproved task")?
            .owner;
        state
            .task_store
            .mark_maintenance_executor_deleted(
                *task_id,
                owner,
                &ids.iter().copied().collect::<Vec<_>>(),
            )
            .await?;
    }
    Ok(true)
}

fn check_cancel(context: &JobContext) -> Result<()> {
    if context.cancellation.is_cancelled() {
        anyhow::bail!("executor cleanup cancelled");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings {
            chat_hours: 2,
            code_hours: 24,
            stale_hours: 24,
            primary_batch: 2000,
            lookback_hours: 96,
            lookback_limit: 500,
        }
    }
    fn subtask(now: NaiveDateTime) -> Subtask {
        Subtask {
            id: 1,
            task_id: 2,
            status: "COMPLETED".into(),
            namespace: "default".into(),
            executor: "executor-1".into(),
            deleted: false,
            updated: now - chrono::Duration::hours(3),
        }
    }
    fn task(now: NaiveDateTime, labels: Value, status: &str) -> Task {
        Task {
            id: 2,
            owner: 7,
            updated: now - chrono::Duration::hours(3),
            payload: json!({"metadata":{"labels":labels},"status":{"status":status}}),
        }
    }

    #[test]
    fn preserves_device_and_active_subtask_executors() {
        let now = Local::now().naive_local();
        let mut subtask = subtask(now);
        assert!(subtask.eligible(now - chrono::Duration::hours(2)));
        subtask.executor = "device-local".into();
        assert!(!subtask.eligible(now - chrono::Duration::hours(2)));
        subtask.executor = "executor-1".into();
        subtask.status = "RUNNING".into();
        assert!(!subtask.eligible(now - chrono::Duration::hours(2)));
    }

    #[test]
    fn preserve_label_and_code_inactivity_threshold_block_cleanup() {
        let now = Local::now().naive_local();
        let subtask = subtask(now);
        assert!(
            !task(now, json!({"preserveExecutor":"true"}), "COMPLETED").eligible(
                &subtask,
                &settings(),
                now
            )
        );
        assert!(
            !task(now, json!({"taskType":"code"}), "COMPLETED").eligible(
                &subtask,
                &settings(),
                now
            )
        );
        assert!(task(now, json!({}), "COMPLETED").eligible(&subtask, &settings(), now));
    }

    #[test]
    fn stale_running_parent_and_subscription_activity_follow_distinct_rules() {
        let now = Local::now().naive_local();
        let subtask = subtask(now);
        let mut running = task(now, json!({}), "RUNNING");
        assert!(!running.eligible(&subtask, &settings(), now));
        running.updated = now - chrono::Duration::hours(25);
        assert!(running.eligible(&subtask, &settings(), now));
        let mut subscription = task(now, json!({"type":"subscription"}), "PENDING");
        subscription.updated = now;
        assert!(subscription.eligible(&subtask, &settings(), now));
    }
}
