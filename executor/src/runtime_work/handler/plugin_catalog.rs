// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;
use std::io::{self, Write};

use serde_json::Value;

use super::log_executor_event;

const SUMMARY_FIELDS: &[&str] = &[
    "id",
    "name",
    "remotePluginId",
    "source",
    "version",
    "localVersion",
    "keywords",
    "installed",
    "enabled",
    "installedAt",
    "installPolicy",
    "installPolicySource",
    "authPolicy",
    "availability",
    "disabledReason",
    "eligiblePlanTypes",
    "mustShowInstallationInterstitial",
    "shareContext",
    "interface",
];
const INTERFACE_FIELDS: &[&str] = &[
    "displayName",
    "shortDescription",
    "developerName",
    "category",
    "capabilities",
    "logo",
    "logoDark",
    "logoUrl",
    "logoUrlDark",
    "composerIcon",
    "composerIconUrl",
    "brandColor",
    "defaultPrompt",
    "tags",
    "keywords",
    "categories",
];
const DETAIL_FIELDS: &[&str] = &[
    "longDescription",
    "screenshots",
    "screenshotUrls",
    "websiteUrl",
    "privacyPolicyUrl",
    "termsOfServiceUrl",
];

/// Project lists before IPC serialization; selected-plugin detail reads stay complete.
pub(super) fn summarize_plugin_catalog(mut response: Value) -> Value {
    let raw_bytes = json_bytes(&response);
    let (plugin_count, field_bytes) = measure_fields(&response);
    if let Some(marketplaces) = response
        .get_mut("marketplaces")
        .and_then(Value::as_array_mut)
    {
        for marketplace in marketplaces {
            if let Some(plugins) = marketplace.get_mut("plugins").and_then(Value::as_array_mut) {
                for plugin in plugins {
                    summarize_plugin(plugin);
                }
            }
        }
    }
    log_executor_event(
        "codex plugin catalog response sizes",
        &[
            ("raw_bytes", raw_bytes.to_string()),
            ("summary_bytes", json_bytes(&response).to_string()),
            ("plugin_count", plugin_count.to_string()),
            (
                "field_bytes",
                serde_json::to_string(&field_bytes).unwrap_or_default(),
            ),
        ],
    );
    response
}

fn summarize_plugin(plugin: &mut Value) {
    let Some(summary) = plugin.as_object_mut() else {
        return;
    };
    summary.retain(|key, _| SUMMARY_FIELDS.contains(&key.as_str()));
    let Some(interface) = summary.get_mut("interface").and_then(Value::as_object_mut) else {
        return;
    };
    if interface
        .get("shortDescription")
        .and_then(Value::as_str)
        .map_or(true, |text| text.trim().is_empty())
    {
        if let Some(description) = interface.get("longDescription").and_then(Value::as_str) {
            interface.insert(
                "shortDescription".to_owned(),
                Value::String(description.chars().take(240).collect()),
            );
        }
    }
    interface.retain(|key, _| INTERFACE_FIELDS.contains(&key.as_str()));
    // URLs remain lazy image requests; oversized inlined images belong to plugin/read.
    for key in [
        "logo",
        "logoDark",
        "logoUrl",
        "logoUrlDark",
        "composerIcon",
        "composerIconUrl",
    ] {
        if interface
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|asset| asset.starts_with("data:") && asset.len() > 4096)
        {
            interface.insert(key.to_owned(), Value::Null);
        }
    }
}

fn measure_fields(response: &Value) -> (usize, BTreeMap<String, usize>) {
    let mut sizes = BTreeMap::new();
    let mut count = 0;
    for marketplace in response["marketplaces"].as_array().into_iter().flatten() {
        for plugin in marketplace["plugins"].as_array().into_iter().flatten() {
            count += 1;
            for (key, value) in plugin.as_object().into_iter().flatten() {
                let bucket = if SUMMARY_FIELDS.contains(&key.as_str()) {
                    key.as_str()
                } else {
                    "other"
                };
                *sizes.entry(format!("plugin.{bucket}")).or_default() += json_bytes(value);
            }
            for (key, value) in plugin["interface"].as_object().into_iter().flatten() {
                let bucket = if INTERFACE_FIELDS.contains(&key.as_str())
                    || DETAIL_FIELDS.contains(&key.as_str())
                {
                    key.as_str()
                } else {
                    "other"
                };
                *sizes.entry(format!("interface.{bucket}")).or_default() += json_bytes(value);
            }
        }
    }
    (count, sizes)
}

#[derive(Default)]
struct ByteCount(usize);
impl Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn json_bytes(value: &Value) -> usize {
    let mut count = ByteCount::default();
    let _ = serde_json::to_writer(&mut count, value);
    count.0
}

#[cfg(test)]
#[path = "plugin_catalog_tests.rs"]
mod tests;
