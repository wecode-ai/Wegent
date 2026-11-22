// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for `GET /api/tables` (`src/tables.rs`).

use super::*;

#[test]
fn quote_literal_escapes_like_sqlalchemy() {
    assert_eq!(quote_literal("default"), "'default'");
    assert_eq!(quote_literal("it's"), "'it\\'s'");
    assert_eq!(quote_literal("a\\b"), "'a\\\\b'");
}

#[test]
fn empty_list_response_matches_schema_defaults() {
    // `KnowledgeDocumentListResponse(total=0, items=[])`: returned_count
    // defaults to 0, limit to null, offset to 0, has_more to false.
    let response = json!({
        "total": 0,
        "returned_count": 0,
        "limit": json!(null),
        "offset": 0,
        "has_more": false,
        "items": [],
    });
    let body = serde_json::to_string(&response).unwrap();
    assert_eq!(
        body,
        r#"{"total":0,"returned_count":0,"limit":null,"offset":0,"has_more":false,"items":[]}"#
    );
}

#[test]
fn legacy_smart_splitter_normalizes() {
    let raw = StoredSplitterConfig::Legacy {
        splitter_type: "smart".to_owned(),
        chunk_size: Some(512),
        chunk_overlap: Some(30),
        separator: None,
        buffer_size: None,
        breakpoint_percentile_threshold: None,
    };
    let normalized = &normalize_splitter_config(&raw).0.0;
    assert_eq!(normalized.chunk_strategy, "flat");
    assert_eq!(normalized.format_enhancement, "file_aware");
    assert_eq!(normalized.flat_config.as_ref().unwrap().chunk_size, 512);
    assert_eq!(normalized.flat_config.as_ref().unwrap().chunk_overlap, 30);
    assert_eq!(normalized.flat_config.as_ref().unwrap().separator, "\n\n");
    assert!(normalized.markdown_enhancement.as_ref().unwrap().enabled);
    assert_eq!(normalized.legacy_type.as_deref(), Some("smart"));
    // Serialization matches the pydantic model's field order.
    let body = serde_json::to_string(&normalized).unwrap();
    let expected_prefix = r#"{"chunk_strategy":"flat","format_enhancement":"file_aware","#;
    assert!(body.starts_with(expected_prefix), "body: {body}");
}

#[test]
fn legacy_sentence_splitter_normalizes() {
    let raw = StoredSplitterConfig::Legacy {
        splitter_type: "sentence".to_owned(),
        chunk_size: None,
        chunk_overlap: None,
        separator: Some("\n".to_owned()),
        buffer_size: None,
        breakpoint_percentile_threshold: None,
    };
    let normalized = &normalize_splitter_config(&raw).0.0;
    assert_eq!(normalized.chunk_strategy, "flat");
    assert_eq!(normalized.format_enhancement, "none");
    assert_eq!(normalized.flat_config.as_ref().unwrap().chunk_size, 1024);
    assert_eq!(normalized.flat_config.as_ref().unwrap().chunk_overlap, 200);
    assert_eq!(normalized.flat_config.as_ref().unwrap().separator, "\n");
    assert!(!normalized.markdown_enhancement.as_ref().unwrap().enabled);
    assert_eq!(normalized.legacy_type.as_deref(), Some("sentence"));
}

#[test]
fn legacy_semantic_splitter_normalizes() {
    let raw = StoredSplitterConfig::Legacy {
        splitter_type: "semantic".to_owned(),
        chunk_size: None,
        chunk_overlap: None,
        separator: None,
        buffer_size: Some(3),
        breakpoint_percentile_threshold: None,
    };
    let normalized = &normalize_splitter_config(&raw).0.0;
    assert_eq!(normalized.chunk_strategy, "semantic");
    assert_eq!(normalized.format_enhancement, "none");
    assert_eq!(normalized.semantic_config.as_ref().unwrap().buffer_size, 3);
    assert_eq!(
        normalized
            .semantic_config
            .as_ref()
            .unwrap()
            .breakpoint_percentile_threshold,
        95
    );
    assert!(normalized.flat_config.is_none());
}

#[test]
fn normalized_flat_config_fills_defaults() {
    let raw = StoredSplitterConfig::Normalized {
        chunk_strategy: "flat".to_owned(),
        format_enhancement: None,
        flat_config: None,
        hierarchical_config: None,
        semantic_config: None,
        markdown_enhancement: None,
        legacy_type: None,
    };
    let normalized = &normalize_splitter_config(&raw).0.0;
    assert_eq!(normalized.format_enhancement, "none");
    assert_eq!(normalized.flat_config.as_ref().unwrap().chunk_size, 1024);
    assert_eq!(normalized.flat_config.as_ref().unwrap().chunk_overlap, 200);
    assert_eq!(normalized.flat_config.as_ref().unwrap().separator, "\n\n");
    assert!(normalized.hierarchical_config.is_none());
    assert!(normalized.semantic_config.is_none());
    assert!(!normalized.markdown_enhancement.as_ref().unwrap().enabled);
    assert!(normalized.legacy_type.is_none());
}

#[test]
fn splitter_payload_serializes_null_configs() {
    // The semantic normalization serializes the unused config blocks as
    // JSON null, matching `model_dump()`.
    let raw = StoredSplitterConfig::Legacy {
        splitter_type: "semantic".to_owned(),
        chunk_size: None,
        chunk_overlap: None,
        separator: None,
        buffer_size: None,
        breakpoint_percentile_threshold: None,
    };
    let payload = normalize_splitter_config(&raw);
    let body = serde_json::to_string(&payload).unwrap();
    assert!(body.contains(r#""flat_config":null"#), "body: {body}");
    assert!(
        body.contains(r#""hierarchical_config":null"#),
        "body: {body}"
    );
    assert!(body.contains(r#""legacy_type":"semantic""#), "body: {body}");
}

#[test]
fn document_item_serializes_schema_defaults() {
    // The pydantic response model serializes null defaults for created_by,
    // external_provider/external_resource_id, doc_ref, and processing_error
    // (a non-failed document); the body order matches the model.
    let item = DocumentItem {
        id: 1,
        kind_id: 2,
        attachment_id: 0,
        name: "tbl".to_owned(),
        file_extension: "axls".to_owned(),
        file_size: 0,
        status: "disabled".to_owned(),
        user_id: 2067,
        created_by: None,
        is_active: false,
        index_status: "not_indexed".to_owned(),
        index_generation: 0,
        processing_error: None,
        splitter_config: None,
        source_type: "table".to_owned(),
        source_config: SourceConfigEcho::default(),
        external_provider: None,
        external_resource_id: None,
        origin: "user".to_owned(),
        folder_id: 0,
        doc_ref: None,
        created_at: "2026-09-08T12:00:00".to_owned(),
        updated_at: "2026-09-08T12:00:00".to_owned(),
    };
    let body = serde_json::to_string(&item).unwrap();
    let expected = r#"{"id":1,"kind_id":2,"attachment_id":0,"name":"tbl","#;
    assert!(body.starts_with(expected), "body: {body}");
    assert!(body.contains(r#""created_by":null"#), "body: {body}");
    assert!(body.contains(r#""processing_error":null"#), "body: {body}");
    assert!(body.contains(r#""source_config":{}"#), "body: {body}");
    assert!(body.contains(r#""external_provider":null"#), "body: {body}");
    assert!(body.contains(r#""doc_ref":null"#), "body: {body}");
    assert!(body.contains(r#""source_type":"table""#), "body: {body}");
}
