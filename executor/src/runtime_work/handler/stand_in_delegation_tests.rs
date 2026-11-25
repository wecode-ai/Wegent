use super::*;

const QUESTION_AT: i64 = 1_795_507_200_000;

#[tokio::test(start_paused = true)]
async fn automatic_receipt_check_stops_on_confirmation_or_when_only_uncertainty_remains() {
    for (confirmation, expected_checks) in [(Some(2), 2), (None, 3)] {
        let mut checks = 0;
        poll_delegated_receipt(|| {
            checks += 1;
            let status = if confirmation == Some(checks) {
                "sent"
            } else {
                "unknown"
            };
            std::future::ready(Ok(json!({"status":status})))
        })
        .await
        .unwrap();
        assert_eq!(checks, expected_checks);
    }
    let started = tokio::time::Instant::now();
    poll_delegated_receipt(std::future::pending).await.unwrap();
    assert_eq!(started.elapsed(), Duration::from_secs(10));
}

#[tokio::test]
async fn interrupted_dingtalk_submission_reopens_as_unknown_without_replaying() {
    let root = tempfile::tempdir().unwrap();
    let device = "desktop";
    let make_handler = || RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(root.path().join("runtime.json")),
        task_store_path: Arc::new(root.path().join("tasks.sqlite")),
        ..RuntimeWorkRpcHandler::new(device, "unused")
    };
    let handler = make_handler();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, device).unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"","preferences":""});
    settings["primary"]["connections"] = json!([{
        "providerId":DINGTALK_PROVIDER,"kind":"direct","id":"peer","name":"Peer",
        "profile":"current","accountId":"account","policy":{"automatic":false,"askBeforeAct":true}
    }]);
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let settings = store.save_personal_stand_in(7, device, settings).unwrap();
    let source = &settings["primary"]["connections"][0];
    let event = json!({"id":"question","text":"Where is the guide?","at":"2099-01-01T00:00:00Z"});
    let work = store
        .ingest_stand_in_message(7, "@primary", source, &event, None)
        .unwrap();
    let work_id = work["id"].as_str().unwrap();
    let record_id = work["latestMessage"]["recordId"].as_str().unwrap();
    let gate = handler.task_send_gate(&format!("dingtalk-dispatch:{work_id}"));
    let sending = gate.lock().await;
    assert!(store
        .record_delegation_decision(
            7,
            device,
            work_id,
            record_id,
            json!({
                "action":"reply","template":"document","attemptId":"attempt-question",
                "policyVersion":settings["primary"]["delegation"]["version"]
            }),
        )
        .unwrap()
        .is_some());
    let list = || json!({"userId":7,"roleId":"@primary"});
    let in_flight = handler.list_connection_stand_in_work(list()).unwrap();
    let submitted_at = &in_flight["items"][0]["delegationResult"]["submittedAt"];
    assert!(submitted_at.is_string());
    assert_eq!(
        in_flight["items"][0]["delegationResult"]["status"],
        "submitting"
    );
    drop(sending);
    drop(handler);
    drop(store);

    let restarted = make_handler();
    let store = LocalTaskStore::open(restarted.task_store_path.as_ref()).unwrap();
    let recovered = restarted.list_connection_stand_in_work(list()).unwrap();
    let result = &recovered["items"][0]["delegationResult"];
    assert_eq!(result["status"], "unknown");
    assert_eq!(result["attemptId"], "attempt-question");
    assert_eq!(result["submittedAt"], *submitted_at);
    assert!(result["receiptId"].is_null());
    let replay = store
        .ingest_stand_in_message(7, "@primary", source, &event, None)
        .unwrap();
    assert_eq!(replay["id"], work_id);
    assert_eq!(replay["messageCount"], 1);
    restarted
        .run_connection_stand_in_work(json!({"userId":7,"workId":work_id}))
        .await
        .unwrap();
    let replayed = restarted.list_connection_stand_in_work(list()).unwrap();
    assert_eq!(replayed["items"][0]["delegationResult"], *result);
}

fn conversation(question: &str, history: &[(&str, &str)]) -> Value {
    let messages: Vec<_> = history
        .iter()
        .enumerate()
        .map(|(index, (id, text))| {
            json!({
                "id": id,
                "conversationId": "selected-chat",
                "at": QUESTION_AT - (history.len() - index) as i64 * 1000,
                "textMessage": true,
                "recalled": false,
                "text": text,
            })
        })
        .collect();
    json!({
        "target": {
            "id": "question",
            "conversationId": "selected-chat",
            "at": QUESTION_AT,
            "textMessage": true,
            "isOwn": false,
            "recalled": false,
            "text": question,
        },
        "messages": messages,
    })
}

