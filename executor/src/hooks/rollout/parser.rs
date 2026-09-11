// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_REMEMBERED_CALLS: usize = 1024;

/// One file written by a Codex edit, normalized across rollout record shapes.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Change {
    pub path: String,
    /// `add` | `update` | `delete`
    pub kind: String,
    pub diff: String,
}

impl Change {
    pub fn json(&self, filepath: &str) -> Value {
        json!({"path": filepath, "kind": {"type": self.kind}, "diff": self.diff})
    }
}

/// Persisted with the file offset so a restart resumes mid-turn.
#[derive(Default, Serialize, Deserialize)]
pub(super) struct Parser {
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub turn_id: String,
    pending: BTreeMap<String, Vec<Change>>,
    #[serde(default)]
    emitted: BTreeSet<String>,
    #[serde(default)]
    emitted_order: VecDeque<String>,
}

pub(super) struct Edit {
    pub call_id: String,
    pub changes: Vec<Change>,
}

impl Parser {
    pub fn consume(&mut self, record: &Value) -> Result<Option<Edit>, String> {
        let payload = &record["payload"];
        match record["type"].as_str() {
            Some("turn_context") => {
                if let Some(cwd) = payload["cwd"].as_str() {
                    self.cwd = Some(cwd.to_owned());
                }
                if let Some(model) = payload["model"].as_str() {
                    self.model = Some(model.to_owned());
                }
                self.set_turn(payload);
            }
            Some("event_msg") => {
                self.set_turn(payload);
                let item = match payload["type"].as_str() {
                    Some("patch_apply_end") if payload["success"] == true => payload,
                    Some("item_completed")
                        if payload["item"]["type"]
                            .as_str()
                            .is_some_and(|kind| kind.eq_ignore_ascii_case("FileChange"))
                            && payload["item"]["status"] == "completed" =>
                    {
                        &payload["item"]
                    }
                    _ => return Ok(None),
                };
                let call_id = item["call_id"]
                    .as_str()
                    .or_else(|| item["id"].as_str())
                    .filter(|id| !id.is_empty())
                    .unwrap_or_default()
                    .to_owned();
                if !call_id.is_empty() {
                    self.pending.remove(&call_id);
                    if !self.remember(&call_id) {
                        return Ok(None);
                    }
                }
                let changes = structured_changes(item)?;
                if changes.is_empty() {
                    return Ok(None);
                }
                return Ok(Some(Edit { call_id, changes }));
            }
            Some("response_item") => return self.response_item(payload),
            _ => {}
        }
        Ok(None)
    }

    fn set_turn(&mut self, payload: &Value) {
        if let Some(id) = payload["turn_id"].as_str() {
            self.turn_id = id.to_owned();
        }
    }

    fn response_item(&mut self, payload: &Value) -> Result<Option<Edit>, String> {
        let Some(call_id) = payload["call_id"].as_str() else {
            return Ok(None);
        };
        match payload["type"].as_str() {
            Some("custom_tool_call") if payload["name"] == "apply_patch" => {
                let body = payload["input"]
                    .as_str()
                    .ok_or("apply_patch input is not text")?;
                self.pending
                    .insert(call_id.to_owned(), patch_changes(body)?);
            }
            Some("custom_tool_call_output") => {
                if let Some(changes) = self.pending.remove(call_id) {
                    if !apply_patch_succeeded(payload["output"].as_str().unwrap_or("")) {
                        return Ok(None);
                    }
                    if !self.remember(call_id) {
                        return Ok(None);
                    }
                    return Ok(Some(Edit {
                        call_id: call_id.to_owned(),
                        changes,
                    }));
                }
            }
            _ => {}
        }
        Ok(None)
    }

