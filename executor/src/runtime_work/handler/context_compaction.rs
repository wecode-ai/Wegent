// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn context_compaction_notification_outcome(
    message: &Value,
    previous_turn_id: Option<&str>,
    completed_items: &mut HashMap<String, Value>,
) -> Option<Result<(String, String), String>> {
    let turn_id = codex_notification_turn_id(message)?;
    if Some(turn_id.as_str()) == previous_turn_id {
        return None;
    }
    let params = message.get("params")?;
    match message.get("method").and_then(Value::as_str)? {
        "item/completed" => {
            let item = params.get("item")?;
            if is_codex_context_compaction_item_type(&item_type(item)) {
                completed_items.insert(turn_id, item.clone());
            }
            None
        }
        "turn/completed" => {
            let mut turn = params.get("turn")?.clone();
            if let Some(item) = completed_items.remove(&turn_id) {
                turn["items"] = json!([item]);
            }
            context_compaction_outcome(&json!({"turns": [turn]}), previous_turn_id)
        }
        _ => None,
    }
}

/// Reports what the newest turn says about a compaction action.
///
/// Only the newest turn can be the compaction turn: while it is still the turn
/// that preceded the action the provider has not started compacting, and no
/// older turn may be mistaken for the result. `None` means "keep waiting".
///
/// A turn that already ended without producing a compaction item never will -
/// the provider can fail the compaction turn (a model or route error, for
/// example) and still report it as completed - so it reports its own reason
/// instead of letting the caller surface a generic timeout.
pub(super) fn context_compaction_outcome(
    thread: &Value,
    previous_turn_id: Option<&str>,
) -> Option<Result<(String, String), String>> {
    let turn = thread.get("turns").and_then(Value::as_array)?.last()?;
    let turn_id = string_field(turn, "id")?;
    if Some(turn_id.as_str()) == previous_turn_id {
        return None;
    }
    let status = string_field(turn, "status")?;
    if matches!(
        status.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
        "inprogress" | "running" | "active"
    ) {
        return None;
    }
    if let Some(item) = turn
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| {
            status == "completed" && is_codex_context_compaction_item_type(&item_type(item))
        })
    {
        return Some(Ok((turn_id, item_id(item, "context_compaction"))));
    }
    let detail = turn
        .get("error")
        .and_then(|error| string_field(error, "message"))
        .or_else(|| string_field(turn, "error"));
    Some(Err(match detail {
        Some(detail) => format!("context compaction ended without compacting: {detail}"),
        None => format!("context compaction ended without compacting ({status})"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_for_turn_completion_after_the_compaction_item_completes() {
        let mut items = HashMap::new();
        for method in ["item/started", "item/completed"] {
            let message = json!({"method": method, "params": {
                "threadId": "thread", "turnId": "compact-turn",
                "item": {"id": "compact-item", "type": "contextCompaction"}
            }});
            assert_eq!(
                context_compaction_notification_outcome(&message, Some("previous"), &mut items),
                None
            );
        }
        let previous = json!({"method": "turn/completed", "params": {
            "threadId": "thread", "turn": {"id": "previous", "status": "completed", "items": []}
        }});
        assert_eq!(
            context_compaction_notification_outcome(&previous, Some("previous"), &mut items),
            None
        );
        let completed = json!({"method": "turn/completed", "params": {
            "threadId": "thread", "turn": {"id": "compact-turn", "status": "completed", "items": []}
        }});
        assert_eq!(
            context_compaction_notification_outcome(&completed, Some("previous"), &mut items),
            Some(Ok(("compact-turn".to_owned(), "compact-item".to_owned())))
        );
    }

    #[test]
    fn reports_an_authoritative_interruption_instead_of_waiting_for_timeout() {
        let interrupted = json!({"method": "turn/completed", "params": {
            "threadId": "thread", "turn": {"id": "compact-turn", "status": "interrupted", "items": []}
        }});
        assert_eq!(
            context_compaction_notification_outcome(
                &interrupted,
                Some("previous"),
                &mut HashMap::new()
            ),
            Some(Err(
                "context compaction ended without compacting (interrupted)".to_owned()
            ))
        );
    }
}
