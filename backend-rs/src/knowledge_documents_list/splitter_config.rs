// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The stored `splitter_config` payload and its response normalization
//! (`shared.models.splitter_config`).
use serde_json::json;

/// The stored `splitter_config` payload: either the normalized shape
/// (`chunk_strategy` + strategy-specific config) or one of the legacy
/// `type`-tagged shapes (`shared.models.splitter_config`).
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
pub enum StoredSplitterConfig {
    Normalized {
        chunk_strategy: String,
        #[serde(default)]
        format_enhancement: Option<String>,
        #[serde(default)]
        flat_config: Option<FlatChunkConfig>,
        #[serde(default)]
        hierarchical_config: Option<HierarchicalChunkConfig>,
        #[serde(default)]
        semantic_config: Option<SemanticSplitterConfig>,
        #[serde(default)]
        markdown_enhancement: Option<MarkdownEnhancementConfig>,
        #[serde(default)]
        legacy_type: Option<String>,
    },
    Legacy {
        #[serde(rename = "type")]
        splitter_type: String,
        #[serde(default)]
        chunk_size: Option<i64>,
        #[serde(default)]
        chunk_overlap: Option<i64>,
        #[serde(default)]
        separator: Option<String>,
        #[serde(default)]
        buffer_size: Option<i64>,
        #[serde(default)]
        breakpoint_percentile_threshold: Option<i64>,
    },
}

/// `FlatChunkConfig`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub(super) struct FlatChunkConfig {
    chunk_size: i64,
    chunk_overlap: i64,
    separator: String,
}

/// `HierarchicalChunkConfig`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub(super) struct HierarchicalChunkConfig {
    parent_chunk_size: i64,
    child_chunk_size: i64,
    child_chunk_overlap: i64,
    parent_separator: String,
    child_separator: String,
}

/// `SemanticSplitterConfig`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub(super) struct SemanticSplitterConfig {
    buffer_size: i64,
    breakpoint_percentile_threshold: i64,
}

/// `MarkdownEnhancementConfig`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub(super) struct MarkdownEnhancementConfig {
    enabled: bool,
}

/// `normalize_splitter_config` (`shared.models.splitter_config`): convert
/// legacy and normalized payloads to the one stable response shape. The
/// result is built with `json!` so the field order matches the pydantic
/// model's serialization order.
pub fn normalize_splitter_config(raw: &StoredSplitterConfig) -> impl serde::Serialize {
    match raw {
        StoredSplitterConfig::Legacy { splitter_type, .. } if splitter_type == "smart" => {
            let StoredSplitterConfig::Legacy {
                chunk_size,
                chunk_overlap,
                separator,
                ..
            } = raw
            else {
                unreachable!()
            };
            json!({
                "chunk_strategy": "flat",
                "format_enhancement": "file_aware",
                "flat_config": {
                    "chunk_size": chunk_size.unwrap_or(1024),
                    "chunk_overlap": chunk_overlap.unwrap_or(50),
                    "separator": separator.clone().unwrap_or_else(|| "\n\n".to_owned()),
                },
                "hierarchical_config": null,
                "semantic_config": null,
                "markdown_enhancement": {"enabled": true},
                "legacy_type": "smart",
            })
        }
        StoredSplitterConfig::Legacy { splitter_type, .. } if splitter_type == "sentence" => {
            let StoredSplitterConfig::Legacy {
                chunk_size,
                chunk_overlap,
                separator,
                ..
            } = raw
            else {
                unreachable!()
            };
            json!({
                "chunk_strategy": "flat",
                "format_enhancement": "none",
                "flat_config": {
                    "chunk_size": chunk_size.unwrap_or(1024),
                    "chunk_overlap": chunk_overlap.unwrap_or(200),
                    "separator": separator.clone().unwrap_or_else(|| "\n\n".to_owned()),
                },
                "hierarchical_config": null,
                "semantic_config": null,
                "markdown_enhancement": {"enabled": false},
                "legacy_type": "sentence",
            })
        }
        StoredSplitterConfig::Legacy { splitter_type, .. } if splitter_type == "semantic" => {
            let StoredSplitterConfig::Legacy {
                buffer_size,
                breakpoint_percentile_threshold,
                ..
            } = raw
            else {
                unreachable!()
            };
            json!({
                "chunk_strategy": "semantic",
                "format_enhancement": "none",
                "flat_config": null,
                "hierarchical_config": null,
                "semantic_config": {
                    "buffer_size": buffer_size.unwrap_or(1),
                    "breakpoint_percentile_threshold":
                        breakpoint_percentile_threshold.unwrap_or(95),
                },
                "markdown_enhancement": {"enabled": false},
                "legacy_type": "semantic",
            })
        }
        StoredSplitterConfig::Legacy { .. } => json!({
            "chunk_strategy": "flat",
            "format_enhancement": "none",
            "flat_config": {
                "chunk_size": 1024,
                "chunk_overlap": 200,
                "separator": "\n\n",
            },
            "hierarchical_config": null,
            "semantic_config": null,
            "markdown_enhancement": {"enabled": false},
            "legacy_type": null,
        }),
        StoredSplitterConfig::Normalized {
            chunk_strategy,
            format_enhancement,
            flat_config,
            hierarchical_config,
            semantic_config,
            markdown_enhancement,
            legacy_type,
        } => {
            // The strategy validator fills the matching config block with
            // its defaults and clears the others.
            let (flat, hierarchical, semantic) = match chunk_strategy.as_str() {
                "flat" => (
                    json!(flat_config.clone().unwrap_or(FlatChunkConfig {
                        chunk_size: 1024,
                        chunk_overlap: 200,
                        separator: "\n\n".to_owned(),
                    })),
                    json!(null),
                    json!(null),
                ),
                "hierarchical" => (
                    json!(null),
                    json!(
                        hierarchical_config
                            .clone()
                            .unwrap_or(HierarchicalChunkConfig {
                                parent_chunk_size: 2048,
                                child_chunk_size: 512,
                                child_chunk_overlap: 64,
                                parent_separator: "\n\n".to_owned(),
                                child_separator: "\n".to_owned(),
                            })
                    ),
                    json!(null),
                ),
                "semantic" => (
                    json!(null),
                    json!(null),
                    json!(semantic_config.clone().unwrap_or(SemanticSplitterConfig {
                        buffer_size: 1,
                        breakpoint_percentile_threshold: 95,
                    })),
                ),
                _ => (
                    json!(flat_config),
                    json!(hierarchical_config),
                    json!(semantic_config),
                ),
            };
            json!({
                "chunk_strategy": chunk_strategy,
                "format_enhancement": format_enhancement.clone()
                    .unwrap_or_else(|| "none".to_owned()),
                "flat_config": flat,
                "hierarchical_config": hierarchical,
                "semantic_config": semantic,
                "markdown_enhancement": markdown_enhancement.clone()
                    .unwrap_or(MarkdownEnhancementConfig { enabled: false }),
                "legacy_type": legacy_type,
            })
        }
    }
}
