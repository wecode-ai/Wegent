// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn merge_codex_command_item(existing: &Value, mut incoming: Value) -> Value {
    if item_type(existing) == "commandexecution" && item_type(&incoming) == "commandexecution" {
        if let Some(output) = raw_string_field(existing, "aggregatedOutput") {
            let snapshot = raw_string_field(&incoming, "aggregatedOutput").unwrap_or_default();
            // A yield snapshot can arrive after newer output deltas.
            if output.starts_with(&snapshot) {
                incoming["aggregatedOutput"] = Value::String(output);
            }
        }
    }
    incoming
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positioned_history_excludes_completed_items_outside_its_page() {
        let mut turn = json!({"itemsPositioned":true,"items":[
            {"id":"new","type":"agentMessage","text":"Native output","position":4945}
        ]});
        merge_codex_turn_items(
            &mut turn,
            vec![
                json!({"id":"old","type":"agentMessage","text":"Old output","lifecycleCompleted":true}),
                json!({"id":"new","type":"agentMessage","text":"Stale cache","lifecycleCompleted":true}),
                json!({"id":"live","type":"agentMessage","text":"Still streaming","lifecycleCompleted":false}),
            ],
        );
        assert_eq!(turn["items"].as_array().unwrap().len(), 2);
        assert_eq!(turn["items"][0]["text"], "Native output");
        assert_eq!(turn["items"][0]["position"], 4945);
        assert_eq!(turn["items"][1]["id"], "live");
        assert!(turn["items"][1].get("position").is_none());
    }
}

pub(super) fn merge_codex_turn_items(turn: &mut Value, active_items: Vec<Value>) {
    let Some(turn_object) = turn.as_object_mut() else {
        return;
    };
    let positioned_page = turn_object.get("itemsPositioned").and_then(Value::as_bool) == Some(true);
    let items = turn_object
        .entry("items".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !items.is_array() {
        *items = Value::Array(Vec::new());
    }
    let items = items
        .as_array_mut()
        .expect("turn items were normalized to an array");
    let positioned = positioned_page || items.iter().any(|item| item.get("position").is_some());
    for active_item in active_items {
        let Some(item_id) = string_field(&active_item, "id") else {
            continue;
        };
        if let Some(existing) = items
            .iter_mut()
            .find(|existing| string_field(existing, "id").as_deref() == Some(item_id.as_str()))
        {
            let position = existing.get("position").cloned();
            if positioned && item_type(existing) != "commandexecution" {
                continue;
            }
            *existing = merge_codex_command_item(existing, active_item);
            if let Some(position) = position {
                existing["position"] = position;
            }
        } else {
            // A live cache is not a history page. Missing items can be older than this window.
            // Only unfinished items may extend the page as provisional live output.
            if !positioned
                || active_item
                    .get("lifecycleCompleted")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                items.push(active_item);
            }
        }
    }
    // Live notifications do not fill gaps in a paginated historical turn.
    turn_object
        .entry("itemsView".to_owned())
        .or_insert_with(|| Value::String("full".to_owned()));
}
