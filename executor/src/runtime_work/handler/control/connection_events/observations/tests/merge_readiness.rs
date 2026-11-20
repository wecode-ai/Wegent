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
fn github_merge_wait_captures_either_check_failure_or_conflict_once() {
    let topic = "https://github.com/org/repo/pull/1";
    let args = json!({"git_wait":"merge",
        "source":{"providerId":"@wegent/dsh-connection-git/github","name":"org/repo",
            "profile":"[\"https://github.com\",\"7\"]","kind":"repository",
            "monitoredObjects":[{"entityKind":"change_request","number":1}]}});
    let filter = conditions::resolve(&args).unwrap();
    validate_filter(&filter).unwrap();
    let event = |id, topic, event_type, payload| {
        json!({
            "id":id,"at":"2026-11-15T00:00:01Z","topicId":topic,
            "external":{"eventType":event_type,"payload":payload}
        })
    };
    let failure = event(
        "shard-failed",
        topic,
        "tracked.checks",
        json!({"status":"completed","conclusion":"failure"}),
    );
    let conflict = event(
        "merge-conflict",
        topic,
        "tracked.status",
        json!({"mergeable":"CONFLICTING","statusCheckRollup":{"state":"PENDING"}}),
    );
    let other = event(
        "other-conflict",
        "https://github.com/org/repo/pull/2",
        "tracked.status",
        json!({"mergeable":"CONFLICTING"}),
    );
    for (first, second) in [(&failure, &conflict), (&conflict, &failure)] {
        let mut state = json!({"operations":{"wait":{"observation_id":"shared","status":"armed",
            "source":{"observeCurrentStatus":true,"enabledAfter":"2026-11-15T00:00:00Z"},
            "after_sequence":0,"initial_sequence":0,"match":filter}}});
        assert!(!capture_consumers(
            &mut state,
            "shared",
            &observation(1, other.clone())
        ));
        assert!(capture_consumers(
            &mut state,
            "shared",
            &observation(2, first.clone())
        ));
        assert_eq!(state["operations"]["wait"]["events"], json!([first]));
        state["operations"]["wait"]["status"] = json!("delivered");
        assert!(!capture_consumers(
            &mut state,
            "shared",
            &observation(3, second.clone())
        ));
    }
}
