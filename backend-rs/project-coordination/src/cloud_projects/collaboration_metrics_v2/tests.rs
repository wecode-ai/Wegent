use super::*;
use brz_mysql::Json;
use chrono::TimeZone;

fn at(hour: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(1_800_000_000 + hour * 3600, 0).unwrap()
}
fn window() -> Window {
    Window { as_of: at(168) }
}
fn issue(id: usize) -> super::super::Issue {
    super::super::Issue {
        id: format!("issue-{id}"),
        status: "completed".into(),
        created_at: at(0).naive_utc(),
        completed_at: Some(at(100).naive_utc()),
        metadata: Json(json!({"status_history":[{"to_status":"completed","at":at(100)}]})),
    }
}
fn fact(key: &str, issue: usize, fact: Fact) -> Evidence {
    Evidence {
        key: key.into(),
        revision: 1,
        issue_id: format!("issue-{issue}"),
        references: vec![format!("issue-{issue}")],
        fact,
    }
}
fn contribution(id: i32, issue: usize) -> Evidence {
    fact(
        &format!("delivery-{id}"),
        issue,
        Fact::Contribution {
            user_id: Some(id),
            basis: ContributionBasis::Delivery,
            effective_at: at(80),
            revoked: false,
        },
    )
}
fn activity(agent: &str, start: i64, end: Option<i64>) -> Evidence {
    fact(
        agent,
        0,
        Fact::Activity {
            agent_id: agent.into(),
            run_id: agent.into(),
            owner_user_id: Some(7),
            started_at: at(start),
            ended_at: end.map(at),
            state: ActivityState::Active,
            outcome: if end.is_some() {
                RunOutcome::Completed
            } else {
                RunOutcome::Running
            },
        },
    )
}
fn unit(id: usize, mode: Classification) -> Evidence {
    fact(
        &format!("fixed-{id}"),
        0,
        Fact::Unit {
            unit_id: format!("fixed-{id}"),
            content_version: "v1".into(),
            accepted_version: Some("v1".into()),
            accepted_at: Some(at(100)),
            classification: mode,
            contributors: BTreeSet::from([7]),
        },
    )
}

#[test]
fn empty_or_fully_waiting_activity_serializes_as_positive_zero() {
    let mut waiting = activity("waiting-agent", 1, Some(2));
    if let Fact::Activity { state, .. } = &mut waiting.fact {
        *state = ActivityState::Queue;
    }
    for facts in [vec![], vec![waiting]] {
        for person in [None, Some(7), Some(8)] {
            let result = activity::compute(&facts, &BTreeSet::from([7, 8]), window(), person);
            for key in ["ai_active_seconds", "ai_active_hours"] {
                let value = result[key].as_f64().unwrap();
                assert_eq!(value, 0.0);
                assert!(value.is_sign_positive(), "{key}: {result}");
            }
            for value in result["per_person_seconds"].as_object().unwrap().values() {
                assert!(value.as_f64().unwrap().is_sign_positive());
            }
        }
    }
}

#[test]
fn ten_issues_with_three_contributors_give_thirty_participations_and_six_per_member() {
    let issues: Vec<_> = (0..10).map(issue).collect();
    let facts: Vec<_> = (0..10)
        .flat_map(|index| {
            [
                contribution(7, index),
                contribution(8, index),
                contribution(9, index),
            ]
        })
        .collect();
    let metrics = aggregate(
        &issues,
        &facts,
        &BTreeSet::from([7, 8, 9, 10, 11]),
        window(),
        None,
    );
    assert_eq!(metrics["completion"]["completed"], 10);
    assert_eq!(metrics["completion"]["numerator"], 30);
    assert_eq!(metrics["completion"]["per_member"], 6.0);
    assert_eq!(metrics["completion"]["per_person"]["7"], 10);
}

#[test]
fn multiple_roles_assistants_and_deliveries_count_once_and_former_members_keep_history() {
    let mut facts = vec![
        contribution(7, 0),
        contribution(7, 0),
        contribution(8, 0),
        contribution(9, 0),
    ];
    facts.push(fact(
        "unknown",
        0,
        Fact::Contribution {
            user_id: None,
            basis: ContributionBasis::FormalReview,
            effective_at: at(80),
            revoked: false,
        },
    ));
    let metrics = aggregate(
        &[issue(0)],
        &facts,
        &BTreeSet::from([7, 8, 10, 11, 12]),
        window(),
        None,
    );
    assert_eq!(metrics["completion"]["per_person"]["9"], 1);
    assert_eq!(metrics["completion"]["numerator"], 2);
    assert_eq!(metrics["completion"]["per_member"], 0.4);
    assert_eq!(metrics["completion"]["unknown"], 1);
    assert_eq!(metrics["member_snapshot"], json!([7, 8, 10, 11, 12]));
}

