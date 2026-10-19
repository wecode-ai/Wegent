// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused compatibility tests for the conversion completion callback.

use serde_json::{Value, json};

use super::*;

fn valid_body() -> Value {
    json!({
        "document_id": 43384,
        "generation": 1,
        "converted_name": "report.pdf.md",
        "converted_extension": "md",
        "file_size": 7537,
        "markdown_bytes": "IyBoZWFkaW5nCg==",
        "index_dispatch_payload": {
            "knowledge_base_id": "1884840",
            "attachment_id": 1392099,
            "document_id": 43384,
            "index_generation": 1
        }
    })
}

/// The checked-in route table selects exactly this method and path, and the
/// handler macro registers the same route for `Application`.
#[test]
fn registered_route_keeps_python_ownership() {
    const PATH: &str = "/api/internal/conversion/callback/completed";
    // `method_bit`: POST.
    const POST: u16 = 1 << 5;
    let registered =
        brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
            .into_iter()
            .flat_map(|entry| (entry.0.routes)())
            .any(|route| route.path == PATH && route.methods & POST != 0);
    assert!(registered, "POST {PATH} must be registered by the router");

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
    let config = crate::hybrid::load_routes_config(&path).expect("the route file loads");
    let table = crate::RouteTable::compile(config).expect("the route table compiles");
    assert!(!table.matches(&http::Method::POST, PATH));
    assert!(!table.matches(&http::Method::GET, PATH));
}

#[test]
fn completed_response_uses_the_pydantic_field_order_and_values() {
    let completed = ConversionCompletedResponse::completed("task-id".to_string());
    assert_eq!(
        serde_json::to_value(&completed).unwrap(),
        json!({
            "ok": true,
            "index_task_id": "task-id",
            "skipped": false,
            "skip_reason": null
        })
    );

    let stale = ConversionCompletedResponse::stale();
    assert_eq!(
        serde_json::to_value(&stale).unwrap(),
        json!({
            "ok": true,
            "index_task_id": null,
            "skipped": true,
            "skip_reason": "stale_conversion"
        })
    );
}

#[test]
fn request_decoding_accepts_the_complete_body() {
    let request = decode_request(&valid_body()).unwrap();
    assert_eq!(request.document_id, 43384);
    assert_eq!(request.generation, 1);
    assert_eq!(request.converted_name, "report.pdf.md");
    assert_eq!(request.markdown_bytes, "IyBoZWFkaW5nCg==");
    assert_eq!(
        request.index_dispatch_payload.get("attachment_id"),
        Some(&Value::from(1392099))
    );
}

#[test]
fn request_decoding_rejects_missing_and_mistyped_fields() {
    let mut body = valid_body();
    body.as_object_mut().unwrap().remove("markdown_bytes");
    assert_eq!(
        decode_request(&body).unwrap_err().status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let body = json!({
        "document_id": "not-an-integer",
        "generation": 1,
        "converted_name": "report.pdf.md",
        "converted_extension": "md",
        "file_size": 7537,
        "markdown_bytes": "eA==",
        "index_dispatch_payload": {}
    });
    assert_eq!(
        decode_request(&body).unwrap_err().status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let mut body = valid_body();
    body.as_object_mut()
        .unwrap()
        .insert("index_dispatch_payload".to_string(), json!([1, 2]));
    assert_eq!(
        decode_request(&body).unwrap_err().status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    // A non-object body is the model-level 422.
    assert_eq!(
        decode_request(&json!("text")).unwrap_err().status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[test]
fn markdown_bytes_are_base64_validated() {
    assert_eq!(decode_markdown("IyBoZWFkaW5nCg==").unwrap(), b"# heading\n");
    let error = decode_markdown("not valid base64!").unwrap_err();
    assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        error.detail_message(),
        Some("Invalid base64 payload for markdown_bytes")
    );
}

#[test]
fn payload_binding_mirrors_the_source_comparisons() {
    let payload = valid_body()["index_dispatch_payload"]
        .as_object()
        .unwrap()
        .clone();

    // Matching document id and string KB id.
    assert!(payload_matches_document(&payload, 43384));
    assert!(payload_matches_knowledge_base(&payload, 1884840));

    // A missing or null optional value skips the check.
    let mut absent = payload.clone();
    absent.remove("document_id");
    absent.remove("knowledge_base_id");
    assert!(payload_matches_document(&absent, 1));
    assert!(payload_matches_knowledge_base(&absent, 1));

    let mut null = payload.clone();
    null.insert("document_id".to_string(), Value::Null);
    null.insert("knowledge_base_id".to_string(), Value::Null);
    assert!(payload_matches_document(&null, 1));
    assert!(payload_matches_knowledge_base(&null, 1));

    // A different or non-integer document id fails; a rendered KB mismatch
    // fails (the source compares `str(kind_id)` against `str(value)`).
    assert!(!payload_matches_document(&payload, 1));
    assert!(!payload_matches_knowledge_base(&payload, 1));
    let mut string_id = payload.clone();
    string_id.insert("document_id".to_string(), Value::from("43384"));
    assert!(!payload_matches_document(&string_id, 43384));
    let mut float_id = payload.clone();
    float_id.insert("document_id".to_string(), json!(43384.0));
    assert!(payload_matches_document(&float_id, 43384));
}

#[test]
fn dispatch_payload_replaces_the_attachment_id_in_place() {
    // `payload["attachment_id"] = converted_context.id` keeps the key order of
    // `kw.py` and the published `kwargsrepr`.
    let payload = valid_body()["index_dispatch_payload"]
        .as_object()
        .unwrap()
        .clone();
    let dispatch = payload_with_attachment(payload, 1392107);
    assert_eq!(dispatch.get("attachment_id"), Some(&Value::from(1392107)));
    assert_eq!(
        dispatch.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "knowledge_base_id",
            "attachment_id",
            "document_id",
            "index_generation"
        ]
    );
}

#[test]
fn source_config_rewrites_only_the_converted_reference() {
    let existing = json!({"processing_error": {"code": "x"}, "other": 1})
        .as_object()
        .unwrap()
        .clone();
    let updated = build_source_config(Some(existing.clone()), Some(1392107));
    assert_eq!(
        Value::Object(updated),
        json!({
            "processing_error": {"code": "x"},
            "other": 1,
            "converted_attachment_id": 1392107
        })
    );

    // Restoring `None` removes the reference and keeps every other key.
    let restored = build_source_config(Some(existing), None);
    assert_eq!(
        Value::Object(restored),
        json!({"processing_error": {"code": "x"}, "other": 1})
    );

    // A document with no `source_config` starts from an empty object.
    let fresh = build_source_config(None, Some(5));
    assert_eq!(Value::Object(fresh), json!({"converted_attachment_id": 5}));
}
