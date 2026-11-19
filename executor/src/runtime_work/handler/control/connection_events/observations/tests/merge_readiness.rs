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
