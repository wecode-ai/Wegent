use std::{collections::HashMap, fs};

use chrono::{TimeZone, Utc};
use tempfile::tempdir;

use super::{
    initial_next_run, migrate_automation_state, next_run_after, read_state, Automation,
    AutomationRunStatus, AutomationSchedule, AutomationState, AutomationStore, ConversationMode,
    IntervalUnit, NotificationPolicy, MAX_RUNS_PER_AUTOMATION,
};
use serde_json::json;

#[test]
fn recurring_calendar_intake_keeps_new_occurrences_while_earlier_events_are_pending() {
    let root = tempdir().unwrap();
    let store = AutomationStore::new(root.path().join("automations.json"));
    let calendar: Automation = serde_json::from_value(json!({"id":"calendar","version":0,"name":"Review","prompt":"Review","schedule":{"type":"interval","value":1,"unit":"hours"},"taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"},"standInCalendar":{}},"taskPayload":{"runtime":"codex"}})).unwrap();
    store.create(calendar).unwrap();
    let first_at = store.get("calendar").unwrap().next_run_at.unwrap();
    let first = store.due(first_at).unwrap().pop().unwrap().1;
    assert_eq!(first.status, AutomationRunStatus::Pending);
    let second_at = store.get("calendar").unwrap().next_run_at.unwrap();
    let second = store.due(second_at).unwrap().pop().unwrap().1;
    assert_eq!(second.status, AutomationRunStatus::Pending);
    assert_ne!(first.id, second.id);
    assert_eq!(store.list_runs(Some("calendar")).len(), 2);
}

#[test]
fn calendar_backpressure_preserves_active_runs_and_the_next_due_occurrence() {
    let root = tempdir().unwrap();
    let store = AutomationStore::new(root.path().join("automations.json"));
    let calendar: Automation = serde_json::from_value(json!({"id":"calendar","version":0,"name":"Review","prompt":"Review","schedule":{"type":"interval","value":1,"unit":"hours"},"taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"},"standInCalendar":{}},"taskPayload":{"runtime":"codex"}})).unwrap();
    store.create(calendar).unwrap();
    for _ in 0..MAX_RUNS_PER_AUTOMATION {
        let at = store.get("calendar").unwrap().next_run_at.unwrap();
        let run = store.due(at).unwrap().pop().unwrap().1;
        assert_eq!(run.status, AutomationRunStatus::Pending);
        assert_eq!(run.error, None);
    }
    let existing = store.list_runs(Some("calendar"));
    store
        .mark_running(&existing[0].id, "accepted-task".into())
        .unwrap();
    let next = store.get("calendar").unwrap().next_run_at.unwrap();
    assert!(store.due(next).unwrap().is_empty());
    assert_eq!(store.get("calendar").unwrap().next_run_at, Some(next));
    assert_eq!(
        store.list_runs(Some("calendar")).len(),
        MAX_RUNS_PER_AUTOMATION
    );
    store
        .mark_failed(&existing[1].id, "Finished earlier attempt".into())
        .unwrap();
    let resumed = store.due(next).unwrap().pop().unwrap().1;
    assert_eq!(resumed.scheduled_for, next);
    assert_eq!(resumed.status, AutomationRunStatus::Pending);
    assert_eq!(resumed.error, None);
    let retained = store.list_runs(Some("calendar"));
    assert!(existing
        .iter()
        .all(|old| retained.iter().any(|run| run.id == old.id)));
    assert_eq!(
        retained
            .iter()
            .find(|run| run.id == existing[0].id)
            .unwrap()
            .status,
        AutomationRunStatus::Running
    );
}

