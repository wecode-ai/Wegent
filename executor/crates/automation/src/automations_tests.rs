use std::{collections::HashMap, fs};

use chrono::{TimeZone, Utc};
use tempfile::tempdir;

use super::{
    initial_next_run, migrate_automation_state, read_state, Automation, AutomationRun,
    AutomationRunStatus, AutomationSchedule, AutomationState, AutomationStore, ConversationMode,
    IntervalUnit, NotificationPolicy, MAX_RUNS_PER_AUTOMATION,
};
use serde_json::json;

#[test]
fn legacy_goal_recovery_requires_a_task_created_during_the_run() {
    let now = Utc.with_ymd_and_hms(2026, 8, 14, 8, 0, 0).unwrap();
    let mut run: AutomationRun = serde_json::from_value(json!({
        "id": "legacy-run", "automationId": "weekday-review", "status": "running",
        "trigger": "scheduled", "scheduledFor": now, "createdAt": now, "updatedAt": now,
        "taskId": format!("automation-weekday--{}", now.timestamp_millis()),
    }))
    .unwrap();
    assert!(run.owns_task_for_goal_recovery());

    run.task_id = Some(run.independent_task_id(now - chrono::Duration::seconds(1)));
    assert!(!run.owns_task_for_goal_recovery());
}

fn china_schedule() -> AutomationSchedule {
    serde_json::from_value(json!({"type":"cron","expression":"0 9 * * *","workdayOnly":true}))
        .unwrap()
}

#[test]
fn china_workdays_filter_holidays_and_include_adjusted_weekends() {
    let next = |date: &str| {
        super::next_run_after_checked(&china_schedule(), "Asia/Shanghai", date.parse().unwrap())
            .unwrap()
            .unwrap()
    };
    assert_eq!(
        next("2026-09-30T02:00:00Z"),
        "2026-10-08T01:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap()
    );
    assert_eq!(
        next("2026-10-09T02:00:00Z"),
        "2026-10-10T01:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap()
    );
    let utc_cron: AutomationSchedule = serde_json::from_value(
        json!({"type":"cron","expression":"30 16 * * *","workdayOnly":true}),
    )
    .unwrap();
    assert_eq!(
        super::next_run_after_checked(&utc_cron, "UTC", "2026-09-30T15:00:00Z".parse().unwrap())
            .unwrap()
            .unwrap(),
        "2026-10-07T16:30:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap()
    );
    assert!(super::next_run_after_checked(
        &china_schedule(),
        "Asia/Shanghai",
        "2028-01-01T00:00:00Z".parse().unwrap()
    )
    .unwrap_err()
    .contains("2028"));
}

#[test]
fn old_cron_defaults_false_and_workday_flag_survives_storage() {
    let old: AutomationSchedule =
        serde_json::from_value(json!({"type":"cron","expression":"0 9 * * 1-5"})).unwrap();
    assert!(matches!(
        old,
        AutomationSchedule::Cron {
            workday_only: false,
            ..
        }
    ));
    assert_eq!(
        serde_json::to_value(&old).unwrap(),
        json!({"type":"cron","expression":"0 9 * * 1-5"})
    );
    let explicit_false: AutomationSchedule =
        serde_json::from_value(json!({"type":"cron","expression":"0 9 * * *","workdayOnly":false}))
            .unwrap();
    assert_eq!(
        serde_json::to_value(explicit_false).unwrap(),
        json!({"type":"cron","expression":"0 9 * * *"})
    );
    assert_eq!(
        serde_json::to_value(china_schedule()).unwrap()["workdayOnly"],
        true
    );
    assert_eq!(
        super::next_run_after(
            &old,
            "Asia/Shanghai",
            "2026-09-30T02:00:00Z".parse().unwrap()
        ),
        Some("2026-10-01T01:00:00Z".parse().unwrap())
    );
    let root = tempdir().unwrap();
    let path = root.path().join("automations.json");
    let store = AutomationStore::new(path.clone());
    let automation: Automation = serde_json::from_value(json!({"id":"workdays","version":0,"name":"Workdays","prompt":"Run","schedule":china_schedule(),"timezone":"Asia/Shanghai","taskPayload":{}})).unwrap();
    store.create(automation).unwrap();
    drop(store);
    let reloaded = AutomationStore::new(path);
    assert!(matches!(
        reloaded.get("workdays").unwrap().schedule,
        AutomationSchedule::Cron {
            workday_only: true,
            ..
        }
    ));
}

#[test]
fn delayed_workday_dispatch_is_skipped_and_manual_dispatch_is_allowed() {
    let root = tempdir().unwrap();
    let store = AutomationStore::new(root.path().join("automations.json"));
    let automation: Automation = serde_json::from_value(json!({"id":"workdays","version":0,"name":"Workdays","prompt":"Run","schedule":china_schedule(),"timezone":"Asia/Shanghai","taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"}},"taskPayload":{}})).unwrap();
    store.create(automation).unwrap();
    let workday = "2026-09-30T01:00:00Z".parse().unwrap();
    store
        .state
        .lock()
        .unwrap()
        .automations
        .get_mut("workdays")
        .unwrap()
        .next_run_at = Some(workday);
    let (automation, run) = store.due(workday).unwrap().pop().unwrap();
    assert!(!store
        .allow_dispatch(&automation, &run, "2026-10-01T01:00:00Z".parse().unwrap())
        .unwrap());
    assert_eq!(
        store.list_runs(Some("workdays"))[0].status,
        AutomationRunStatus::Skipped
    );
    let (automation, run) = store.start_manual_run("workdays").unwrap();
    assert!(store
        .allow_dispatch(&automation, &run, "2028-01-01T01:00:00Z".parse().unwrap())
        .unwrap());
}

