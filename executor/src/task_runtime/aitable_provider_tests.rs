use super::*;

#[test]
fn reads_dws_result_arrays_and_normalizes_records() {
    let response = json!({
        "success": true,
        "result": [{"recordId": "rec-1", "cells": {"fld": "value"}}]
    });
    let records = list_from(&response, &["records", "items", "data"]);
    assert_eq!(records.len(), 1);
    assert_eq!(normalize_record(&records[0])["id"], json!("rec-1"));
    assert_eq!(
        normalize_record(&records[0])["cells"]["fld"],
        json!("value")
    );
}

#[test]
fn translates_dingtalk_view_configuration_into_record_query_arguments() {
    let view = json!({
        "columns": ["fld_title", "fld_owner"],
        "filter": {
            "operator": "and",
            "operands": [{"operator": "eq", "operands": ["fld_owner", "user-1"]}]
        },
        "sort": [{"fieldId": "fld_title", "direction": "asc"}]
    });

    let config = view_query_config(Some(&view)).unwrap();

    assert_eq!(config.field_ids.as_deref(), Some("fld_title,fld_owner"));
    assert_eq!(
        config.filters.as_deref(),
        Some(
            r#"{"operands":[{"operands":["fld_owner","user-1"],"operator":"eq"}],"operator":"and"}"#
        )
    );
    assert_eq!(
        config.sort.as_deref(),
        Some(r#"[{"direction":"asc","fieldId":"fld_title"}]"#)
    );
}

#[test]
fn accepts_dws_success_envelopes_with_empty_error_objects() {
    assert!(!dws_response_failed(&json!({
        "success": true, "status": "success", "error": {}, "data": {"records": []}
    })));
    assert!(dws_response_failed(&json!({
        "success": false, "status": "error", "error": {"message": "permission denied"}
    })));
}

#[test]
fn normalizes_created_record_ids_from_dws_envelope() {
    let record = normalize_write_record(
        json!({"data": {"newRecordIds": ["rec-new"]}}),
        None,
        r#"[{"cells":{"fld":"value"}}]"#,
    );
    assert_eq!(record["id"], json!("rec-new"));
    assert_eq!(record["cells"]["fld"], json!("value"));
}

#[test]
fn maps_localized_board_options() {
    assert_eq!(map_option("进行中", STATUS_OPTIONS, "inbox"), "in_progress");
    assert_eq!(map_option("紧急", PRIORITY_OPTIONS, "none"), "urgent");
}

#[test]
fn infers_board_fields_from_dingtalk_schema() {
    let fields = vec![
        json!({"id": "fld-title", "name": "任务标题", "type": "text"}),
        json!({"id": "fld-status", "name": "天河状态", "type": "text"}),
        json!({"id": "fld-owner", "name": "负责人", "type": "user"}),
        json!({"id": "fld-due", "name": "计划结束日期", "type": "date"}),
    ];
    let mut mapping = Map::new();

    infer_board_mapping(&mut mapping, &fields);

    assert_eq!(mapping["title_field_id"], json!("fld-title"));
    assert_eq!(mapping["status_field_id"], json!("fld-status"));
    assert_eq!(mapping["assignee_field_id"], json!("fld-owner"));
    assert_eq!(mapping["due_field_id"], json!("fld-due"));
}

#[test]
fn uses_explicit_status_mapping_and_reverses_it_for_writes() {
    let config = AITableConfig {
        base_id: "base-1".to_owned(),
        table_id: "table-1".to_owned(),
        mapping: Map::new(),
        status_mode: "mapped".to_owned(),
        status_mapping: Map::from_iter([
            ("开发中".to_owned(), json!("in_progress")),
            ("执行中".to_owned(), json!("in_review")),
        ]),
    };
    assert_eq!(mapped_status(&config, "开发中"), "in_progress");
    assert_eq!(
        source_status_for_write(&config, "in_review", None),
        "执行中"
    );
}

#[test]
fn preserves_source_status_in_custom_lane_mode() {
    let config = AITableConfig {
        base_id: "base-1".to_owned(),
        table_id: "table-1".to_owned(),
        mapping: Map::new(),
        status_mode: "custom".to_owned(),
        status_mapping: Map::new(),
    };
    assert_eq!(source_status_for_write(&config, "开发中", None), "开发中");
}

#[test]
fn resolves_parent_tasks_from_link_ids_or_parent_titles() {
    let mapping = Map::from_iter([
        ("title_field_id".to_owned(), json!("title")),
        ("parent_field_id".to_owned(), json!("parent")),
    ]);
    let titles = HashMap::from([("父任务".to_owned(), "parent-record".to_owned())]);
    assert_eq!(
        parent_record_id(&json!({"cells": {"parent": "父任务"}}), &mapping, &titles),
        Some("parent-record".to_owned())
    );
    assert_eq!(
        parent_record_id(
            &json!({"cells": {"parent": {"linkedRecordIds": ["linked-parent"]}}}),
            &mapping,
            &titles
        ),
        Some("linked-parent".to_owned())
    );
}

#[test]
fn normalizes_dingtalk_due_dates_for_board_cards() {
    assert_eq!(
        normalized_due_at("1785456000000"),
        "2026-07-31T00:00:00+00:00"
    );
    assert_eq!(normalized_due_at("2026-08-01"), "2026-08-01");
    assert_eq!(normalized_due_at(""), "");
}
