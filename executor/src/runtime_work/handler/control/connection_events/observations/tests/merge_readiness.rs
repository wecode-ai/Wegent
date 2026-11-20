use super::*;

fn observation(sequence: u64, event: Value) -> Value {
    json!({"sequence":sequence,"events":[{"sequence":sequence,
        "key":format!("event-{sequence}"),"event":event}]})
}

#[test]
fn final_merge_condition_keeps_progress_quiet_in_ordinary_and_goal_waits() {
    let topic = "https://github.com/org/repo/pull/1";
    let filter = json!({
        "/topicId":topic,
        "/external/eventType":"tracked.status",
        "/external/payload/state":"OPEN",
        "/external/payload/isDraft":false,
        "/external/payload/mergeable":"MERGEABLE",
        "/external/payload/mergeStateStatus":"CLEAN",
        "/external/payload/statusCheckRollup/state":"SUCCESS"
    });
    for goal in [false, true] {
        let record = json!({"observation_id":"shared","status":"armed",
            "source":{"enabledAfter":"2026-11-15T00:00:00Z"},
            "after_sequence":0,"initial_sequence":0,"match":filter,
            "wait_for_event":goal,"waiting_goal":if goal {json!({"objective":"Wait for merge readiness"})} else {Value::Null}});
        let mut state = json!({"operations":{"wait":record}});
        let ready = json!({"id":"ready","at":"2026-11-15T00:00:01Z",
            "topicId":topic,"external":{"eventType":"tracked.status","payload":{
                "state":"OPEN","isDraft":false,"mergeable":"MERGEABLE",
                "mergeStateStatus":"CLEAN","statusCheckRollup":{"state":"SUCCESS"}}}});
        let mut sequence = 0;
        let mut ignored = Vec::new();
        for job in 0..4 {
            ignored.push(
                json!({"id":format!("job-{job}"),"at":ready["at"],"topicId":topic,
                "external":{"eventType":"tracked.checks","payload":{"conclusion":"success"}}}),
            );
        }
        for (pointer, value) in [
            (
                "/external/payload/statusCheckRollup/state",
                json!("PENDING"),
            ),
            (
                "/external/payload/statusCheckRollup/state",
                json!("FAILURE"),
            ),
            ("/external/payload/mergeStateStatus", json!("DIRTY")),
            ("/external/payload/mergeStateStatus", json!("BLOCKED")),
            ("/external/payload/mergeStateStatus", json!("UNKNOWN")),
            ("/external/payload/mergeable", json!("CONFLICTING")),
            ("/external/payload/isDraft", json!(true)),
            ("/external/payload/state", json!("CLOSED")),
            ("/topicId", json!("https://github.com/org/repo/pull/2")),
        ] {
            let mut event = ready.clone();
            *event.pointer_mut(pointer).unwrap() = value;
            ignored.push(event);
        }
        let mut missing = ready.clone();
        missing["external"]["payload"]
            .as_object_mut()
            .unwrap()
            .remove("mergeStateStatus");
        ignored.push(missing);
        for event in ignored {
            sequence += 1;
            assert!(!capture_consumers(
                &mut state,
                "shared",
                &observation(sequence, event)
            ));
            assert_eq!(state["operations"]["wait"]["status"], "armed");
            assert_eq!(state["operations"]["wait"]["after_sequence"], sequence);
            assert!(state["operations"]["wait"]["pending_wakeup"].is_null());
        }
        sequence += 1;
        assert!(capture_consumers(
            &mut state,
            "shared",
            &observation(sequence, ready.clone())
        ));
        let pending = state["operations"]["wait"].clone();
        assert_eq!(pending["status"], "pending");
        assert_eq!(pending["pending_wakeup"], true);
        assert_eq!(pending["events"], json!([ready]));
        assert!(!capture_consumers(
            &mut state,
            "shared",
            &observation(sequence + 1, ready.clone())
        ));
        assert_eq!(state["operations"]["wait"], pending);
    }
}

#[test]
fn github_merge_wait_captures_ci_failure_and_later_conflict_independently() {
    let topic = "https://github.com/org/repo/pull/1";
    let sha = "a".repeat(40);
    let args = json!({"git_wait":"merge","head_sha":sha,
        "source":{"providerId":"@wegent/dsh-connection-git/github","name":"org/repo",
            "profile":"[\"https://github.com\",\"7\"]","kind":"repository",
            "monitoredObjects":[{"entityKind":"change_request","number":1}]}});
    let mut checks = conditions::resolve(&args).unwrap();
    let conflict = conditions::split_github_merge(&args, &mut checks).unwrap();
    let goal = json!({"status":"active","objective":"Follow PR","createdAt":1,"tokenBudget":20000});
    let record = |filter| {
        json!({"observation_id":"shared","status":"armed",
        "source":{"providerId":"@wegent/dsh-connection-git/github","observeCurrentStatus":true,
            "enabledAfter":"2026-11-15T00:00:00Z"},
        "after_sequence":0,"initial_sequence":0,"match":filter,
        "wait_for_event":true,"waiting_goal":goal_identity(&goal)})
    };
    let event = |id, state, mergeable, head| {
        json!({"id":id,"at":"2026-11-15T00:00:01Z",
        "topicId":topic,"external":{"eventType":"tracked.status","payload":{
            "headRefOid":head,"statusCheckRollup":{"state":state},"mergeable":mergeable}}})
    };
    let mut state = json!({"operations":{"checks":record(checks),"conflict":record(conflict)}});

    let pending = event("ci-started", "PENDING", "MERGEABLE", &sha);
    assert!(!capture_consumers(
        &mut state,
        "shared",
        &observation(1, pending)
    ));
    let failure = json!({"id":"first-shard-failed","at":"2026-11-15T00:00:02Z","topicId":topic,
        "external":{"eventType":"tracked.checks","payload":{
            "head_sha":sha,"status":"completed","conclusion":"failure"}}});
    validate_filter(&state["operations"]["checks"]["match"]).unwrap();
    validate_filter(&state["operations"]["conflict"]["match"]).unwrap();
    assert!(capture_consumers(
        &mut state,
        "shared",
        &observation(2, failure.clone())
    ));
    assert_eq!(state["operations"]["checks"]["status"], "pending");
    assert_eq!(state["operations"]["checks"]["events"], json!([failure]));
    state["operations"]["checks"]["status"] = json!("delivered");
    assert_eq!(state["operations"]["conflict"]["status"], "armed");
    assert!(event_can_continue_goal(
        &state["operations"]["conflict"],
        &goal
    ));
    let mut paused = goal.clone();
    paused["status"] = json!("paused");
    assert!(!event_can_continue_goal(
        &state["operations"]["conflict"],
        &paused
    ));

    let different_head = "b".repeat(40);
    let mut unrelated = event(
        "other-pr-conflict",
        "FAILURE",
        "CONFLICTING",
        &different_head,
    );
    unrelated["topicId"] = json!("https://github.com/org/repo/pull/2");
    assert!(!capture_consumers(
        &mut state,
        "shared",
        &observation(3, unrelated)
    ));
    let conflict = event("later-conflict", "PENDING", "CONFLICTING", &different_head);
    assert!(capture_consumers(
        &mut state,
        "shared",
        &observation(4, conflict.clone())
    ));
    assert_eq!(state["operations"]["checks"]["status"], "delivered");
    assert_eq!(state["operations"]["conflict"]["status"], "pending");
    assert_eq!(state["operations"]["conflict"]["events"], json!([conflict]));
    assert!(!capture_consumers(
        &mut state,
        "shared",
        &observation(5, conflict)
    ));
}