#[test]
fn unknown_calendar_is_isolated_and_resumes_after_supported_time_returns() {
    let root = tempdir().unwrap();
    let store = AutomationStore::new(root.path().join("automations.json"));
    for (id, schedule) in [
        ("workdays", china_schedule()),
        (
            "ordinary",
            serde_json::from_value(json!({"type":"interval","value":1,"unit":"hours"})).unwrap(),
        ),
    ] {
        let automation: Automation = serde_json::from_value(json!({"id":id,"version":0,"name":id,"prompt":"Run","schedule":schedule,"timezone":"Asia/Shanghai","taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"}},"taskPayload":{}})).unwrap();
        store.create(automation).unwrap();
        store
            .state
            .lock()
            .unwrap()
            .automations
            .get_mut(id)
            .unwrap()
            .next_run_at = Some("2026-11-16T01:00:00Z".parse().unwrap());
    }
    let due = store.due("2028-01-01T01:00:00Z".parse().unwrap()).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].0.id, "ordinary");
    assert!(store.list_runs(Some("workdays"))[0]
        .error
        .as_ref()
        .unwrap()
        .contains("2028"));
    assert!(store.get("workdays").unwrap().next_run_at.is_some());
    assert_eq!(
        store
            .due("2026-11-16T01:00:00Z".parse().unwrap())
            .unwrap()
            .len(),
        1
    );
}

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
            workday_only: false,
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
        ..AutomationState::default()
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
            ..AutomationState::default()
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

fn update_fixture(store: &AutomationStore) -> Automation {
    store.create(serde_json::from_value(json!({
        "id":"daily", "version":0, "name":"Daily report", "prompt":"Original report",
        "schedule":{"type":"cron","expression":"0 18 * * *"}, "timezone":"Asia/Shanghai",
        "taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"},"standInCalendar":{}},
        "taskPayload":{}
    })).unwrap()).unwrap()
}

#[test]
fn schedule_update_write_failure_retains_memory_disk_and_retry_version() {
    let root = tempdir().unwrap();
    let path = root.path().join("automations.json");
    let store = AutomationStore::new(path.clone());
    let original = update_fixture(&store);
    let shared = AutomationStore::new(path.clone());
    let bytes = fs::read(&path).unwrap();
    let mut edited = original.clone();
    edited.prompt = "Rejected report".into();
    let temporary = path.with_extension("json.tmp");
    fs::create_dir(&temporary).unwrap();

    assert!(store.update(edited.clone()).is_err());

    for handle in [&store, &shared] {
        assert_eq!(
            serde_json::to_value(handle.get("daily").unwrap()).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
    }
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_dir(&temporary).unwrap();
    let mut other = original.clone();
    other.id = "other".into();
    store.create(other).unwrap();
    assert_eq!(
        read_state(&path).automations["daily"].prompt,
        original.prompt
    );
    let saved = store.update(edited).unwrap();
    assert_eq!(saved.version, original.version + 1);
    assert_eq!(saved.prompt, "Rejected report");
    drop(shared);
    drop(store);
    assert_eq!(
        AutomationStore::new(path).get("daily").unwrap().prompt,
        saved.prompt
    );
}

#[test]
fn schedule_update_message_keeps_an_overdue_occurrence_dispatchable_once() {
    let root = tempdir().unwrap();
    let store = AutomationStore::new(root.path().join("automations.json"));
    let mut original = update_fixture(&store);
    let at = Utc::now() - chrono::Duration::seconds(10);
    store
        .state
        .lock()
        .unwrap()
        .automations
        .get_mut("daily")
        .unwrap()
        .next_run_at = Some(at);
    original.prompt = "Report owners, collaborators and waiting time".into();
    // A caller's stale scheduling metadata must not replace the store's due occurrence.
    original.next_run_at = None;

    let saved = store.update(original).unwrap();

    assert_eq!(saved.next_run_at, Some(at));
    let due = store.due(Utc::now()).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].1.scheduled_for, at);
    assert_eq!(due[0].1.status, AutomationRunStatus::Pending);
    assert_eq!(due[0].0.prompt, saved.prompt);
    assert!(store.due(Utc::now()).unwrap().is_empty());
}

#[test]
fn schedule_update_trigger_changes_recompute_the_next_occurrence() {
    let root = tempdir().unwrap();
    for field in ["schedule", "timezone", "enabled"] {
        let store = AutomationStore::new(root.path().join(format!("{field}.json")));
        let mut original = update_fixture(&store);
        let at = Utc::now() - chrono::Duration::seconds(10);
        store
            .state
            .lock()
            .unwrap()
            .automations
            .get_mut("daily")
            .unwrap()
            .next_run_at = Some(at);
        match field {
            "schedule" => {
                original.schedule =
                    serde_json::from_value(json!({"type":"cron","expression":"0 19 * * *"}))
                        .unwrap()
            }
            "timezone" => original.timezone = "UTC".into(),
            "enabled" => original.enabled = false,
            _ => unreachable!(),
        }
        let before_update = Utc::now();
        let saved = store.update(original).unwrap();
        if saved.enabled {
            assert!(saved.next_run_at.unwrap() > before_update, "{field}");
        } else {
            assert!(saved.next_run_at.is_none());
        }
    }
}
