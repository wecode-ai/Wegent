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
