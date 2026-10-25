// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::*;

pub(crate) fn cases() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../packages/chat-core/test-fixtures/conversation-search-contract.json"
    )))
    .unwrap();
    assert_eq!(fixture["version"], 1);
    assert_eq!(fixture["offsetUnit"], "utf16");
    fixture["cases"].as_array().unwrap().clone()
}

pub(crate) fn native_turn(case: &Value) -> Value {
    let items: Vec<_> = case["items"].as_array().unwrap().iter().map(|item| match item["kind"].as_str().unwrap() {
        "user" => json!({"id":item["id"], "type":"userMessage", "content":[{"type":"inputText", "text":item["content"]}]}),
        "tool" => json!({"id":item["id"], "type":"commandExecution", "command":item["content"]}),
        kind => json!({"id":item["id"], "type":"agentMessage", "phase":if kind == "narrative" {"commentary"} else {"final_answer"}, "text":item["content"]}),
    }).collect();
    json!({"id":case["id"], "items":items, "status":match case["status"].as_str().unwrap() {"cancelled"=>"interrupted", "failed"=>"failed", _=>"completed"}, "error":case["error"]})
}

pub(crate) fn cached_messages(case: &Value) -> Vec<Value> {
    let items = case["items"].as_array().unwrap();
    items.iter().enumerate().map(|(index, item)| {
        let mut message = json!({"id":item["id"],"turnId":case["id"],"status":"done","content":"","role":"assistant"});
        match item["kind"].as_str().unwrap() {
            "user" => { message["role"] = json!("user"); message["content"] = item["content"].clone(); }
            "final" => {
                message["content"] = item["content"].clone();
                message["runtimeItems"] = json!([{"id":item["id"],"type":"assistant_text","content":item["content"]}]);
            }
            kind => {
                let block = json!({"id":item["id"],"type":if kind == "narrative" {"text"} else {"tool"},"content":item["content"]});
                message["blocks"] = json!([block]);
                message["runtimeItems"] = json!([{"id":item["id"],"type":"block","block":block}]);
            }
        }
        if index + 1 == items.len() {
            message["status"] = case["status"].clone();
            if let Some(error) = case.get("error") { message["error"] = error.clone(); }
        }
        message
    }).collect()
}

pub(crate) fn assert_regions(case: &Value, regions: &[SearchRegion]) {
    let actual: Vec<_> = regions
        .iter()
        .map(|region| json!({"id":region.id, "text":region.text}))
        .collect();
    assert_eq!(json!(actual), case["regions"], "{} regions", case["id"]);
    for region in regions {
        let text_length = region.text.encode_utf16().count();
        for source in &region.sources {
            let item = case["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == source.item_id)
                .unwrap();
            assert!(
                source.start < source.end && source.end <= text_length,
                "{} visible source span",
                case["id"]
            );
            assert!(
                source.source_start < source.source_end
                    && source.source_end
                        <= item["content"].as_str().unwrap().encode_utf16().count(),
                "{} raw source span",
                case["id"]
            );
        }
    }
    for expected in case["mappingAssertions"].as_array().into_iter().flatten() {
        let region = regions
            .iter()
            .find(|region| region.id == expected["regionId"])
            .unwrap();
        let start = expected["start"].as_u64().unwrap() as usize;
        let end = expected["end"].as_u64().unwrap() as usize;
        let mapped: Vec<_> = region.sources.iter().filter_map(|source| {
            let first = source.start.max(start);
            let last = source.end.min(end);
            if first >= last { return None; }
            let linear = source.end - source.start == source.source_end - source.source_start;
            Some(json!({"itemId":source.item_id,"sourceStart":if linear {source.source_start+first-source.start} else {source.source_start},
                "sourceEnd":if linear {source.source_start+last-source.start} else {source.source_end}}))
        }).collect();
        if expected["rawEnvelope"] == true {
            assert_source_envelope(case, region, expected, start, end, &mapped);
            continue;
        }
        assert!(
            mapped
                .iter()
                .any(|source| source["itemId"] == expected["itemId"]
                    && source["sourceStart"] == expected["sourceStart"]
                    && source["sourceEnd"] == expected["sourceEnd"]),
            "{} mapping {}: actual {:?}",
            case["id"],
            expected,
            mapped
        );
    }
}

fn assert_source_envelope(
    case: &Value,
    region: &SearchRegion,
    expected: &Value,
    start: usize,
    end: usize,
    mapped: &[Value],
) {
    let mut coverage: Vec<_> = region
        .sources
        .iter()
        .filter_map(|source| {
            let first = source.start.max(start);
            let last = source.end.min(end);
            (first < last).then(|| {
                assert_eq!(json!(source.item_id), expected["itemId"]);
                (first, last)
            })
        })
        .collect();
    coverage.sort_unstable();
    let mut covered_until = start;
    for (first, last) in coverage {
        assert!(first <= covered_until, "{} source coverage gap", case["id"]);
        covered_until = covered_until.max(last);
    }
    assert_eq!(covered_until, end, "{} source coverage", case["id"]);
    assert_eq!(
        mapped
            .iter()
            .filter_map(|span| span["sourceStart"].as_u64())
            .min(),
        expected["sourceStart"].as_u64(),
        "{} raw envelope start",
        case["id"]
    );
    assert_eq!(
        mapped
            .iter()
            .filter_map(|span| span["sourceEnd"].as_u64())
            .max(),
        expected["sourceEnd"].as_u64(),
        "{} raw envelope end",
        case["id"]
    );
}

pub(crate) fn assert_matches(case: &Value, query: &Value, matches: &Value) {
    let actual: Vec<_> = matches.as_array().unwrap().iter().map(|matched| json!({
        "regionId":matched["regionId"], "start":matched["range"]["start"], "end":matched["range"]["end"],
    })).collect();
    let expected: Vec<_> = query["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|matched| {
            json!({
                "regionId":matched["regionId"], "start":matched["start"], "end":matched["end"],
            })
        })
        .collect();
    assert_eq!(actual, expected, "{} query {}", case["id"], query["query"]);
}

#[test]
fn scalar_folding_preserves_original_utf16_boundaries() {
    assert_eq!(
        search_ranges("İ x i\u{307} 😀 NEEDLE", "needle"),
        vec![SearchRange { start: 10, end: 16 }]
    );
    assert_eq!(
        search_ranges("İ i\u{307}", "İ"),
        vec![
            SearchRange { start: 0, end: 1 },
            SearchRange { start: 2, end: 4 }
        ]
    );
    assert!(search_ranges("İ", "i").is_empty());
    assert_eq!(
        search_ranges("ΟΣ", "οσ"),
        vec![SearchRange { start: 0, end: 2 }]
    );
}

#[test]
fn markdown_source_mapping_keeps_entity_escape_and_utf16_origins() {
    let region = MappedSource::new("item", "😀 &amp; \\*needle\\*").markdown_region("item");
    assert_eq!(region.text, "😀 & *needle*");
    assert!(region.sources.iter().any(|source| source.start == 3
        && source.end == 4
        && source.source_start == 3
        && source.source_end == 8));
    assert!(region.sources.iter().any(|source| source.start == 5
        && source.end == 12
        && source.source_start == 10
        && source.source_end == 17));
    assert_eq!(
        search_ranges(&region.text, "needle"),
        vec![SearchRange { start: 6, end: 12 }]
    );
}
