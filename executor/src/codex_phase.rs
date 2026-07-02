// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde_json::Value;

/// Tracks the live Codex app-server agent message protocol.
///
/// The live stream does not repeat the phase on every text delta:
///
/// 1. `item/started` starts an assistant text item and carries
///    `params.item.id` plus `params.item.phase`.
///    Example phases are `commentary`, `analysis`, and `final_answer`.
/// 2. Later `item/agentMessage/delta` events only carry `params.itemId`
///    plus `params.delta`; they normally do not carry `phase`.
/// 3. Reloaded transcripts and `item/completed` contain the phase again, so
///    refresh can look correct even when live streaming is misclassified.
///
/// Keep this mapping in each live consumer and route deltas by the resolved
/// phase. Do not infer phase from the text content, and do not wait for
/// `item/completed` when the UI needs streaming updates.
///
/// Sanitized protocol example:
///
/// ```json
/// {"method":"item/started","params":{"item":{"id":"msg_example","type":"agentMessage","phase":"commentary","text":""}}}
/// {"method":"item/agentMessage/delta","params":{"itemId":"msg_example","delta":"I will check."}}
/// {"method":"item/completed","params":{"item":{"id":"msg_example","type":"agentMessage","phase":"commentary","text":"I will check."}}}
///
/// {"method":"item/started","params":{"item":{"id":"msg_final","type":"agentMessage","phase":"final_answer","text":""}}}
/// {"method":"item/agentMessage/delta","params":{"itemId":"msg_final","delta":"Done."}}
/// {"method":"item/completed","params":{"item":{"id":"msg_final","type":"agentMessage","phase":"final_answer","text":"Done."}}}
/// ```
#[derive(Debug, Default, Clone)]
pub(crate) struct CodexAgentMessagePhaseTracker {
    phases_by_item_id: BTreeMap<String, String>,
}

impl CodexAgentMessagePhaseTracker {
    pub(crate) fn observe_item(&mut self, params: &Value) {
        let item = params.get("item").unwrap_or(params);
        let Some(item_id) = codex_item_id(item).or_else(|| codex_item_id(params)) else {
            return;
        };
        let Some(phase) = codex_phase_name(item).or_else(|| codex_phase_name(params)) else {
            return;
        };
        self.phases_by_item_id.insert(item_id, phase);
    }

    pub(crate) fn phase_for_delta(&self, params: &Value) -> Option<String> {
        codex_phase_name(params).or_else(|| {
            codex_item_id(params).and_then(|item_id| self.phases_by_item_id.get(&item_id).cloned())
        })
    }

    pub(crate) fn phase_for_item(&self, params: &Value) -> Option<String> {
        let item = params.get("item").unwrap_or(params);
        codex_phase_name(item)
            .or_else(|| codex_phase_name(params))
            .or_else(|| {
                codex_item_id(item)
                    .or_else(|| codex_item_id(params))
                    .and_then(|item_id| self.phases_by_item_id.get(&item_id).cloned())
            })
    }

    pub(crate) fn forget_item(&mut self, params: &Value) {
        let item = params.get("item").unwrap_or(params);
        if let Some(item_id) = codex_item_id(item).or_else(|| codex_item_id(params)) {
            self.phases_by_item_id.remove(&item_id);
        }
    }
}

pub(crate) fn codex_phase_name(value: &Value) -> Option<String> {
    ["phase", "channel"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(normalize_codex_phase)
        .filter(|phase| !phase.is_empty())
}

pub(crate) fn codex_phase_is_process(phase: Option<&str>) -> bool {
    matches!(phase, Some("analysis") | Some("commentary"))
}

pub(crate) fn normalize_codex_phase(value: &str) -> String {
    value.trim().replace(['_', '-'], "").to_ascii_lowercase()
}

pub(crate) fn codex_item_id(value: &Value) -> Option<String> {
    ["itemId", "item_id", "id", "messageId", "message_id"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(str::to_owned)
        .filter(|item_id| !item_id.is_empty())
}
