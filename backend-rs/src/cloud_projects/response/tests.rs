// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_mysql::Json;
use chrono::NaiveDateTime;

#[test]
fn saved_views_preserve_future_versions_and_extensions() {
    for config in [
        json!({"schema_version":1,"views":[{"id":"mixed","name":"Mixed","columns":[{"id":"progress","type":"status","value":"in_progress","futureField":true},{"id":"tag","type":"tag","value":"frontend"}],"filter":{"tags":[],"match":"all"}}],"futureExtension":{"keepCase":7}}),
        json!({"schema_version":2,"future":true}),
    ] {
        let response = project_response(&row(json!({"board_views":config})), 1, "user", "Owner");
        assert_eq!(response["board_views"], config);
    }
}

#[test]
fn cloud_project_legacy_json_baseline() {
    let output: Vec<_> = [json!({}), Value::Null, json!([]),
        json!({"task_provider":"local","provider_config":{"credential":{"token":"x"},"other":null},"tags":[" a ","a",""]}),
        json!({"board_config":{"statuses":[{"id":"custom","extra":null}],"default_status":null},"card_display":{},"ai_automation":null,"workflow_definition":null}),
        json!({"workflow_definition":{"version":2,"nodes":[{"x":null}],"edges":[{}]},"pull_request_automation":{"trigger_events":["a","a",null]}})
    ].into_iter().map(|metadata| project_response(&row(metadata), 1, "user", "Owner")).collect();
    crate::json_contract_tests::assert_fixture("cloud_project", output);
}

fn project_response(
    project: &ProjectListRow,
    current_user_id: i32,
    current_user_name: &str,
    access_role: &str,
) -> Value {
    crate::json_contract_tests::serialized(super::project_response(
        project,
        current_user_id,
        current_user_name,
        access_role,
        None,
        None,
    ))
    .unwrap()
}
fn datetime_value(value: Option<NaiveDateTime>) -> Value {
    crate::json_contract_tests::serialized(super::datetime_value(value)).unwrap()
}
fn row(metadata: Value) -> ProjectListRow {
    ProjectListRow {
        id: "1000000000000000001".to_string(),
        public_id: Some("00000000-0000-4000-8000-000000000003".to_string()),
        project_key: Some("EXAMPLEPROJECT1".to_string()),
        name: Some("Example Project".to_string()),
        description: Some("Description".to_string()),
        created_by_user_id: 101,
        status: "active".to_string(),
        version: 4,
        created_at: NaiveDateTime::parse_from_str("2026-07-28 15:44:57", "%Y-%m-%d %H:%M:%S").ok(),
        updated_at: NaiveDateTime::parse_from_str("2026-07-28 17:30:01", "%Y-%m-%d %H:%M:%S").ok(),
        metadata: Some(Json(metadata.into())),
    }
}

#[test]
fn serializes_the_recorded_gitlab_project_shape() {
    let metadata = serde_json::json!({
        "tags": [],
        "visibility": "public",
        "project_store": "backend",
        "task_provider": "gitlab",
        "provider_config": {
            "domain": "git.example.invalid",
            "api_base": "https://git.example.invalid/api/v4",
            "credential": {"nonce": "n", "version": 2},
            "repository": "example_org/common/example/example-issues",
        },
    });
    let value = project_response(&row(metadata), 301, "example-user", "RestrictedAnalyst");
    assert_eq!(value["id"], "1000000000000000001");
    // The stored metadata `visibility` is overridden: only an approved
    // all-signed-in-users grant makes the project `public`.
    assert_eq!(value["visibility"], "private");
    assert_eq!(value["public_access"], serde_json::Value::Null);
    assert_eq!(value["default_issue_security"], "open");
    assert_eq!(value["task_provider"], "gitlab");
    // credential masked, other keys kept, flag appended last
    assert_eq!(
        value["provider_config"],
        serde_json::json!({
            "domain": "git.example.invalid",
            "api_base": "https://git.example.invalid/api/v4",
            "repository": "example_org/common/example/example-issues",
            "credential_configured": true,
        })
    );
    assert_eq!(value["access_role"], "RestrictedAnalyst");
    assert_eq!(value["current_user_id"], 301);
    assert_eq!(value["created_by_user_id"], 101);
    assert_eq!(value["created_at"], "2026-07-28T15:44:57");
    // defaults
    assert_eq!(value["card_display"]["show_assignee"], true);
    assert_eq!(value["board_config"]["group_by"], "status");
    assert_eq!(
        value["board_config"]["processing_start_status_id"],
        "pending"
    );
    // `CloudProjectScheduleViewConfig` default_factory: the source always
    // renders `schedule_view`, defaulting every absent key.
    assert_eq!(
        value["board_config"]["schedule_view"],
        serde_json::json!({
            "status_filter": null,
            "assignee_filter": null,
            "tag_filter": null,
            "group_by": "none",
            "sort_by": "start_asc",
        })
    );
    assert_eq!(value["ai_automation"]["max_retry_count"], 1);
    assert_eq!(value["pull_request_automation"]["prompt"], "");
    assert_eq!(value["workflow_definition"]["version"], 1);
    assert_eq!(value["workflow_definition"]["nodes"], serde_json::json!([]));
    assert_eq!(value["tags"], serde_json::json!([]));
}

