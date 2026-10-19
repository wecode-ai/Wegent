// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn doc_row(
    splitter: StoredSplitterConfig,
    source_config: StoredSourceConfig,
    index_status: &str,
    generation: i64,
) -> DocumentListRow {
    DocumentListRow {
        knowledge_documents_id: 1,
        knowledge_documents_kind_id: 2,
        knowledge_documents_attachment_id: 3,
        knowledge_documents_name: "n".to_string(),
        knowledge_documents_file_extension: "json".to_string(),
        knowledge_documents_file_size: 10,
        knowledge_documents_status: "enabled".to_string(),
        knowledge_documents_user_id: 8,
        knowledge_documents_is_active: 1,
        knowledge_documents_index_status: index_status.to_string(),
        knowledge_documents_index_generation: generation,
        knowledge_documents_splitter_config: Some(brz_mysql::Json(splitter)),
        knowledge_documents_source_type: "file".to_string(),
        knowledge_documents_source_config: Some(brz_mysql::Json(source_config)),
        knowledge_documents_origin: "user".to_string(),
        knowledge_documents_folder_id: 0,
        knowledge_documents_summary: None,
        knowledge_documents_chunks: None,
        knowledge_documents_created_at: Some(
            chrono::NaiveDateTime::parse_from_str("2026-09-02 09:41:03", "%Y-%m-%d %H:%M:%S")
                .unwrap(),
        ),
        knowledge_documents_updated_at: Some(
            chrono::NaiveDateTime::parse_from_str("2026-09-02 07:47:06", "%Y-%m-%d %H:%M:%S")
                .unwrap(),
        ),
    }
}

fn flat_splitter() -> StoredSplitterConfig {
    // The recorded DB column shape: key order differs from the response
    // model's, and only the fields the normalizer reads are present.
    serde_json::from_value(json!({
        "flat_config": {
            "separator": "\n\n",
            "chunk_size": 1024,
            "chunk_overlap": 50,
        },
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "markdown_enhancement": {"enabled": true},
    }))
    .expect("recorded splitter shape decodes")
}