fn decision(template: &str, evidence: &[(&str, &str)], link: Option<&str>) -> Value {
    let evidence: Vec<_> = evidence
        .iter()
        .map(|(id, quote)| json!({"messageId": id, "quote": quote}))
        .collect();
    json!({
        "action": "reply",
        "reason": "The earlier messages answer the question.",
        "template": template,
        "evidence": evidence,
        "link": link,
    })
}

fn assert_reply(
    snapshot: &Value,
    proposed: &Value,
    template: &str,
    evidence_ids: &[&str],
    text: &str,
) {
    let reply = supported_reply(snapshot, proposed).expect("the reply has verifiable evidence");
    assert_eq!(reply.template, template);
    assert_eq!(reply.evidence_ids.as_slice(), evidence_ids);
    assert_eq!(reply.evidence.len(), evidence_ids.len());
    for (evidence, expected_id) in reply.evidence.iter().zip(evidence_ids) {
        assert_eq!(evidence["messageId"], *expected_id);
        assert!(evidence["excerpt"]
            .as_str()
            .is_some_and(|excerpt| !excerpt.is_empty()));
    }
    assert_eq!(reply.text, text);
}

#[test]
fn document_name_and_link_can_be_in_separate_messages() {
    let link = "https://example.org/dots/handbook";
    let snapshot = conversation(
        "刚才说的联调手册地址在哪？",
        &[
            ("name", "下午联调用《钉钉联调手册》。"),
            ("reference", "下面这条是联调手册的团队可访问地址。"),
            ("link", link),
        ],
    );
    let proposed = decision(
        "document",
        &[
            ("name", "钉钉联调手册"),
            ("reference", "联调手册的团队可访问地址"),
            ("link", link),
        ],
        Some(link),
    );

    assert_reply(
        &snapshot,
        &proposed,
        "document",
        &["name", "reference", "link"],
        link,
    );
}

#[test]
fn confirmed_date_time_and_place_can_be_in_separate_messages() {
    let snapshot = conversation(
        "联调培训哪天、几点、在哪？",
        &[
            ("date", "确认联调培训定在下周三。"),
            ("time", "联调培训下午 3 点开始，请准时。"),
            ("place", "联调培训地点已定为 302 会议室。"),
        ],
    );
    let proposed = decision(
        "schedule",
        &[
            ("date", "下周三"),
            ("time", "下午 3 点开始"),
            ("place", "302 会议室"),
        ],
        None,
    );

    assert_reply(
        &snapshot,
        &proposed,
        "schedule",
        &["date", "time", "place"],
        "下周三\n下午 3 点开始\n302 会议室",
    );
}

#[test]
fn standard_process_can_use_separate_messages_in_the_confirmed_step_order() {
    let snapshot = conversation(
        "按之前约定，发布流程怎么走？",
        &[
            ("second", "发布第二步：完成发布检查。"),
            ("third", "发布第三步：登记发布回执。"),
            ("first", "补上发布第一步：核对版本号。"),
        ],
    );
    let proposed = decision(
        "process",
        &[
            ("first", "第一步：核对版本号。"),
            ("second", "第二步：完成发布检查。"),
            ("third", "第三步：登记发布回执。"),
        ],
        None,
    );

    assert_reply(
        &snapshot,
        &proposed,
        "process",
        &["first", "second", "third"],
        "第一步：核对版本号。\n第二步：完成发布检查。\n第三步：登记发布回执。",
    );
}

#[test]
fn repeated_process_step_text_from_different_messages_is_preserved() {
    let snapshot = conversation(
        "按之前约定，清洁流程怎么走？",
        &[
            ("first-rinse", "冲洗"),
            ("detergent", "加清洁剂"),
            ("last-rinse", "冲洗"),
        ],
    );
    let proposed = decision(
        "process",
        &[
            ("first-rinse", "冲洗"),
            ("detergent", "加清洁剂"),
            ("last-rinse", "冲洗"),
        ],
        None,
    );

    assert_reply(
        &snapshot,
        &proposed,
        "process",
        &["first-rinse", "detergent", "last-rinse"],
        "冲洗\n加清洁剂\n冲洗",
    );
}

