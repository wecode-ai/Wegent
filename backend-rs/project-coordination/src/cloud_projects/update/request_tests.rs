// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for `CloudProjectUpdate` decoding.
use super::*;
use serde_json::json;

/// The recorded PATCH body:
/// `{"version": 1, "visibility": "public"}`.
#[test]
fn the_recorded_body_decodes_to_the_visibility_update() {
    let update = CloudProjectUpdate::decode(&json!({"version": 1, "visibility": "public"}))
        .expect("the recorded body is valid");
    assert!(update.has("visibility"));
    assert!(!update.has("tags"));
    assert!(update.touches_metadata());
    assert_eq!(update.visibility.as_deref(), Some("public"));
    assert_eq!(update.version, 1);
    // Only `metadata_json` is written back onto the project row.
    assert!(update.direct_columns().is_empty());
}

#[test]
fn name_and_description_are_the_direct_columns_in_dump_order() {
    let update = CloudProjectUpdate::decode(&json!({
        "name": "Renamed",
        "description": "Body",
        "version": 3,
    }))
    .unwrap();
    assert!(!update.touches_metadata());
    assert_eq!(
        update.direct_columns(),
        vec![
            ("name", "Renamed".to_string()),
            ("description", "Body".to_string()),
        ]
    );
}

#[test]
fn a_missing_version_is_a_missing_field_error() {
    let error = CloudProjectUpdate::decode(&json!({"visibility": "public"})).unwrap_err();
    assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], json!("missing"));
    assert_eq!(detail[0]["loc"], json!(["body", "version"]));
}

#[test]
fn a_non_positive_version_is_rejected() {
    let error = CloudProjectUpdate::decode(&json!({"version": 0})).unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], json!("greater_than_equal"));
}

#[test]
fn an_unknown_visibility_is_a_literal_error() {
    let error =
        CloudProjectUpdate::decode(&json!({"version": 1, "visibility": "shared"})).unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], json!("literal_error"));
    assert_eq!(detail[0]["loc"], json!(["body", "visibility"]));
}

#[test]
fn a_private_visibility_with_public_access_is_rejected() {
    let error = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "visibility": "private",
        "public_access": {"role": "Viewer"},
    }))
    .unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], json!("value_error"));
    assert_eq!(
        detail[0]["msg"],
        json!("Value error, Private projects cannot grant public access")
    );
}

#[test]
fn tags_are_normalized_and_deduplicated() {
    let update = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "tags": [" a ", "a", "", "b"],
    }))
    .unwrap();
    assert!(update.touches_metadata());
    assert_eq!(update.tags, Some(vec!["a".to_string(), "b".to_string()]));
}

#[test]
fn a_non_list_tag_value_normalizes_to_an_empty_list() {
    let update = CloudProjectUpdate::decode(&json!({"version": 1, "tags": "abc"})).unwrap();
    assert_eq!(update.tags, Some(Vec::new()));
}

#[test]
fn a_null_metadata_field_still_triggers_the_merge() {
    let update = CloudProjectUpdate::decode(&json!({"version": 1, "card_display": null})).unwrap();
    assert!(update.has("card_display"));
    assert!(update.touches_metadata());
    assert!(update.card_display.is_none());
}

#[test]
fn card_display_dump_fills_the_declaration_order_defaults() {
    let update =
        CloudProjectUpdate::decode(&json!({"version": 1, "card_display": {"show_tags": false}}))
            .unwrap();
    let dump = update.card_display.unwrap();
    assert_eq!(
        dump,
        json!({
            "show_assignee": true,
            "show_priority": true,
            "show_tags": false,
            "show_date": true,
        })
    );
}

#[test]
fn board_config_dump_derives_the_processing_start_status() {
    let update = CloudProjectUpdate::decode(&json!({"version": 1, "board_config": {}})).unwrap();
    let dump = update.board_config.unwrap();
    assert_eq!(dump["group_by"], json!("status"));
    assert_eq!(dump["processing_start_status_id"], json!("pending"));
    assert_eq!(
        dump["schedule_view"],
        json!({
            "status_filter": null,
            "assignee_filter": null,
            "tag_filter": null,
            "group_by": "none",
            "sort_by": "start_asc",
        })
    );
    let statuses = dump["statuses"].as_array().unwrap();
    assert_eq!(statuses.len(), 5);
    assert_eq!(statuses[0]["id"], json!("inbox"));
}

#[test]
fn board_config_processing_status_must_reference_a_status() {
    let error = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "board_config": {"processing_start_status_id": "ghost"},
    }))
    .unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], json!("value_error"));
}

#[test]
fn workflow_definition_with_nodes_infers_dag_stage_mode() {
    let update = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "workflow_definition": {"nodes": [{"id": "a"}]},
    }))
    .unwrap();
    let dump = update.workflow_definition.unwrap();
    assert_eq!(dump["stage_mode"], json!("dag"));
    assert_eq!(dump["version"], json!(1));
    assert_eq!(dump["advancement_policy"], json!("manual"));
}

#[test]
fn an_unparseable_body_is_a_dictionary_error() {
    let error = CloudProjectUpdate::decode(&json!([1, 2])).unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["loc"], json!(["body"]));
}

#[test]
fn a_provider_token_is_trimmed_and_a_credential_is_rejected() {
    let update = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "provider_config": {"repository": "owner/repo", "token": " x "},
    }))
    .unwrap();
    assert_eq!(update.provider_config.unwrap()["token"], json!("x"));
    let error = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "provider_config": {"repository": "owner/repo", "credential": {}},
    }))
    .unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(
        detail[0]["msg"],
        json!("Value error, encrypted provider credentials cannot be supplied")
    );
}

#[test]
fn execution_environment_rejects_duplicate_repository_paths() {
    let error = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "execution_environment": {
            "repositories": [
                {"name": "a", "url": "u", "path": "src", "primary": true},
                {"name": "b", "url": "v", "path": "src"},
            ],
        },
    }))
    .unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], json!("value_error"));
    assert_eq!(
        detail[0]["msg"],
        json!("Value error, repository paths must be unique")
    );
}

#[test]
fn execution_environment_rejects_an_absolute_repository_path() {
    let error = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "execution_environment": {
            "repositories": [{"name": "a", "url": "u", "path": "/src", "primary": true}],
        },
    }))
    .unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(
        detail[0]["msg"],
        json!("Value error, repository path must be a normalized relative path")
    );
}

#[test]
fn execution_environment_bounds_the_repository_list() {
    let repositories: Vec<serde_json::Value> = (0..21)
        .map(|index| {
            json!({"name": format!("r{index}"), "url": "u", "path": format!("p{index}"), "primary": index == 0})
        })
        .collect();
    let error = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "execution_environment": {"repositories": repositories},
    }))
    .unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], json!("too_long"));
}

#[test]
fn workflow_definition_rejects_duplicate_node_ids() {
    let error = CloudProjectUpdate::decode(&json!({
        "version": 1,
        "workflow_definition": {"nodes": [{"id": "a"}, {"id": "a"}]},
    }))
    .unwrap_err();
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(
        detail[0]["msg"],
        json!("Value error, workflow node ids must be unique")
    );
}
