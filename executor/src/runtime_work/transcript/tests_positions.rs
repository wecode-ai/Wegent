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
