// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Preserve the served body while an external refresh is in flight.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

pub const SNAPSHOT_KEY: &str = "_pending_external_refresh";

#[derive(Clone, Debug, PartialEq)]
pub struct Document {
    pub id: i64,
    pub user_id: i64,
    pub attachment_id: i64,
    pub file_extension: String,
    pub file_size: i64,
    pub active: bool,
    pub status: String,
    pub index_status: String,
    pub generation: i64,
    pub source_config: Map<String, Value>,
    pub external_identity: bool,
    pub chunks: Option<Value>,
}

impl Document {
    pub fn converted_id(&self) -> Option<i64> {
        self.source_config
            .get("converted_attachment_id")
            .and_then(Value::as_i64)
    }

    pub fn external(&self) -> Map<String, Value> {
        self.source_config
            .get("external")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    }

    pub fn snapshot(&self, generation: i64) -> Option<Map<String, Value>> {
        let snapshot = self.source_config.get(SNAPSHOT_KEY)?.as_object()?;
        (snapshot.get("generation")?.as_i64()? == generation).then(|| snapshot.clone())
    }

    pub fn capture(&mut self, generation: i64) {
        let external = self.external();
        let sync = external.get("sync").and_then(Value::as_object);
        self.source_config.insert(SNAPSHOT_KEY.into(), json!({
            "generation": generation,
            "previous_index_status": self.index_status,
            "previous_is_active": self.active,
            "previous_document_status": self.status,
            "previous_attachment_id": self.attachment_id,
            "previous_converted_attachment_id": self.converted_id(),
            "previous_file_extension": self.file_extension,
            "previous_file_size": self.file_size,
            "previous_processing_error": self.source_config.get("processing_error"),
            "had_content_version": sync.is_some_and(|sync| sync.contains_key("content_version")),
            "previous_content_version": sync.and_then(|sync| sync.get("content_version")),
            "had_source_update_time": external.contains_key("source_update_time"),
            "previous_source_update_time": external.get("source_update_time"),
        }));
    }

    pub fn advance(&mut self, expected: i64, next: i64) {
        if let Some(mut snapshot) = self.snapshot(expected) {
            snapshot.insert("generation".into(), next.into());
            self.source_config
                .insert(SNAPSHOT_KEY.into(), snapshot.into());
        }
    }

    pub fn restore(&mut self, generation: i64) -> Option<BTreeSet<i64>> {
        let snapshot = self.snapshot(generation)?;
        let candidates = BTreeSet::from([
            self.attachment_id,
            self.converted_id().unwrap_or(0),
            number(&snapshot, "staged_attachment_id"),
        ]);
        let previous = number(&snapshot, "previous_attachment_id");
        let converted = snapshot
            .get("previous_converted_attachment_id")
            .and_then(Value::as_i64);
        self.source_config.remove(SNAPSHOT_KEY);
        replace_optional(
            &mut self.source_config,
            "converted_attachment_id",
            converted.map(Value::from),
        );
        replace_optional(
            &mut self.source_config,
            "processing_error",
            snapshot
                .get("previous_processing_error")
                .filter(|value| value.is_object())
                .cloned(),
        );
        let mut external = self.external();
        if let Some(sync) = external.get_mut("sync").and_then(Value::as_object_mut) {
            restore_field(
                sync,
                "content_version",
                &snapshot,
                "had_content_version",
                "previous_content_version",
            );
        }
        restore_field(
            &mut external,
            "source_update_time",
            &snapshot,
            "had_source_update_time",
            "previous_source_update_time",
        );
        self.source_config
            .insert("external".into(), external.into());
        self.attachment_id = previous;
        if let Some(extension) = snapshot
            .get("previous_file_extension")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.file_extension = extension.into();
        }
        self.file_size = number(&snapshot, "previous_file_size");
        self.active = snapshot
            .get("previous_is_active")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.index_status = snapshot
            .get("previous_index_status")
            .and_then(Value::as_str)
            .filter(|status| {
                [
                    "not_indexed",
                    "queued",
                    "pending_conversion",
                    "converting",
                    "indexing",
                    "success",
                    "failed",
                ]
                .contains(status)
            })
            .unwrap_or("failed")
            .into();
        if let Some(status) = snapshot
            .get("previous_document_status")
            .and_then(Value::as_str)
            .filter(|status| ["enabled", "disabled"].contains(status))
        {
            self.status = status.into();
        }
        Some(
            candidates
                .into_iter()
                .filter(|id| *id != 0 && *id != previous && Some(*id) != converted)
                .collect(),
        )
    }

    pub fn finalize(&mut self, generation: i64) -> Option<BTreeSet<i64>> {
        let snapshot = self.snapshot(generation)?;
        self.source_config.remove(SNAPSHOT_KEY);
        Some(
            BTreeSet::from([
                number(&snapshot, "previous_attachment_id"),
                number(&snapshot, "previous_converted_attachment_id"),
            ])
            .into_iter()
            .filter(|id| *id != 0 && *id != self.attachment_id && Some(*id) != self.converted_id())
            .collect(),
        )
    }
}

