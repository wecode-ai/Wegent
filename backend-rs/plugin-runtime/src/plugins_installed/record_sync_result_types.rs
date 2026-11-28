// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `DeviceCapabilitySyncResult` / item result types and their ack mapping.

use serde_json::{Map, Value};

use super::raw_item_failure_message;

/// One `DeviceCapabilityItemResult`, serialized with every declared field.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncItem {
    pub id: Value,
    pub name: Value,
    pub server_name: Value,
    pub status: Value,
    pub stage: Value,
    pub error_code: Value,
    pub retryable: Value,
    pub error: Value,
    /// Plugin-only fields the device ack may carry for a synced item.
    pub generation: Value,
    pub version: Value,
    pub checksum: Value,
    pub operation: Value,
    pub source: Value,
}

impl SyncItem {
    /// `DeviceCapabilityItemResult(**item)`: absent fields take their schema
    /// defaults (`status="ok"`, everything else `None`).
    #[must_use]
    pub fn from_value(item: &Value) -> Self {
        let field = |name: &str| item.get(name).cloned().unwrap_or(Value::Null);
        let status = item
            .get("status")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("ok".to_string()));
        Self {
            id: field("id"),
            name: field("name"),
            server_name: field("server_name"),
            status,
            stage: field("stage"),
            error_code: field("error_code"),
            retryable: field("retryable"),
            error: field("error"),
            generation: field("generation"),
            version: field("version"),
            checksum: field("checksum"),
            operation: field("operation"),
            source: field("source"),
        }
    }

    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut value = Map::new();
        value.insert("id".to_string(), self.id.clone());
        value.insert("name".to_string(), self.name.clone());
        value.insert("server_name".to_string(), self.server_name.clone());
        value.insert("status".to_string(), self.status.clone());
        value.insert("stage".to_string(), self.stage.clone());
        value.insert("error_code".to_string(), self.error_code.clone());
        value.insert("retryable".to_string(), self.retryable.clone());
        value.insert("error".to_string(), self.error.clone());
        // `serialize_item` drops these four when they are `None`, so an ack
        // without them keeps the shorter object.
        for (name, value_field) in [
            ("generation", &self.generation),
            ("version", &self.version),
            ("checksum", &self.checksum),
            ("operation", &self.operation),
            ("source", &self.source),
        ] {
            if !value_field.is_null() {
                value.insert(name.to_string(), value_field.clone());
            }
        }
        Value::Object(value)
    }

    pub(super) fn status_text(&self) -> &str {
        self.status.as_str().unwrap_or_default()
    }

    pub(super) fn text(value: &Value) -> Option<String> {
        value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_i64().map(|id| id.to_string()))
            .filter(|text| !text.is_empty())
    }
}

/// `DeviceCapabilitySyncResult` after `sync_device_payload` maps the ack.
#[derive(Debug, Clone)]
pub struct SyncResult {
    pub scope: Value,
    /// `plugin_sync`: the acknowledged versioned snapshot metadata.
    pub plugin_sync: Option<Value>,
    /// `desired_plugin_snapshot` (`exclude=True`): the payload whose versioned
    /// acknowledgement this result records.
    pub desired_plugin_snapshot: Option<Value>,
    pub device_id: String,
    pub success: bool,
    /// `acknowledged` (`exclude=True`): a false value stops the desired-state
    /// retry loop without considering the snapshot stable.
    pub acknowledged: bool,
    pub error: Option<String>,
    pub skills: Vec<SyncItem>,
    pub plugins: Vec<SyncItem>,
    pub mcps: Vec<SyncItem>,
    pub errors: Vec<Value>,
}