/// A stored partial `schedule_view` keeps its present keys and defaults the
/// absent ones, matching the schema's `default_factory` behavior.
#[test]
fn schedule_view_fills_present_keys_and_defaults_the_rest() {
    let value = project_response(
        &row(serde_json::json!({
            "board_config": {
                "schedule_view": {
                    "group_by": "status",
                    "sort_by": "due_asc",
                    "assignee_filter": "42",
                }
            }
        })),
        301,
        "example-user",
        "Viewer",
    );
    assert_eq!(
        value["board_config"]["schedule_view"],
        serde_json::json!({
            "status_filter": null,
            "assignee_filter": "42",
            "tag_filter": null,
            "group_by": "status",
            "sort_by": "due_asc",
        })
    );
}

#[test]
fn masks_local_provider_config_to_the_flag() {
    let value = project_response(
        &row(serde_json::json!({"task_provider": "local", "provider_config": {}})),
        301,
        "example-user",
        "Maintainer",
    );
    assert_eq!(
        value["provider_config"],
        serde_json::json!({"credential_configured": false})
    );
    assert_eq!(value["task_provider"], "local");
    assert_eq!(value["visibility"], "private");
}

#[test]
fn unknown_task_provider_falls_back_to_local() {
    let value = project_response(
        &row(serde_json::json!({"task_provider": "weird"})),
        1,
        "u",
        "Owner",
    );
    assert_eq!(value["task_provider"], "local");
}

#[test]
fn normalize_tags_dedupes_and_trims() {
    let tags = serde_json::json!([" a ", "a", "", "b"]);
    let tags = OpaqueJson::from(tags);
    assert_eq!(
        normalize_tags(Some(&tags)),
        vec!["a".to_string(), "b".to_string()]
    );
    assert_eq!(
        normalize_tags(Some(&OpaqueJson::from(serde_json::json!("x")))),
        Vec::<String>::new()
    );
    assert_eq!(normalize_tags(None), Vec::<String>::new());
}

#[test]
fn fractional_datetimes_render_with_microseconds() {
    let parsed =
        NaiveDateTime::parse_from_str("2026-09-01 15:18:26.901656", "%Y-%m-%d %H:%M:%S%.f")
            .unwrap();
    assert_eq!(
        datetime_value(Some(parsed)),
        json!("2026-09-01T15:18:26.901656")
    );
}

#[test]
fn execution_environment_defaults_when_metadata_omits_it() {
    let value = crate::json_contract_tests::serialized(execution_environment_value(None)).unwrap();
    assert_eq!(
        value,
        json!({
            "workspace_policy": "git_worktree",
            "repositories": [],
            "setup_steps": [],
            "fingerprint": "",
            "devices": {},
        })
    );
}

#[test]
fn execution_environment_normalizes_devices_and_drops_unknown_keys() {
    let metadata = json!({
        "repositories": [
            {"name": " Wegent ", "url": "https://example.invalid/r", "path": "wegent",
             "primary": true, "unknown": "dropped"},
        ],
        "fingerprint": "abc",
        "devices": {
            "app-record-1": {"status": "ready", "workspace_path": "/tmp/x",
                             "prepared_at": "2026-09-18T02:59:27.317525+00:00",
                             "error": "", "unknown": "dropped"},
            "app-record-2": {"status": "error", "prepared_at": null},
        },
    });
    let value = crate::json_contract_tests::serialized(execution_environment_value(Some(
        &OpaqueJson::from(metadata),
    )))
    .unwrap();
    assert_eq!(
        value,
        json!({
            "workspace_policy": "git_worktree",
            "repositories": [{
                "name": "Wegent",
                "url": "https://example.invalid/r",
                "ref": "",
                "path": "wegent",
                "primary": true,
            }],
            "setup_steps": [],
            "fingerprint": "abc",
            "devices": {
                "app-record-1": {
                    "status": "ready",
                    "workspace_path": "/tmp/x",
                    "prepared_at": "2026-09-18T02:59:27.317525Z",
                    "error": "",
                },
                "app-record-2": {
                    "status": "error",
                    "workspace_path": "",
                    "prepared_at": null,
                    "error": "",
                },
            },
        })
    );
}