#[test]
fn response_field_order_matches_schema() {
    let body = serde_json::to_string(&build_item(
        doc_row(flat_splitter(), StoredSourceConfig::default(), "success", 1),
        Some("zhaoliu".to_string()),
    ))
    .unwrap();
    assert!(body.starts_with(
        r#"{"id":1,"kind_id":2,"attachment_id":3,"name":"n","file_extension":"json""#
    ));
    assert!(body.contains(r#""created_by":"zhaoliu""#));
    assert!(body.contains(r#""created_at":"2026-09-02T09:41:03""#));
}

/// `serialize_updated_at`: the doc_row fixture's updated_at precedes its
/// created_at, so the +8h repair applies (07:47:06 -> 15:47:06).
#[test]
fn legacy_naive_utc_updated_at_is_repaired() {
    let item = serde_json::to_value(build_item(
        doc_row(flat_splitter(), StoredSourceConfig::default(), "success", 1),
        None,
    ))
    .unwrap();
    assert_eq!(item["created_at"], "2026-09-02T09:41:03");
    assert_eq!(item["updated_at"], "2026-09-02T15:47:06");
}

/// A non-legacy updated_at (at or after created_at) passes through as-is.
#[test]
fn updated_at_at_or_after_created_at_is_unchanged() {
    let mut row = doc_row(flat_splitter(), StoredSourceConfig::default(), "success", 1);
    row.knowledge_documents_updated_at = row.knowledge_documents_created_at;
    let item = serde_json::to_value(build_item(row, None)).unwrap();
    assert_eq!(item["updated_at"], "2026-09-02T09:41:03");

    // A gap larger than 8h cannot be repaired to a valid value and stays.
    let mut row = doc_row(flat_splitter(), StoredSourceConfig::default(), "success", 1);
    row.knowledge_documents_updated_at = Some(
        chrono::NaiveDateTime::parse_from_str("2026-09-01 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap(),
    );
    let item = serde_json::to_value(build_item(row, None)).unwrap();
    assert_eq!(item["updated_at"], "2026-09-01T00:00:00");
}

/// Exactly the +8h boundary: the repair must reach (not stay below)
/// created_at to apply.
#[test]
fn updated_at_repair_requires_reaching_created_at() {
    let mut row = doc_row(flat_splitter(), StoredSourceConfig::default(), "success", 1);
    // created 09:41:03; updated 01:41:03 + 8h = 09:41:03 (equal, repaired).
    row.knowledge_documents_updated_at = Some(
        chrono::NaiveDateTime::parse_from_str("2026-09-02 01:41:03", "%Y-%m-%d %H:%M:%S").unwrap(),
    );
    let item = serde_json::to_value(build_item(row, None)).unwrap();
    assert_eq!(item["updated_at"], "2026-09-02T09:41:03");

    // One second earlier the repair stays below created_at and is dropped.
    let mut row = doc_row(flat_splitter(), StoredSourceConfig::default(), "success", 1);
    row.knowledge_documents_updated_at = Some(
        chrono::NaiveDateTime::parse_from_str("2026-09-02 01:41:02", "%Y-%m-%d %H:%M:%S").unwrap(),
    );
    let item = serde_json::to_value(build_item(row, None)).unwrap();
    assert_eq!(item["updated_at"], "2026-09-02T01:41:02");
}

#[test]
fn normalized_splitter_config_uses_model_field_order() {
    let normalized = serde_json::to_value(normalize_splitter_config(&flat_splitter())).unwrap();
    let keys: Vec<&str> = normalized
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "chunk_strategy",
            "format_enhancement",
            "flat_config",
            "hierarchical_config",
            "semantic_config",
            "markdown_enhancement",
            "legacy_type",
        ]
    );
    assert!(normalized["hierarchical_config"].is_null());
    assert!(normalized["legacy_type"].is_null());
    assert_eq!(normalized["flat_config"]["chunk_overlap"], 50);
}

#[test]
fn legacy_smart_splitter_normalizes() {
    let raw: StoredSplitterConfig = serde_json::from_value(json!({
        "type": "smart",
        "chunk_size": 512,
        "chunk_overlap": 24,
    }))
    .expect("legacy smart decodes");
    let normalized = serde_json::to_value(normalize_splitter_config(&raw)).unwrap();
    assert_eq!(normalized["chunk_strategy"], "flat");
    assert_eq!(normalized["format_enhancement"], "file_aware");
    assert_eq!(normalized["legacy_type"], "smart");
    assert_eq!(normalized["flat_config"]["chunk_size"], 512);
    assert_eq!(normalized["markdown_enhancement"]["enabled"], true);
}

#[test]
fn processing_error_visibility_follows_generation() {
    let error = |generation: i64| StoredSourceConfig {
        processing_error: Some(ProcessingErrorPayload {
            stage: "indexing".to_string(),
            code: "index_lock_timeout".to_string(),
            message: "The document indexing task waited too long. Please retry.".to_string(),
            retryable: true,
            generation,
            occurred_at: "2026-09-09T04:47:57.035713+00:00".to_string(),
            provider: None,
            model: None,
            request_id: None,
        }),
    };
    // Matching generation on a failed document surfaces the error.
    let item = serde_json::to_value(build_item(
        doc_row(flat_splitter(), error(1), "failed", 1),
        None,
    ))
    .unwrap();
    assert!(!item["processing_error"].is_null());
    // The validated payload echoes with every field, pydantic field order,
    // and the UTC `occurred_at` normalized to `Z`.
    assert_eq!(
        item["processing_error"],
        json!({
            "stage": "indexing",
            "code": "index_lock_timeout",
            "message": "The document indexing task waited too long. Please retry.",
            "retryable": true,
            "generation": 1,
            "occurred_at": "2026-09-09T04:47:57.035713Z",
            "provider": null,
            "model": null,
            "request_id": null,
        })
    );
    // Stale generation drops the error.
    let stale = serde_json::to_value(build_item(
        doc_row(flat_splitter(), error(99), "failed", 1),
        None,
    ))
    .unwrap();
    assert!(stale["processing_error"].is_null());
    // Non-failed documents never surface an error.
    let ok = serde_json::to_value(build_item(
        doc_row(flat_splitter(), error(1), "success", 1),
        None,
    ))
    .unwrap();
    assert!(ok["processing_error"].is_null());
}

#[test]
fn processing_error_invalid_payloads_are_hidden() {
    // An unknown stage fails `DocumentProcessingError` validation.
    let mut config: StoredSourceConfig = serde_json::from_value(json!({"processing_error": {
        "stage": "unknown_stage",
        "code": "x",
        "message": "m",
        "retryable": false,
        "generation": 1,
        "occurred_at": "2026-09-09T04:47:57.035713+00:00",
    }}))
    .expect("decodes");
    let item = serde_json::to_value(build_item(
        doc_row(flat_splitter(), config.clone(), "failed", 1),
        None,
    ))
    .unwrap();
    assert!(item["processing_error"].is_null());
    // An unparseable `occurred_at` fails validation too.
    config.processing_error.as_mut().unwrap().stage = "indexing".to_string();
    config.processing_error.as_mut().unwrap().occurred_at = "not-a-timestamp".to_string();
    let item = serde_json::to_value(build_item(
        doc_row(flat_splitter(), config, "failed", 1),
        None,
    ))
    .unwrap();
    assert!(item["processing_error"].is_null());
}

#[test]
fn params_defaults_match_source() {
    let params =
        parse_params(210837, None, None, None, None, None, None, None, None).expect("valid");
    assert_eq!(params.knowledge_base_id, 210837);
    assert_eq!(params.sort_by, "createdAt");
    assert_eq!(params.sort_order, "desc");
    assert_eq!(params.limit, 50);
    assert_eq!(params.offset, 0);
    assert!(!params.include_subfolders);
    assert!(params.origin.is_none());
    assert!(
        parse_params(
            1,
            None,
            None,
            None,
            Some("bogus".to_string()),
            None,
            None,
            None,
            None
        )
        .is_err()
    );
    assert!(parse_params(1, None, None, None, None, None, None, Some("0"), None).is_err());
    assert!(parse_params(1, Some("-1"), None, None, None, None, None, None, None).is_err());
    assert!(
        parse_params(
            1,
            None,
            None,
            None,
            None,
            None,
            Some("bogus".to_string()),
            None,
            None
        )
        .is_err()
    );
    assert_eq!(
        parse_params(
            1,
            None,
            None,
            None,
            None,
            None,
            Some("generated".to_string()),
            None,
            None
        )
        .unwrap()
        .origin
        .as_deref(),
        Some("generated")
    );
}

#[test]
fn knowledge_base_id_sources_validate_like_fastapi() {
    // The path endpoint requires a parsable id (`loc: ["path", ...]`).
    assert_eq!(parse_knowledge_base_id_path("236829").unwrap(), 236829);
    let error = parse_knowledge_base_id_path("abc").unwrap_err();
    assert_eq!(
        error.validation_detail(),
        r#"[{"type":"int_parsing","loc":["path","knowledge_base_id"],"msg":"Input should be a valid integer, unable to parse string as an integer","input":"abc"}]"#
    );
    // The open endpoint requires the query parameter (`loc: ["query", ...]`).
    assert_eq!(
        parse_knowledge_base_id_query(Some("210837")).unwrap(),
        210837
    );
    assert!(parse_knowledge_base_id_query(None).is_err());
    assert!(parse_knowledge_base_id_query(Some("abc")).is_err());
}

#[test]
fn list_response_field_order_matches_schema() {
    let response = KnowledgeDocumentListResponse {
        total: 3,
        returned_count: 1,
        limit: 500,
        offset: 0,
        has_more: true,
        items: vec![build_item(
            doc_row(flat_splitter(), StoredSourceConfig::default(), "success", 1),
            Some("zhaoliu".to_string()),
        )],
    };
    let body = serde_json::to_string(&response).unwrap();
    assert!(body.starts_with(
        r#"{"total":3,"returned_count":1,"limit":500,"offset":0,"has_more":true,"items":[{"id":1"#
    ));
    // The doc_row fixture's updated_at is a legacy naive UTC value; the
    // serializer repair renders it +8h.
    assert!(body.ends_with(r#""updated_at":"2026-09-02T15:47:06"}]}"#));
}

#[test]
fn false_like_escape_matches_source() {
    assert_eq!(escape_sql_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
    assert_eq!(mysql_string_literal("a\\%b"), "'a\\\\%b'");
}

/// A recorded `splitter_config` of `{}` (392 of 430 rows in the offset-500
/// case) must decode and normalize to the flat default, not fail the row.
#[test]
fn empty_splitter_config_decodes_to_flat_default() {
    let stored: StoredSplitterConfig =
        serde_json::from_str("{}").expect("empty splitter config decodes");
    let value = serde_json::to_value(normalize_splitter_config(&stored)).unwrap();
    assert_eq!(
        value,
        json!({
            "chunk_strategy": "flat",
            "format_enhancement": "none",
            "flat_config": {"chunk_size": 1024, "chunk_overlap": 200, "separator": "\n\n"},
            "hierarchical_config": null,
            "semantic_config": null,
            "markdown_enhancement": {"enabled": false},
            "legacy_type": null,
        })
    );
}
