// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn legacy_search_and_hydration_obey_shared_projection_contract() {
    use crate::runtime_work::transcript_search_projection::contract_tests::*;
    for mut case in cases() {
        let turn_id = case["id"].clone();
        let mut ids = HashMap::new();
        let mut next = 1;
        let mut records = vec![event(json!({"type":"task_started","turn_id":case["id"]}))];
        for item in case["items"].as_array_mut().unwrap() {
            let original = item["id"].as_str().unwrap().to_owned();
            if item["kind"] == "tool" {
                records.push(event(json!({"type":"mcp_tool_call_end","call_id":original,"turn_id":turn_id,
                    "invocation":{"server":"contract","tool":"search_contract","arguments":{}},
                    "result":{"Ok":{"content":[{"type":"text","text":item["content"]}],"isError":false}}})));
            } else {
                let id = format!("item-{next}");
                next += 1;
                ids.insert(original, id.clone());
                item["id"] = json!(id);
                records.push(event(json!({"type":if item["kind"] == "user" {"user_message"} else {"agent_message"},
                    "message":item["content"],"phase":if item["kind"] == "narrative" {"commentary"} else {"final_answer"}})));
            }
        }
        for region in case["regions"].as_array_mut().unwrap() {
            if let Some(id) = ids.get(region["id"].as_str().unwrap()) {
                region["id"] = json!(id);
            }
        }
        for mapping in case["mappingAssertions"]
            .as_array_mut()
            .into_iter()
            .flatten()
        {
            for key in ["regionId", "itemId"] {
                if let Some(id) = ids.get(mapping[key].as_str().unwrap()) {
                    mapping[key] = json!(id);
                }
            }
        }
        for query in case["queries"].as_array_mut().unwrap() {
            for matched in query["matches"].as_array_mut().unwrap() {
                if let Some(id) = ids.get(matched["regionId"].as_str().unwrap()) {
                    matched["regionId"] = json!(id);
                }
            }
        }
        records.push(event(
            json!({"type":if case["status"] == "cancelled" {"turn_aborted"} else {"task_complete"},
            "turn_id":case["id"],"error":case["error"]}),
        ));
        let bytes = rollout(records);
        for query in case["queries"].as_array().unwrap() {
            let response = search(&bytes, query["query"].as_str().unwrap());
            assert_matches(&case, query, &response["matches"]);
            assert_eq!(
                response["totalMatches"],
                query["matches"].as_array().unwrap().len()
            );
            for matched in response["matches"].as_array().unwrap() {
                let hydrated = hydrate(&bytes, matched);
                let regions = codex_turn_search_regions(
                    &hydrated,
                    &HashMap::new(),
                    None,
                    &mut AsyncReplySearchProjection::default(),
                );
                assert_regions(&case, &regions);
                let region = regions
                    .iter()
                    .find(|region| region.id == matched["regionId"])
                    .unwrap();
                assert!(
                    search_ranges(&region.text, query["query"].as_str().unwrap())
                        .iter()
                        .any(|range| json!(range) == matched["range"])
                );
            }
        }
    }
}
