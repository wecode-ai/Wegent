// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for `GET /api/v1/loop-items/{item_id}/deliveries`.
use super::*;
use crate::sql_test_support::KindQueryCapture;
use chrono::NaiveDateTime;
use serde_json::json;

fn datetime(value: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").expect("valid datetime")
}

fn delivery_row(metadata: Option<serde_json::Value>) -> DeliveryRow {
    DeliveryRow {
        id: "d1".to_string(),
        loop_item_id: Some("i1".to_string()),
        created_by_user_id: Some(7),
        source_task_binding_id: Some("42".to_string()),
        source_task_snapshot: Some(Json(json!({"k": 1}))),
        status: Some("delivered".to_string()),
        created_at: Some(datetime("2026-10-10 06:00:31")),
        delivered_at: Some(datetime("2026-10-10 06:00:32")),
        metadata: metadata.map(|value| Json(JsonProjection::from(value))),
    }
}

/// The item lookup issues the source's `loop_items` task read with a bound
/// text id and an implicit `LIMIT 1`.
#[tokio::test]
async fn access_item_query_matches_source() {
    let mysql = KindQueryCapture::default();
    let item = find_access_item(&mysql, "V0F5773-20").await.unwrap();
    assert!(item.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(queries[0].sql.contains(
        "FROM loop_items WHERE loop_items.id = ? AND loop_items.resource_type IN ('task') LIMIT 1"
    ));
    assert_eq!(queries[0].args, 1);
    // The item id binds as text, not an integer.
    assert_eq!(queries[0].first_integer, None);
}

/// The deliveries read filters on the item, the delivered status, and the
/// `delivery` discriminator, ordering newest first.
#[tokio::test]
async fn deliveries_query_matches_source() {
    let mysql = KindQueryCapture::default();
    let rows = list_deliveries(&mysql, "V0F5773-20").await.unwrap();
    assert!(rows.is_empty());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(queries[0].sql.contains(
        "FROM loop_items WHERE loop_items.loop_item_id = ? AND loop_items.status = 'delivered' \
         AND loop_items.resource_type IN ('delivery') ORDER BY loop_items.delivered_at DESC"
    ));
}

/// The asset read filters on the owning delivery and the `delivery_asset`
/// discriminator, ordering by `relative_path`.
#[tokio::test]
async fn assets_query_matches_source() {
    let mysql = KindQueryCapture::default();
    let rows = list_assets(&mysql, "d1").await.unwrap();
    assert!(rows.is_empty());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(queries[0].sql.contains(
        "FROM loop_items WHERE loop_items.delivery_id = ? \
         AND loop_items.resource_type IN ('delivery_asset') ORDER BY loop_items.relative_path"
    ));
}

/// A missing loop item maps to the source's 404 "TODO not found".
#[tokio::test]
async fn require_loop_item_access_missing_item_is_todo_not_found() {
    let mysql = KindQueryCapture::default();
    let error = require_loop_item_access(&mysql, "absent", 7)
        .await
        .unwrap_err();
    assert_eq!(error.detail_message(), Some("TODO not found"));
}

/// `source_task_binding_id`: empty becomes `None`, numeric text becomes its
/// integer value.
#[test]
fn binding_id_normalization() {
    assert_eq!(normalize_binding_id(None), None);
    assert_eq!(normalize_binding_id(Some("")), None);
    assert_eq!(normalize_binding_id(Some("42")), Some(42));
}

/// `source_task_snapshot`: an absent/NULL column and an empty object both
/// become `None`; a populated object is retained.
#[test]
fn snapshot_normalization() {
    assert_eq!(
        normalize_snapshot(&delivery_row(None)),
        Some(json!({"k": 1}))
    );
    let empty = DeliveryRow {
        source_task_snapshot: None,
        ..delivery_row(None)
    };
    assert_eq!(normalize_snapshot(&empty), None);
    let empty_object = DeliveryRow {
        source_task_snapshot: Some(Json(json!({}))),
        ..delivery_row(None)
    };
    assert_eq!(normalize_snapshot(&empty_object), None);
}

/// `fulfillment_values` keeps only the metadata entries that are objects.
#[test]
fn fulfillment_values_filters_non_objects() {
    let row = delivery_row(Some(json!({
        "fulfillments": [{"requirement_id": "r1", "kind": "url"}, "skip", 3]
    })));
    assert_eq!(
        fulfillment_values(&row),
        vec![json!({"requirement_id": "r1", "kind": "url"})]
    );

    assert!(fulfillment_values(&delivery_row(None)).is_empty());
    assert!(fulfillment_values(&delivery_row(Some(json!({"fulfillments": "no"})))).is_empty());
}

/// `DeliveryAssetResponse.content_type`: the empty string becomes `None`.
#[test]
fn asset_response_normalizes_empty_content_type() {
    let row = DeliveryAssetRow {
        id: "a1".to_string(),
        kind: Some("file".to_string()),
        display_name: Some("report.txt".to_string()),
        relative_path: Some("reports/report.txt".to_string()),
        content_type: Some(String::new()),
        size_bytes: Some(12),
        sha256: Some("abc".to_string()),
    };
    let response = asset_response(&row);
    assert_eq!(response.content_type, None);
    assert_eq!(response.size_bytes, 12);
    assert_eq!(response.relative_path, "reports/report.txt");
}

/// Pydantic renders a naive datetime with microseconds only when nonzero.
#[test]
fn isoformat_omits_zero_microseconds() {
    assert_eq!(
        isoformat(datetime("2026-10-10 06:00:31")),
        "2026-10-10T06:00:31"
    );
    let with_micros =
        NaiveDateTime::parse_from_str("2026-10-10 06:00:31.918425", "%Y-%m-%d %H:%M:%S%.f")
            .expect("valid datetime");
    assert_eq!(isoformat(with_micros), "2026-10-10T06:00:31.918425");
}

/// The unset sentinel and NULL both render as `None`.
#[test]
fn isoformat_unset_normalizes_sentinel() {
    assert_eq!(isoformat_unset(None), None);
    assert_eq!(isoformat_unset(Some(datetime("1970-01-01 00:00:01"))), None);
    assert_eq!(
        isoformat_unset(Some(datetime("2026-10-10 06:00:32"))),
        Some("2026-10-10T06:00:32".to_string())
    );
}