#[test]
fn mutable_assignee_comment_mention_and_legacy_completion_owner_do_not_create_participants() {
    let mut row = issue(0);
    row.metadata.0["completion_owner_user_id"] = json!(7);
    row.metadata.0["assignee_user_id"] = json!(7);
    row.metadata.0["comments"] = json!([{"by_user_id":7,"mentions":[8]}]);
    let result = aggregate(&[row], &[], &BTreeSet::from([7, 8]), window(), None);
    assert_eq!(result["completion"]["unknown"], 1);
    assert_eq!(result["completion"]["per_person"], json!({}));
}

#[test]
fn window_is_exact_half_open_with_fractional_completions_and_reopened_issues() {
    let mut lower = issue(0);
    lower.completed_at = Some(at(0).naive_utc());
    lower.metadata = Json(json!({}));
    let mut upper = issue(1);
    upper.completed_at = Some(at(168).naive_utc());
    upper.metadata = Json(json!({}));
    let mut outside = issue(2);
    outside.metadata.0["status_history"] =
        json!([{"to_status":"completed","at":at(0)-Duration::milliseconds(1)}]);
    let mut reopened = issue(3);
    reopened.status = "in_progress".into();
    let mut recent = issue(4);
    recent.completed_at = Some(at(168).naive_utc());
    recent.metadata.0["status_history"] =
        json!([{"to_status":"completed","at":at(168)-Duration::milliseconds(1)}]);
    let result = aggregate(
        &[lower, upper, outside, reopened, recent],
        &[],
        &BTreeSet::new(),
        window(),
        None,
    );
    assert_eq!(result["completion"]["completed"], 2);
    assert!(result["completion"]["per_member"].is_null());
    assert_eq!(
        result["window"],
        json!({"start":at(0),"end":at(168),"days":7})
    );
}

#[test]
fn four_hundred_agent_hours_over_forty_capacity_hours_is_runtime_ratio_ten() {
    let mut facts: Vec<_> = (0..10)
        .map(|id| activity(&format!("agent-{id}"), 1, Some(41)))
        .collect();
    facts.push(fact(
        "capacity",
        0,
        Fact::Capacity {
            user_id: 7,
            calendar_id: "declared-work-week".into(),
            available_seconds: 40.0 * 3600.0,
            member_from: at(0),
            member_until: at(168),
        },
    ));
    let result = aggregate(&[], &facts, &BTreeSet::from([7]), window(), Some(7));
    assert_eq!(result["activity"]["ai_active_hours"], 400.0);
    assert_eq!(result["activity"]["runtime_to_capacity_ratio"], 10.0);
    assert_eq!(
        result["activity"]["ratio_definition"],
        "runtime_hours_per_available_human_hour"
    );
}

#[test]
fn same_agent_overlaps_merge_across_issues_while_distinct_agents_sum() {
    let first = activity("same", -2, Some(5));
    let mut duplicate = activity("same", 2, Some(8));
    duplicate.issue_id = "another-issue".into();
    let other = activity("other", 1, Some(3));
    let result = aggregate(
        &[],
        &[first, duplicate, other],
        &BTreeSet::new(),
        window(),
        None,
    );
    assert_eq!(result["activity"]["ai_active_hours"], 10.0);
    assert!(result["activity"]["runtime_to_capacity_ratio"].is_null());
}

#[test]
fn failure_cancellation_partial_and_parent_wait_are_distinct() {
    let mut failed = activity("failed", 0, Some(2));
    if let Fact::Activity { outcome, .. } = &mut failed.fact {
        *outcome = RunOutcome::Failed;
    }
    let mut cancelled = activity("cancelled", 0, Some(1));
    if let Fact::Activity { outcome, .. } = &mut cancelled.fact {
        *outcome = RunOutcome::Cancelled;
    }
    let mut parent = activity("parent", 0, Some(168));
    if let Fact::Activity { state, .. } = &mut parent.fact {
        *state = ActivityState::ChildWait;
    }
    let running = activity("running", 167, None);
    let result = aggregate(
        &[],
        &[failed, cancelled, parent, running],
        &BTreeSet::new(),
        window(),
        None,
    );
    assert_eq!(result["activity"]["ai_active_hours"], 4.0);
    assert_eq!(result["activity"]["partial"], true);
    assert_eq!(result["activity"]["intervals"].as_array().unwrap().len(), 4);
}