fn number(object: &Map<String, Value>, key: &str) -> i64 {
    object.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn replace_optional(object: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            object.insert(key.into(), value);
        }
        None => {
            object.remove(key);
        }
    }
}

fn restore_field(
    target: &mut Map<String, Value>,
    field: &str,
    snapshot: &Map<String, Value>,
    had: &str,
    previous: &str,
) {
    replace_optional(
        target,
        field,
        snapshot
            .get(had)
            .and_then(Value::as_bool)
            .unwrap_or(false)
            .then(|| snapshot.get(previous).cloned().unwrap_or(Value::Null)),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> Document {
        Document {
            id: 1, user_id: 4, attachment_id: 10, file_extension: "pdf".into(),
            file_size: 500, active: true, status: "enabled".into(),
            index_status: "success".into(), generation: 2,
            external_identity: true, chunks: None,
            source_config: json!({"converted_attachment_id":11,"external":{"source_update_time":"v1","sync":{"enabled":true,"content_version":"v1","indexed_version":"v1"}}}).as_object().unwrap().clone(),
        }
    }

    #[test]
    fn failed_refresh_restores_served_body_and_only_reaps_replacements() {
        let mut doc = document();
        doc.capture(3);
        doc.attachment_id = 20;
        doc.source_config
            .insert("converted_attachment_id".into(), 21.into());
        doc.source_config.get_mut(SNAPSHOT_KEY).unwrap()["staged_attachment_id"] = 22.into();
        doc.source_config["external"]["sync"]["content_version"] = "v2".into();
        assert_eq!(doc.restore(3), Some(BTreeSet::from([20, 21, 22])));
        assert_eq!(doc.attachment_id, 10);
        assert_eq!(doc.converted_id(), Some(11));
        assert_eq!(doc.index_status, "success");
        assert!(doc.active);
        assert_eq!(
            doc.source_config["external"]["sync"]["content_version"],
            "v1"
        );
        assert!(!doc.source_config.contains_key(SNAPSHOT_KEY));
    }

    #[test]
    fn successful_refresh_reaps_old_body_without_reaping_current_references() {
        let mut doc = document();
        doc.capture(3);
        doc.attachment_id = 20;
        assert_eq!(doc.finalize(3), Some(BTreeSet::from([10])));
        assert_eq!(doc.converted_id(), Some(11));
    }

    #[test]
    fn stale_attempt_cannot_restore_or_finalize_a_newer_snapshot() {
        let mut doc = document();
        doc.capture(3);
        doc.advance(3, 4);
        let before = doc.clone();
        assert_eq!(doc.restore(3), None);
        assert_eq!(doc.finalize(3), None);
        assert_eq!(doc, before);
        assert!(doc.snapshot(4).is_some());
    }
}
