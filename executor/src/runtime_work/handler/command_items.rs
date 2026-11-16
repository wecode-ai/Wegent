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

pub(super) fn merge_codex_turn_items(
    turn: &mut Value,
    active_items: Vec<Value>,
    observed_order: &[String],
) {
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
    let existing_ids: HashSet<_> = items
        .iter()
        .filter_map(|item| string_field(item, "id"))
        .collect();
    let mut next_native_id = None;
    let mut anchors = HashMap::new();
    for id in observed_order.iter().rev() {
        if existing_ids.contains(id) {
            next_native_id = Some(id.clone());
        } else {
            anchors.insert(id.clone(), next_native_id.clone());
        }
    }
    let mut updates = HashMap::new();
    let mut before = HashMap::<Option<String>, Vec<Value>>::new();
    for item in active_items {
        let Some(id) = string_field(&item, "id") else {
            continue;
        };
        if existing_ids.contains(&id) {
            updates.insert(id, item);
        } else {
            before
                .entry(anchors.remove(&id).flatten())
                .or_default()
                .push(item);
        }
    }
    // A preempted response may never reach native history. Keep it before the
    // next observed native item instead of appending it after newer guidance.
    *items = merge_items_at_native_anchors(std::mem::take(items), updates, before);
    // Live notifications do not fill gaps in a paginated historical turn.
    turn_object
        .entry("itemsView".to_owned())
        .or_insert_with(|| Value::String("full".to_owned()));
}

fn merge_items_at_native_anchors(
    items: Vec<Value>,
    mut updates: HashMap<String, Value>,
    mut before: HashMap<Option<String>, Vec<Value>>,
) -> Vec<Value> {
    let mut merged = Vec::new();
    for mut item in items {
        let id = string_field(&item, "id");
        if let Some(additions) = before.remove(&id) {
            merged.extend(additions);
        }
        if let Some(update) = id.and_then(|id| updates.remove(&id)) {
            let position = item.get("position").cloned();
            item = merge_codex_command_item(&item, update);
            if let Some(position) = position {
                item["position"] = position;
            }
        }
        merged.push(item);
    }
    merged.extend(before.remove(&None).into_iter().flatten());
    merged
}