#[test]
fn unit_acceptance_is_bound_to_content_version_and_unknown_suppresses_share() {
    let mut facts: Vec<_> = (0..10)
        .map(|id| {
            unit(
                id,
                if id < 7 {
                    Classification::Ai
                } else if id < 9 {
                    Classification::Mixed
                } else {
                    Classification::Human
                },
            )
        })
        .collect();
    let result = aggregate(&[], &facts, &BTreeSet::new(), window(), None);
    assert_eq!(result["delivery"]["ai_independent_share"], 0.7);
    assert_eq!(
        result["delivery"]["counts"],
        json!({"ai":7,"mixed":2,"human":1,"unknown":0})
    );
    if let Fact::Unit { classification, .. } = &mut facts[0].fact {
        *classification = Classification::Unknown;
    }
    assert!(aggregate(&[],&facts,&BTreeSet::new(),window(),None)["delivery"]["ai_independent_share"].is_null());
    if let Fact::Unit {
        content_version, ..
    } = &mut facts[0].fact
    {
        *content_version = "v2".into();
    }
    assert_eq!(
        aggregate(&[], &facts, &BTreeSet::new(), window(), None)["delivery"]["denominator"],
        9
    );
}

#[test]
fn handoff_ends_only_at_actual_start_and_unstarted_backlog_retains_full_wait() {
    let facts = [
        fact(
            "started",
            0,
            Fact::Handoff {
                ready_at: at(5),
                started_at: Some(at(6)),
                wait_type: WaitType::Queue,
                owner_user_id: Some(7),
            },
        ),
        fact(
            "pending",
            1,
            Fact::Handoff {
                ready_at: at(-1),
                started_at: None,
                wait_type: WaitType::External,
                owner_user_id: Some(8),
            },
        ),
    ];
    let result = aggregate(&[], &facts, &BTreeSet::new(), window(), None);
    assert_eq!(result["handoff"]["queue_p50_seconds"], 3600.0);
    assert_eq!(result["handoff"]["backlog"], 1);
    assert_eq!(result["handoff"]["longest_wait_seconds"], 169.0 * 3600.0);
    assert_eq!(result["handoff"]["pending"][0]["wait_type"], "external");
}

#[test]
fn cycle_percentiles_keep_nights_weekends_and_zero_sample_is_null() {
    let mut first = issue(0);
    first.completed_at = Some(at(24).naive_utc());
    first.metadata = Json(json!({}));
    let mut second = issue(1);
    second.completed_at = Some(at(72).naive_utc());
    second.metadata = Json(json!({}));
    let result = aggregate(&[first, second], &[], &BTreeSet::new(), window(), None);
    assert_eq!(result["cycle"]["p50_seconds"], 48.0 * 3600.0);
    assert_eq!(result["cycle"]["p90_seconds"], 67.2 * 3600.0);
    assert!(
        aggregate(&[], &[], &BTreeSet::new(), window(), None)["cycle"]["p50_seconds"].is_null()
    );
}

#[test]
fn evidence_roundtrips_without_accepting_arbitrary_private_payloads() {
    let record = contribution(7, 0);
    let value = serde_json::to_value(&record).unwrap();
    assert_eq!(
        serde_json::from_value::<Evidence>(value.clone()).unwrap(),
        record
    );
    let mut private = value;
    private["private_transcript"] = json!("secret");
    assert!(serde_json::from_value::<Evidence>(private).is_err());
}

#[test]
fn explicit_wait_intervals_remove_parent_wait_without_erasing_child_activity() {
    let parent = activity("parent", 0, Some(10));
    let mut waiting = activity("parent", 2, Some(8));
    waiting.key = "parent-wait".into();
    if let Fact::Activity { state, .. } = &mut waiting.fact {
        *state = ActivityState::ChildWait;
    }
    let child = activity("child", 2, Some(8));
    let result = aggregate(
        &[],
        &[parent, waiting, child],
        &BTreeSet::new(),
        window(),
        None,
    );
    assert_eq!(result["activity"]["ai_active_hours"], 10.0);
    assert_eq!(result["activity"]["sample"], 3);
}

