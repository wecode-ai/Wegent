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

pub(super) fn merge_codex_turn_items(turn: &mut Value, active_items: Vec<Value>) {
    let Some(turn_object) = turn.as_object_mut() else {
        return;
    };
    let items = turn_object
        .entry("items".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !items.is_array() {
        *items = Value::Array(Vec::new());
    }
    let items = items
        .as_array_mut()
        .expect("turn items were normalized to an array");
    for active_item in active_items {
        let Some(item_id) = string_field(&active_item, "id") else {
            continue;
        };
        if let Some(existing) = items
            .iter_mut()
            .find(|existing| string_field(existing, "id").as_deref() == Some(item_id.as_str()))
        {
            let position = existing.get("position").cloned();
            *existing = merge_codex_command_item(existing, active_item);
            if let Some(position) = position {
                existing["position"] = position;
            }
        } else {
            items.push(active_item);
        }
    }
    // Live notifications do not fill gaps in a paginated historical turn.
    turn_object
        .entry("itemsView".to_owned())
        .or_insert_with(|| Value::String("full".to_owned()));
}