#[test]
fn workspace_context_fills_the_navigation_fields() {
    let workspace = WorkspaceContext {
        id: "4242".to_string(),
        public_id: "11111111-2222-3333-4444-555555555555".to_string(),
        name: "示例空间".to_string(),
    };
    let value = crate::json_contract_tests::serialized(super::project_response(
        &row(json!({"visibility": "public"})),
        301,
        "user",
        "RestrictedAnalyst",
        None,
        Some(&workspace),
    ))
    .unwrap();
    assert_eq!(value["workspace_id"], json!("4242"));
    assert_eq!(value["workspace_context"]["id"], json!("4242"));
    assert_eq!(
        value["workspace_context"]["public_id"],
        json!("11111111-2222-3333-4444-555555555555")
    );
    assert_eq!(value["workspace_context"]["name"], json!("示例空间"));
}

#[test]
fn missing_workspace_context_renders_null_navigation_fields() {
    let value = project_response(&row(json!({})), 1, "user", "Owner");
    assert_eq!(value["workspace_id"], Value::Null);
    assert_eq!(value["workspace_context"], Value::Null);
}

#[test]
fn visibility_tracks_the_all_signed_in_users_grant() {
    // No approved `authenticated_users` grant -> `private`, regardless of
    // the stored metadata value.
    for stored in ["public", "public_restricted", "private", "weird"] {
        let value = project_response(&row(json!({"visibility": stored})), 1, "u", "Owner");
        assert_eq!(value["visibility"], json!("private"), "stored {stored}");
        assert_eq!(value["public_access"], Value::Null);
    }
    // A stored grant role makes the project `public` and exposes
    // `public_access.role`.
    let value = crate::json_contract_tests::serialized(super::project_response(
        &row(json!({})),
        1,
        "u",
        "Viewer",
        Some("Viewer"),
        None,
    ))
    .unwrap();
    assert_eq!(value["visibility"], json!("public"));
    assert_eq!(value["public_access"], json!({"role": "Viewer"}));
}

#[test]
fn default_issue_security_reads_the_metadata_literal() {
    for (stored, expected) in [("open", "open"), ("related", "related"), ("weird", "open")] {
        let value = project_response(
            &row(json!({"default_issue_security": stored})),
            1,
            "u",
            "Owner",
        );
        assert_eq!(value["default_issue_security"], json!(expected));
    }
    // Missing metadata falls back to the schema default.
    let value = project_response(&row(json!({})), 1, "u", "Owner");
    assert_eq!(value["default_issue_security"], json!("open"));
}

#[test]
fn preserves_project_admin_policy_and_saved_view_contract() {
    let views = json!({"schema_version": 1, "default_view_id": "delivery", "views": [
        {"id": "delivery", "name": "Delivery", "columns": [
            {"id": "tag", "type": "tag", "value": "backend"},
            {"id": "other", "type": "unmatched", "value": "unmatched"}],
         "filter": {"tags": ["backend"], "match": "all"},
         "sorts": {"tag": ["priority-desc"]}}
    ]});
    let policy = json!({"content": "All stages require evidence", "revision": 3});
    let value = project_response(
        &row(json!({"board_views": views, "collaboration_policy": policy})),
        301,
        "example-user",
        "Maintainer",
    );
    assert_eq!(value["board_views"], views);
    assert_eq!(value["collaboration_policy"], policy);
    let defaults = project_response(&row(json!({})), 301, "example-user", "Maintainer");
    assert_eq!(
        defaults["collaboration_policy"],
        json!({"content": "", "revision": 1})
    );
}

#[test]
fn preserves_project_tags_without_truncating_the_python_read_contract() {
    let tags: Vec<_> = (0..20).map(|index| format!("tag-{index}")).collect();
    let value = project_response(
        &row(json!({"tags": tags})),
        301,
        "example-user",
        "Maintainer",
    );
    assert_eq!(value["tags"], json!(tags));
    let long_tag = "长".repeat(40);
    assert_eq!(
        normalize_tags(Some(&OpaqueJson::from(json!([long_tag.clone()])))),
        vec![long_tag]
    );
}

#[test]
fn preserves_explicit_empty_statuses_for_tag_and_assignee_boards() {
    let value = project_response(
        &row(json!({"board_config": {"group_by": "tag", "statuses": []}})),
        301,
        "example-user",
        "Maintainer",
    );
    assert_eq!(value["board_config"]["statuses"], json!([]));
    assert_eq!(
        value["board_config"]["processing_start_status_id"],
        Value::Null
    );
}