#[test]
fn multiple_fragments_from_one_message_retain_one_evidence_id() {
    let snapshot = conversation(
        "培训几点开始，在哪儿？",
        &[(
            "booking",
            "培训下午 3 点开始。无需自带电脑。地点在 302 会议室。",
        )],
    );
    let proposed = decision(
        "schedule",
        &[("booking", "下午 3 点开始"), ("booking", "302 会议室")],
        None,
    );

    assert_reply(
        &snapshot,
        &proposed,
        "schedule",
        &["booking"],
        "下午 3 点开始\n302 会议室",
    );
}

#[test]
fn an_identical_citation_is_emitted_once() {
    let snapshot = conversation("培训几点开始？", &[("booking", "培训下午 3 点开始。")]);
    let proposed = decision(
        "schedule",
        &[("booking", "下午 3 点开始"), ("booking", "下午 3 点开始")],
        None,
    );

    assert_reply(
        &snapshot,
        &proposed,
        "schedule",
        &["booking"],
        "下午 3 点开始",
    );
}

#[test]
fn every_citation_must_still_match_a_unique_earlier_message_in_the_question_conversation() {
    let snapshot = conversation(
        "培训几点开始，在哪儿？",
        &[
            ("time", "培训下午 3 点开始。"),
            ("place", "地点是 302 会议室。"),
        ],
    );
    let proposed = decision(
        "schedule",
        &[("time", "下午 3 点开始"), ("place", "302 会议室")],
        None,
    );
    assert!(supported_reply(&snapshot, &proposed).is_some());

    for (field, invalid) in [
        ("id", json!("different-message")),
        ("conversationId", json!("another-chat")),
        ("at", json!(QUESTION_AT)),
        ("at", json!(QUESTION_AT + 1000)),
        ("textMessage", json!(false)),
        ("recalled", json!(true)),
        ("text", json!("地点改为 501 会议室。")),
    ] {
        let mut changed = snapshot.clone();
        changed["messages"][1][field] = invalid;
        assert!(
            supported_reply(&changed, &proposed).is_none(),
            "{field} changed"
        );
    }

    let mut duplicated = snapshot.clone();
    let duplicate = duplicated["messages"][1].clone();
    duplicated["messages"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert!(supported_reply(&duplicated, &proposed).is_none());
}

#[test]
fn a_reply_cannot_add_uncited_steps_or_use_an_empty_quote() {
    let snapshot = conversation(
        "发布流程怎么走？",
        &[
            ("first", "第一步：核对版本号。"),
            ("second", "第二步：完成发布检查。"),
        ],
    );
    for quote in [" ", "第二步：完成发布检查。上线后我会替你审批。"] {
        let proposed = decision(
            "process",
            &[("first", "第一步：核对版本号。"), ("second", quote)],
            None,
        );
        assert!(supported_reply(&snapshot, &proposed).is_none());
    }
}

#[test]
fn document_reply_uses_only_a_single_unchanged_cited_web_link() {
    let link = "https://example.org/guide";
    let other_link = "https://example.org/other";
    let snapshot = conversation(
        "联调手册地址呢？",
        &[
            ("document", "说明：https://example.org/guide。"),
            ("other", other_link),
        ],
    );
    let evidence = [("document", link)];
    let proposed = decision("document", &evidence, Some(link));
    assert_reply(&snapshot, &proposed, "document", &["document"], link);

    for invalid in [
        None,
        Some("https://example.org"),
        Some(other_link),
        Some("请见 https://example.org/guide"),
        Some("https://example.org/guide https://example.org/other"),
    ] {
        assert!(supported_reply(&snapshot, &decision("document", &evidence, invalid)).is_none());
    }

    let truncated_link = "https://example.org";
    let truncated = decision(
        "document",
        &[("document", truncated_link)],
        Some(truncated_link),
    );
    assert!(supported_reply(&snapshot, &truncated).is_none());
}

#[test]
fn only_an_incoming_text_question_can_receive_a_delegated_reply() {
    let link = "https://example.org/guide";
    let snapshot = conversation("手册在哪？", &[("document", link)]);
    let proposed = decision("document", &[("document", link)], Some(link));

    for (field, invalid) in [("textMessage", false), ("isOwn", true), ("recalled", true)] {
        let mut changed = snapshot.clone();
        changed["target"][field] = json!(invalid);
        assert!(
            supported_reply(&changed, &proposed).is_none(),
            "{field} changed"
        );
    }
}
