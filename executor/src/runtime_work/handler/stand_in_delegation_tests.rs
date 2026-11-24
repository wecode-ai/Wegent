use super::*;

const QUESTION_AT: i64 = 1_795_507_200_000;

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

#[test]
fn receipt_requires_a_channel_message_id() {
    let original = json!({"id":"original"});
    assert_eq!(receipt_id(&json!({"success":true}), &original), None);
    assert_eq!(
        receipt_id(
            &json!({"success":true,"result":{"openMessageId":"original"}}),
            &original
        ),
        None
    );
    assert_eq!(
        receipt_id(
            &json!({"success":true,"result":{"openMessageId":"sent"}}),
            &original
        ),
        Some("sent")
    );
}
