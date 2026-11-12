// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::*;

fn project_items(items: Vec<Value>) -> TranscriptProjection {
    project_transcript(
        &json!({
            "id": "thread-1",
            "turns": [{"id": "turn-1", "status": "completed", "items": items}],
        }),
        "device-1",
        true,
    )
}

#[test]
fn transcript_positions_preserve_generated_ids_and_assistant_segments() {
    let projection = project_items(vec![
        json!({"id":"before", "type":"reasoning", "summary":["Before positions"]}),
        json!({"id":"plan", "type":"plan", "text":"Think", "position":10}),
        json!({"id":"text", "type":"agentMessage", "text":"Progress", "position":11}),
        json!({"id":"next-user", "type":"userMessage", "message":"Continue", "position":12}),
        json!({"id":"after", "type":"reasoning", "summary":["Think again"]}),
        json!({"id":"final", "type":"agentMessage", "text":"Done", "position":14}),
    ]);

    let items = projection.turns[0]["items"].as_array().unwrap();
    assert_eq!(items[1]["id"], "plan-plan");
    assert_eq!(
        items
            .iter()
            .map(|item| item["position"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!(10),
            json!(10),
            json!(11),
            json!(12),
            json!(14),
            json!(14)
        ]
    );
    let runtime_items = projection
        .messages
        .iter()
        .filter_map(|message| message["runtimeItems"].as_array())
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(runtime_items.len(), 5);
    assert_eq!(
        runtime_items
            .iter()
            .map(|item| item["position"].clone())
            .collect::<Vec<_>>(),
        vec![json!(10), json!(10), json!(11), json!(14), json!(14)]
    );
}

#[test]
fn transcript_positions_keep_first_occurrence_of_duplicate_ids() {
    let mut assistant = AssistantTurnAccumulation::new(None);
    let mut positions = HashMap::new();
    assistant
        .blocks
        .push(json!({"id":" same ", "content":"First"}));
    assistant.record_new_items(0, 0);
    assistant.record_item_positions(&mut positions, 1);
    assistant
        .blocks
        .push(json!({"id":"same", "content":"Second"}));
    assistant.record_new_items(1, 0);
    assistant.record_item_positions(&mut positions, 2);

    assert_eq!(positions.len(), 1);
    assert_eq!(positions["same"], 1);
}

#[test]
fn transcript_long_positioned_turn_projects_within_interactive_budget() {
    let text = "x".repeat(2048);
    let items = (0..4000)
        .map(|index| {
            json!({
                "id": format!("reason-{index}"), "type":"reasoning",
                "summary":[text], "position":index,
            })
        })
        .collect();
    let started = std::time::Instant::now();
    let projection = project_items(items);
    let elapsed = started.elapsed();

    assert_eq!(projection.turns[0]["items"].as_array().unwrap().len(), 4000);
    let runtime_items = projection.messages[0]["runtimeItems"].as_array().unwrap();
    assert_eq!(runtime_items.len(), 4000);
    assert_eq!(runtime_items[0]["position"], 0);
    assert_eq!(runtime_items[3999]["position"], 3999);
    assert_eq!(runtime_items[0]["block"]["content"], text);
    assert_eq!(runtime_items[3999]["block"]["content"], text);
    // Leave ample headroom for debug builds and shared CI machines. The old
    // per-event serialization repeatedly copies gigabytes for this input.
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "Long turn took {elapsed:?}"
    );
}