    /// Remembers a call id so the same patch is never emitted twice from one
    /// rollout, while keeping the persisted parser state bounded.
    fn remember(&mut self, call_id: &str) -> bool {
        if !self.emitted.insert(call_id.to_owned()) {
            return false;
        }
        self.emitted_order.push_back(call_id.to_owned());
        while self.emitted_order.len() > MAX_REMEMBERED_CALLS {
            if let Some(oldest) = self.emitted_order.pop_front() {
                self.emitted.remove(&oldest);
            }
        }
        true
    }
}

/// App-server items carry an array of changes, the rollout's Rust `FileChange`
/// carries a path map, and older records carry a single change.
fn structured_changes(item: &Value) -> Result<Vec<Change>, String> {
    if let Some(changes) = item["changes"].as_array() {
        return Ok(changes
            .iter()
            .filter_map(|change| {
                let path = change["path"].as_str()?.to_owned();
                Some(Change {
                    path,
                    kind: normalize_kind(change["kind"]["type"].as_str()),
                    diff: change_diff(change),
                })
            })
            .collect());
    }
    if let Some(changes) = item["changes"].as_object() {
        return Ok(changes
            .iter()
            .map(|(path, change)| Change {
                path: path.clone(),
                kind: normalize_kind(change["type"].as_str()),
                diff: change_diff(change),
            })
            .collect());
    }
    if let Some(path) = item["path"].as_str() {
        return Ok(vec![Change {
            path: path.to_owned(),
            kind: normalize_kind(item["kind"]["type"].as_str()),
            diff: change_diff(item),
        }]);
    }
    Err("file change has no changes".to_owned())
}

fn change_diff(change: &Value) -> String {
    for key in ["diff", "unified_diff", "content"] {
        if let Some(diff) = change[key].as_str() {
            return diff.to_owned();
        }
    }
    String::new()
}

fn normalize_kind(kind: Option<&str>) -> String {
    match kind.unwrap_or("update").to_ascii_lowercase().as_str() {
        "add" | "create" | "created" => "add".to_owned(),
        "delete" | "deleted" => "delete".to_owned(),
        _ => "update".to_owned(),
    }
}

/// Mirrors the success detection of both the legacy `codex exec` output and the
/// current unified-exec output.
fn apply_patch_succeeded(output: &str) -> bool {
    if let Ok(value) = serde_json::from_str::<Value>(output) {
        return value["metadata"]["exit_code"] == 0;
    }
    output.starts_with("Success. Updated the following files:")
        || output.lines().next() == Some("Exit code: 0")
}

fn patch_changes(body: &str) -> Result<Vec<Change>, String> {
    let mut changes = Vec::new();
    let mut current: Option<(String, String, Vec<String>)> = None;
    for line in body.lines() {
        let header = [
            ("*** Add File: ", "add"),
            ("*** Update File: ", "update"),
            ("*** Delete File: ", "delete"),
        ]
        .into_iter()
        .find_map(|(prefix, kind)| line.strip_prefix(prefix).map(|path| (path, kind)));
        if let Some((path, kind)) = header {
            finish_patch(&mut changes, current.take());
            current = Some((path.to_owned(), kind.to_owned(), Vec::new()));
        } else if line == "*** End Patch" {
            finish_patch(&mut changes, current.take());
        } else if !line.starts_with("***") {
            if let Some((_, kind, lines)) = current.as_mut() {
                lines.push(if kind == "add" {
                    line.strip_prefix('+').unwrap_or(line).to_owned()
                } else {
                    line.to_owned()
                });
            }
        }
    }
    if current.is_some() {
        return Err("apply_patch body is incomplete".to_owned());
    }
    Ok(changes)
}

fn finish_patch(changes: &mut Vec<Change>, section: Option<(String, String, Vec<String>)>) {
    let Some((path, kind, lines)) = section else {
        return;
    };
    let mut diff = lines.join("\n");
    // apply_patch permits the first update chunk without an @@ header.
    if kind == "update" && !diff.starts_with("@@") {
        diff = format!("@@\n{diff}");
    }
    if kind == "add" && !lines.is_empty() {
        diff.push('\n');
    }
    changes.push(Change { path, kind, diff });
}