#[test]
fn owned_recurring_arrangements_catch_up_once_and_keep_active_runs_when_pruning() {
    let root = tempdir().unwrap();
    let store = AutomationStore::new(root.path().join("automations.json"));
    let automation: Automation = serde_json::from_value(json!({"id":"recurring","version":0,"name":"Review","prompt":"Review","schedule":{"type":"interval","value":1,"unit":"hours"},"taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"}},"taskPayload":{"runtime":"codex"}})).unwrap();
    store.create(automation).unwrap();
    let now = Utc::now() + chrono::Duration::hours(2);
    let (_, run) = store.due(now).unwrap().pop().unwrap();
    assert_eq!(run.status, AutomationRunStatus::Pending);
    assert!(run.coordination.is_some());
    assert!(store.due(now).unwrap().is_empty());
    let mut state = super::read_state(&store.path);
    for index in 0..150 {
        let mut skipped = run.clone();
        skipped.id = format!("skipped-{index}");
        skipped.status = AutomationRunStatus::Skipped;
        skipped.created_at = now + chrono::Duration::seconds(index);
        state.runs.push(skipped);
    }
    super::prune_runs(&mut state);
    assert!(state
        .runs
        .iter()
        .any(|item| item.id == run.id && item.status == AutomationRunStatus::Pending));
    assert_eq!(state.runs.len(), super::MAX_RUNS_PER_AUTOMATION + 1);
}

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
fn standard_weekday_cron_includes_friday() {
    let after = Utc.with_ymd_and_hms(2026, 8, 14, 8, 0, 0).unwrap();
    let next = next_run_after(
        &AutomationSchedule::Cron {
            expression: "45 16 * * 1-5".to_owned(),
        },
        "Asia/Shanghai",
        after,
    )
    .unwrap();

    assert_eq!(next, Utc.with_ymd_and_hms(2026, 8, 14, 8, 45, 0).unwrap());
}

#[test]
fn standard_weekday_cron_skips_weekend_after_friday() {
    let after = Utc.with_ymd_and_hms(2026, 8, 14, 9, 0, 0).unwrap();
    let next = next_run_after(
        &AutomationSchedule::Cron {
            expression: "45 16 * * 1-5".to_owned(),
        },
        "Asia/Shanghai",
        after,
    )
    .unwrap();

    assert_eq!(next, Utc.with_ymd_and_hms(2026, 8, 17, 8, 45, 0).unwrap());
}

#[test]
fn migration_recalculates_existing_cron_next_run() {
    let now = Utc.with_ymd_and_hms(2026, 8, 14, 8, 0, 0).unwrap();
    let automation = Automation {
        id: "weekday".to_owned(),
        version: 1,
        name: "Weekday".to_owned(),
        description: String::new(),
        prompt: "Run".to_owned(),
        schedule: AutomationSchedule::Cron {
            expression: "45 16 * * 1-5".to_owned(),
        },
        timezone: "Asia/Shanghai".to_owned(),
        enabled: true,
        conversation_mode: ConversationMode::Independent,
        notification_policy: NotificationPolicy::AllRuns,
        task_request: json!({}),
        task_payload: json!({}),
        continuation_payload: None,
        next_run_at: Some(Utc.with_ymd_and_hms(2026, 8, 16, 8, 45, 0).unwrap()),
        last_run_at: None,
        created_at: now,
        updated_at: now,
    };
    let mut state = AutomationState {
        version: 1,
        automations: HashMap::from([(automation.id.clone(), automation)]),
        runs: Vec::new(),
        stand_in_onboarding: HashMap::new(),
    };

    assert!(migrate_automation_state(&mut state, now));

    assert_eq!(state.version, 2);
    assert_eq!(
        state.automations["weekday"].next_run_at,
        Some(Utc.with_ymd_and_hms(2026, 8, 14, 8, 45, 0).unwrap())
    );
}

#[test]
fn loading_old_state_persists_migration() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("automations.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&AutomationState {
            version: 1,
            automations: HashMap::new(),
            runs: Vec::new(),
            stand_in_onboarding: HashMap::new(),
        })
        .unwrap(),
    )
    .unwrap();

    let state = read_state(&path);
    let stored: AutomationState = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();

    assert_eq!(state.version, 2);
    assert_eq!(stored.version, 2);
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
            task_request: json!({
                "schemaVersion": 2,
                "deviceId": "local-device",
                "runtimeProjectKey": "local:wework",
                "runtime": "codex",
                "message": "Summarize"
            }),
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
            task_request: json!({
                "schemaVersion": 2,
                "deviceId": "local-device",
                "runtimeProjectKey": "local:wework",
                "runtime": "codex",
                "message": "Summarize"
            }),
            task_payload: json!({"workspacePath": "/tmp"}),
            continuation_payload: None,
            next_run_at: None,
            last_run_at: None,
            created_at: Default::default(),
            updated_at: Default::default(),
        })
        .unwrap();

    assert_eq!(second.list().len(), 1);
    let stored = second.get(&automation.id).unwrap();
    assert_eq!(stored.name, "Shared");
    assert_eq!(stored.task_request["schemaVersion"], 2);
    assert_eq!(stored.task_request["runtimeProjectKey"], "local:wework");
    fs::remove_file(path).unwrap();
}