#[test]
fn missing_or_overlapping_calendars_never_invent_capacity() {
    let mut calendar = fact(
        "calendar",
        0,
        Fact::Capacity {
            user_id: 7,
            calendar_id: "week".into(),
            available_seconds: 40.0 * 3600.0,
            member_from: at(0),
            member_until: at(168),
        },
    );
    let result = aggregate(
        &[],
        &[calendar.clone()],
        &BTreeSet::from([7, 8]),
        window(),
        None,
    );
    assert!(result["activity"]["denominator"].is_null());
    assert_eq!(result["activity"]["capacity"]["partial"], true);
    let mut duplicate = calendar.clone();
    duplicate.key = "another-calendar".into();
    if let Fact::Capacity { calendar_id, .. } = &mut duplicate.fact {
        *calendar_id = "overlapping".into();
    }
    let result = aggregate(
        &[],
        &[calendar.clone(), duplicate],
        &BTreeSet::from([7]),
        window(),
        None,
    );
    assert!(result["activity"]["denominator"].is_null());
    if let Fact::Capacity {
        available_seconds, ..
    } = &mut calendar.fact
    {
        *available_seconds = 0.0;
    }
    let result = aggregate(&[], &[calendar], &BTreeSet::from([7]), window(), None);
    assert_eq!(result["activity"]["denominator"], 0.0);
    assert!(result["activity"]["runtime_to_capacity_ratio"].is_null());
}

#[test]
fn personal_snapshot_excludes_unrelated_unknowns_and_retains_its_raw_evidence() {
    let result = aggregate(
        &[issue(0), issue(1)],
        &[contribution(7, 0), contribution(8, 0), contribution(8, 1)],
        &BTreeSet::from([7, 8]),
        window(),
        Some(7),
    );
    assert_eq!(result["completion"]["completed"], 1);
    assert_eq!(result["completion"]["per_person"], json!({"7":1}));
    assert_eq!(result["completion"]["unknown"], 0);
    assert_eq!(result["evidence"].as_array().unwrap().len(), 1);
    assert_eq!(result["evidence"][0]["fact"]["user_id"], 7);
}

#[test]
fn withdrawn_evidence_is_reported_without_exposing_its_contents_or_certain_ratios() {
    let mut result = aggregate(
        &[],
        &[unit(0, Classification::Ai)],
        &BTreeSet::new(),
        window(),
        None,
    );
    mark_unavailable(
        &mut result,
        &[
            unit(1, Classification::Human),
            activity("missing", 0, Some(1)),
        ],
        None,
    );
    assert_eq!(
        result["unavailable_evidence"],
        json!({"unit":1,"activity":1})
    );
    assert!(result["delivery"]["ai_independent_share"].is_null());
    assert_eq!(result["activity"]["partial"], true);
    assert_eq!(result["evidence"].as_array().unwrap().len(), 1);
}

#[test]
fn one_run_waiting_does_not_erase_another_run_on_the_same_agent() {
    let parent = activity("agent", 0, Some(10));
    let mut waiting = activity("agent", 2, Some(8));
    waiting.key = "wait".into();
    if let Fact::Activity { state, .. } = &mut waiting.fact {
        *state = ActivityState::ChildWait;
    }
    let mut other = activity("agent", 3, Some(6));
    other.key = "other".into();
    if let Fact::Activity { run_id, .. } = &mut other.fact {
        *run_id = "independent-run".into();
    }
    let result = aggregate(
        &[],
        &[parent, waiting, other],
        &BTreeSet::new(),
        window(),
        None,
    );
    assert_eq!(result["activity"]["ai_active_hours"], 7.0);
}

#[test]
fn run_ids_are_scoped_to_their_issue_when_combining_personal_projects() {
    let parent = activity("agent", 0, Some(10));
    let mut waiting = activity("agent", 2, Some(8));
    waiting.key = "waiting".into();
    if let Fact::Activity { state, .. } = &mut waiting.fact {
        *state = ActivityState::ChildWait;
    }
    let mut other = activity("agent", 3, Some(6));
    other.issue_id = "another-issue".into();
    let result = aggregate(
        &[],
        &[parent, waiting, other],
        &BTreeSet::new(),
        window(),
        None,
    );
    assert_eq!(result["activity"]["ai_active_hours"], 7.0);
}