impl SyncResult {
    /// `DeviceCapabilitySyncResult(...)` from the RPC acknowledgement.
    ///
    /// `false` acks keep `acknowledged=True` so `sync_latest_device_capabilities`
    /// reloads the desired snapshot, exactly like the source.
    #[must_use]
    pub fn from_ack(device_id: &str, ack: &Value) -> Self {
        if !ack.is_object() {
            return Self {
                scope: Value::Null,
                plugin_sync: None,
                desired_plugin_snapshot: None,
                device_id: device_id.to_string(),
                success: false,
                acknowledged: false,
                error: Some("Capability sync RPC returned invalid data".to_string()),
                skills: Vec::new(),
                plugins: Vec::new(),
                mcps: Vec::new(),
                errors: Vec::new(),
            };
        }
        let items = |field: &str| -> Vec<SyncItem> {
            ack.get(field)
                .and_then(Value::as_array)
                .map(|items| items.iter().map(SyncItem::from_value).collect())
                .unwrap_or_default()
        };
        let errors = ack
            .get("errors")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut result = Self {
            scope: ack.get("scope").cloned().unwrap_or(Value::Null),
            plugin_sync: ack.get("plugin_sync").cloned(),
            desired_plugin_snapshot: None,
            device_id: device_id.to_string(),
            success: ack.get("success") != Some(&Value::Bool(false)),
            acknowledged: true,
            error: None,
            skills: items("skills"),
            plugins: items("plugins"),
            mcps: items("mcps"),
            errors,
        };
        if ack.get("success") == Some(&Value::Bool(false)) {
            // Source's rejection branch builds a fresh result with
            // `scope=response.get("scope")` (`capability_sync_service.py:642`),
            // so a rejected acknowledgement keeps the device's scope exactly
            // like an accepted one. Only `error` differs.
            result.error = Some(
                ack.get("error")
                    .and_then(Value::as_str)
                    .filter(|error| !error.is_empty())
                    .map(str::to_string)
                    .or_else(|| raw_item_failure_message(ack))
                    .unwrap_or_else(|| "device rejected sync".to_string()),
            );
        }
        result
    }

    /// A dispatch failure (`sync_device_payload`'s error branches) or the
    /// exhausted retry loop. The loop's result keeps the last acknowledgement's
    /// scope, items and versioned snapshot, exactly like the source.
    #[must_use]
    pub fn failure(device_id: &str, last: Option<Self>, error: &str) -> Self {
        match last {
            Some(mut last) => {
                last.success = false;
                last.acknowledged = true;
                last.error = Some(error.to_string());
                last
            }
            None => Self {
                scope: Value::Null,
                plugin_sync: None,
                desired_plugin_snapshot: None,
                device_id: device_id.to_string(),
                success: false,
                acknowledged: false,
                error: Some(error.to_string()),
                skills: Vec::new(),
                plugins: Vec::new(),
                mcps: Vec::new(),
                errors: Vec::new(),
            },
        }
    }

    /// `DeviceCapabilitySyncResult` serialization (the `results[0]` body).
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut value = Map::new();
        value.insert("scope".to_string(), self.scope.clone());
        if let Some(plugin_sync) = &self.plugin_sync {
            value.insert("plugin_sync".to_string(), plugin_sync.clone());
        }
        value.insert(
            "device_id".to_string(),
            Value::String(self.device_id.clone()),
        );
        value.insert("success".to_string(), Value::Bool(self.success));
        value.insert(
            "error".to_string(),
            self.error.clone().map_or(Value::Null, Value::String),
        );
        value.insert(
            "skills".to_string(),
            Value::Array(self.skills.iter().map(SyncItem::to_value).collect()),
        );
        value.insert(
            "plugins".to_string(),
            Value::Array(self.plugins.iter().map(SyncItem::to_value).collect()),
        );
        value.insert(
            "mcps".to_string(),
            Value::Array(self.mcps.iter().map(SyncItem::to_value).collect()),
        );
        value.insert("errors".to_string(), Value::Array(self.errors.clone()));
        Value::Object(value)
    }

    /// `DeviceCapabilitySyncResponse` for the single-device round trip.
    #[must_use]
    pub fn response(&self, mode: &str) -> Value {
        let mut errors = self.errors.clone();
        if let Some(error) = &self.error {
            let mut entry = Map::new();
            entry.insert(
                "device_id".to_string(),
                Value::String(self.device_id.clone()),
            );
            entry.insert("error".to_string(), Value::String(error.clone()));
            errors.push(Value::Object(entry));
        }
        let synced = i64::from(self.success);
        let mut value = Map::new();
        value.insert("success".to_string(), Value::Bool(self.success));
        value.insert(
            "device_id".to_string(),
            Value::String(self.device_id.clone()),
        );
        value.insert("mode".to_string(), Value::String(mode.to_string()));
        value.insert(
            "skills".to_string(),
            Value::Array(self.skills.iter().map(SyncItem::to_value).collect()),
        );
        value.insert(
            "plugins".to_string(),
            Value::Array(self.plugins.iter().map(SyncItem::to_value).collect()),
        );
        value.insert(
            "mcps".to_string(),
            Value::Array(self.mcps.iter().map(SyncItem::to_value).collect()),
        );
        value.insert("errors".to_string(), Value::Array(errors));
        value.insert("synced".to_string(), Value::from(synced));
        value.insert("failed".to_string(), Value::from(1 - synced));
        value.insert("skipped".to_string(), Value::from(0));
        value.insert("results".to_string(), Value::Array(vec![self.to_value()]));
        Value::Object(value)
    }
}
