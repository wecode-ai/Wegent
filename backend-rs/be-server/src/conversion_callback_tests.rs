use super::*;

fn recorded_request() -> Value {
    json!({"action": "conversion_started", "document_id": 43388, "generation": 1})
}

#[test]
fn parses_the_recorded_request() {
    let request = parse_status_request(&recorded_request()).unwrap();
    assert_eq!(request.action, Action::Started);
    assert_eq!(request.document_id, 43388);
    assert_eq!(request.generation, 1);
    assert!(request.error_code.is_none());
    assert!(request.retryable.is_none());
}

#[test]
fn parses_the_failure_request_fields() {
    let request = parse_status_request(&json!({
        "action": "conversion_failed",
        "document_id": 7,
        "generation": 2,
        "error_code": "image_decode_failed",
        "user_message": "bad image",
        "retryable": true,
        "provider": "p",
        "model": "m",
        "request_id": "r",
    }))
    .unwrap();
    assert_eq!(request.action, Action::Failed);
    assert_eq!(request.error_code.as_deref(), Some("image_decode_failed"));
    assert_eq!(request.user_message.as_deref(), Some("bad image"));
    assert_eq!(request.retryable, Some(true));
}

#[test]
fn rejects_an_unknown_action_like_the_literal() {
    let error = parse_status_request(&json!({
        "action": "conversion_done",
        "document_id": 1,
        "generation": 0,
    }))
    .unwrap_err();
    assert_eq!(error_body(&error)["detail"][0]["type"], "literal_error");
    assert_eq!(error_body(&error)["detail"][0]["loc"][1], "action");
}

#[test]
fn rejects_a_missing_integer_field() {
    let error = parse_status_request(&json!({"action": "conversion_started", "generation": 0}))
        .unwrap_err();
    assert_eq!(error_body(&error)["detail"][0]["type"], "missing");
    assert_eq!(error_body(&error)["detail"][0]["loc"][1], "document_id");
}

fn error_body(error: &FastApiError) -> Value {
    let detail = serde_json::from_str::<Value>(&error.validation_detail())
        .expect("validation detail is JSON");
    match detail {
        // The array body is already the pydantic `detail` value.
        Value::Array(entries) => json!({"detail": entries}),
        Value::Object(object) => Value::Object(object),
        other => panic!("unexpected validation detail {other}"),
    }
}

#[test]
fn conversion_start_accepts_only_the_queued_pre_states() {
    assert!(decide_conversion_started(1, 1, "queued"));
    assert!(decide_conversion_started(1, 1, "pending_conversion"));
    assert!(!decide_conversion_started(1, 2, "queued"));
    assert!(!decide_conversion_started(1, 1, "converting"));
    assert!(!decide_conversion_started(1, 1, "not_indexed"));
}

#[test]
fn response_body_field_order_matches_the_schema() {
    let body = serde_json::to_string(&ConversionStatusResponse {
        ok: true,
        document_exists: true,
    })
    .unwrap();
    assert_eq!(body, r#"{"ok":true,"document_exists":true}"#);
}

#[test]
fn legacy_error_mapping_matches_the_source_branches() {
    let cases = [
        (None, "conversion_failed", true),
        (Some("quota exceeded"), "model_quota_exhausted", false),
        (Some("Permission_Denied"), "model_permission_denied", false),
        (Some("ReadTimeout"), "conversion_timeout", true),
        (
            Some("ReadError while fetching"),
            "conversion_service_unavailable",
            true,
        ),
    ];
    for (message, code, retryable) in cases {
        let error = map_legacy_conversion_error(message);
        assert_eq!(error.code, code, "{message:?}");
        assert_eq!(error.retryable, retryable, "{message:?}");
        assert_eq!(error.stage, "conversion");
    }
}

#[test]
fn structured_error_takes_precedence_and_falls_back_when_invalid() {
    let mut request = parse_status_request(&json!({
        "action": "conversion_failed",
        "document_id": 1,
        "generation": 3,
        "error_code": "image_decode_failed",
        "user_message": "bad image",
        "retryable": true,
    }))
    .unwrap();
    let error = build_conversion_callback_error(&request);
    assert_eq!(error.code, "image_decode_failed");
    assert_eq!(error.message, "bad image");
    assert!(error.retryable);

    // A >64-char code fails `DocumentProcessingError` validation and
    // falls back to the legacy message mapping.
    request.error_code = Some("x".repeat(65));
    request.error_message = Some("timeout".to_string());
    let error = build_conversion_callback_error(&request);
    assert_eq!(error.code, "conversion_timeout");
}

#[test]
fn processing_error_payload_uses_pydantic_field_order_and_json_datetime() {
    let error = ProcessingError {
        stage: "conversion",
        code: "c".to_string(),
        message: "m".to_string(),
        retryable: true,
        provider: None,
        model: Some("model".to_string()),
        request_id: None,
    };
    let payload = error.payload(2);
    let text = serde_json::to_string(&payload).unwrap();
    assert!(text.starts_with(
        r#"{"stage":"conversion","code":"c","message":"m","retryable":true,"generation":2,"occurred_at":"#
    ));
    assert!(text.ends_with(r#""provider":null,"model":"model","request_id":null}"#));
    let occurred_at = payload["occurred_at"].as_str().unwrap();
    assert!(occurred_at.ends_with('Z'), "{occurred_at}");
}

#[test]
fn failure_statement_writes_index_status_before_source_config() {
    let columns = FailureColumns {
        attachment_id: 5,
        file_extension: "pdf".to_string(),
        file_size: 10,
        status: "enabled".to_string(),
        is_active: 1,
        index_status: "failed".to_string(),
        source_config: Map::from_iter([("processing_error".to_string(), json!({"code": "x"}))]),
    };
    let flushed = FailureColumns {
        index_status: "converting".to_string(),
        source_config: Map::new(),
        ..columns.clone()
    };
    let (sql, params) = columns.statement(&flushed, 43388).unwrap();
    assert_eq!(
        sql,
        "UPDATE knowledge_documents SET index_status=?, source_config=?, updated_at=now() \
         WHERE knowledge_documents.id = ?"
    );
    assert_eq!(params.len(), 3);
}

#[test]
fn snapshot_restore_rewinds_the_document_and_returns_superseded_ids() {
    let mut columns = FailureColumns {
        attachment_id: 11,
        file_extension: "md".to_string(),
        file_size: 20,
        status: "disabled".to_string(),
        is_active: 0,
        index_status: "converting".to_string(),
        source_config: Map::from_iter([
            ("converted_attachment_id".to_string(), json!(12)),
            (
                "external".to_string(),
                json!({"sync": {"enabled": true, "content_version": "v2", "last_error_code": "old"}}),
            ),
            ("processing_error".to_string(), json!({"code": "new"})),
            (
                REFRESH_SNAPSHOT_KEY.to_string(),
                json!({
                    "generation": 4,
                    "previous_index_status": "success",
                    "previous_is_active": true,
                    "previous_document_status": "enabled",
                    "previous_attachment_id": 3,
                    "previous_converted_attachment_id": 4,
                    "previous_file_extension": "pdf",
                    "previous_file_size": 9,
                    "previous_processing_error": {"code": "old"},
                    "had_content_version": false,
                    "previous_content_version": "v1",
                    "had_source_update_time": false,
                    "previous_source_update_time": null,
                    "staged_attachment_id": 13,
                }),
            ),
        ]),
    };
    let cleanup = restore_external_refresh_snapshot(&mut columns, 4).unwrap();
    assert_eq!(cleanup.into_iter().collect::<Vec<_>>(), vec![11, 12, 13]);
    assert_eq!(columns.attachment_id, 3);
    assert_eq!(columns.file_extension, "pdf");
    assert_eq!(columns.file_size, 9);
    assert_eq!(columns.is_active, 1);
    assert_eq!(columns.index_status, "success");
    assert_eq!(columns.status, "enabled");
    assert!(!columns.source_config.contains_key(REFRESH_SNAPSHOT_KEY));
    assert_eq!(columns.source_config["converted_attachment_id"], json!(4));
    assert_eq!(
        columns.source_config["processing_error"],
        json!({"code": "old"})
    );
    assert_eq!(
        columns.source_config["external"],
        // `last_error_code` is preserved: the restore only rewrites
        // `content_version` on the existing sync sub-object.
        json!({"sync": {"enabled": true, "last_error_code": "old"}})
    );
}

#[test]
fn snapshot_restore_ignores_a_stale_generation() {
    let mut columns = FailureColumns {
        attachment_id: 1,
        file_extension: "pdf".to_string(),
        file_size: 1,
        status: "enabled".to_string(),
        is_active: 1,
        index_status: "converting".to_string(),
        source_config: Map::from_iter([(
            REFRESH_SNAPSHOT_KEY.to_string(),
            json!({"generation": 2}),
        )]),
    };
    assert!(restore_external_refresh_snapshot(&mut columns, 3).is_none());
    assert!(columns.source_config.contains_key(REFRESH_SNAPSHOT_KEY));
}

#[test]
fn document_status_falls_back_to_not_indexed() {
    assert_eq!(document_status(""), "not_indexed");
    assert_eq!(document_status("success"), "success");
}

#[test]
fn iso8601_matches_pydantic_rendering() {
    let value = DateTime::parse_from_rfc3339("2026-10-16T03:40:13.055129Z")
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(iso8601_z(value), "2026-10-16T03:40:13.055129Z");
    let value = DateTime::parse_from_rfc3339("2026-10-16T03:40:13Z")
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(iso8601_z(value), "2026-10-16T03:40:13Z");
}

#[tokio::test]
async fn missing_document_rolls_back_and_reports_not_found() {
    use crate::sql_test_support::KindQueryCapture;

    let mysql = KindQueryCapture::writing();
    let request = parse_status_request(&recorded_request()).unwrap();
    let response = conversion_status_value(&mysql, &request).await.unwrap();
    assert!(!response.ok);
    assert!(!response.document_exists);

    let queries = mysql.queries();
    assert!(
        queries[0]
            .sql
            .starts_with("SELECT knowledge_documents.id AS knowledge_documents_id")
    );
    assert!(queries[0].sql.ends_with("LIMIT 1 FOR UPDATE"));
    assert!(
        queries[1]
            .sql
            .starts_with("SELECT knowledge_document_external_sources.document_id")
    );
    assert!(queries[1].sql.ends_with("document_id IN (43388)"));
    let writes = mysql.writes();
    assert_eq!(writes[0].sql, "ROLLBACK");
    // The endpoint's own document reload, without the row lock.
    assert!(queries[2].sql.ends_with("LIMIT 1"));
    assert!(!queries[2].sql.contains("FOR UPDATE"));
    assert!(queries[3].sql.ends_with("document_id IN (43388)"));
}
