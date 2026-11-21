// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Protocol-level response and executed-query budgets, using the real MySQL SDK.
use super::super::enrich_installed_list;
use super::test_support::{ObservedMysql, authenticated_list, installed_document};
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as Cell};
use serde_json::{Value, json};

fn device(owner: i64, id: i64, alias: &str) -> Row {
    vec![
        ("kinds_user_id", Cell::I64(owner)),
        ("kinds_id", Cell::I64(id)),
        ("kinds_name", Cell::Text(format!("device-{id}"))),
        (
            "kinds_json",
            Cell::Text(json!({"spec": {"deviceType": "app", "appDeviceId": alias}}).to_string()),
        ),
    ]
}

fn installation(id: i64, alias: &str, release: i64, state: &str) -> Row {
    vec![
        ("installed_kind_id", Cell::I64(id)),
        ("user_id", Cell::I64(7)),
        ("device_id", Cell::Text(alias.into())),
        ("desired_release_id", Cell::I64(10)),
        ("actual_release_id", Cell::I64(release)),
        ("state", Cell::Text(state.into())),
        ("error_code", Cell::Text(String::new())),
        ("error_message", Cell::Text(String::new())),
        ("attempt_count", Cell::I64(0)),
        ("last_sync_at", Cell::DateTime),
        ("updated_at", Cell::DateTime),
    ]
}

async fn fixture(
    count: i64,
    devices: Vec<Row>,
    installations: Vec<Row>,
    plugins: Vec<Row>,
) -> MysqlRows {
    MysqlRows::start_results(move |sql| {
        if sql.contains("FROM users") {
            let row = vec![
                ("id", Cell::I64(7)),
                ("user_name", Cell::Text("list-fixture".into())),
                ("is_active", Cell::I8(1)),
                ("role", Cell::Text("user".into())),
            ];
            return (row.clone(), vec![row]);
        }
        if sql.contains("'InstalledPlugin'") {
            let rows = (1..=count)
                .rev()
                .map(|id| {
                    vec![
                        ("id", Cell::I64(id)),
                        ("json", Cell::Text(installed_document(id).to_string())),
                    ]
                })
                .collect();
            return (
                vec![("id", Cell::I64(0)), ("json", Cell::Text(String::new()))],
                rows,
            );
        }
        if sql.contains("'Device'") {
            return (device(0, 0, ""), devices.clone());
        }
        if sql.contains("FROM plugin_device_installations") {
            return (installation(0, "", 0, ""), installations.clone());
        }
        if sql.contains("FROM plugins") {
            return (
                vec![("id", Cell::I64(0)), ("latest_release_id", Cell::I64(0))],
                plugins.clone(),
            );
        }
        panic!("unexpected listing SQL: {sql}")
    })
    .await
}

#[tokio::test]
async fn authenticated_query_budget_is_constant_for_many_plugins_and_devices() {
    for count in [1, 20, 100] {
        let installations = (1..=count)
            .flat_map(|id| {
                (1..=3).map(move |d| installation(id, &format!("host-{d}"), 10, "installed"))
            })
            .collect();
        let devices = (1..=3)
            .map(|d| device(7, 1000 + d, &format!("host-{d}")))
            .collect();
        let plugins = (1..=count)
            .map(|id| vec![("id", Cell::I64(id)), ("latest_release_id", Cell::I64(10))])
            .collect();
        let fixture = fixture(count, devices, installations, plugins).await;
        for requested in [None, Some("host-1")] {
            let previous_executions = fixture.queries().len();
            let observed = ObservedMysql::new(fixture.mysql.clone());
            let body = authenticated_list(&observed, requested).await;
            assert_eq!(body["items"].as_array().unwrap().len(), count as usize);
            assert_eq!(
                body["items"][0]["metadata"]["labels"]["id"],
                count.to_string()
            );
            for item in body["items"].as_array().unwrap() {
                assert_eq!(item["spec"]["installState"], "installed");
                assert_eq!(item["status"]["devices"].as_array().unwrap().len(), 3);
            }
            let reads = observed.take_reads();
            assert_eq!(reads.len(), 5, "count={count}, device={requested:?}");
            assert_eq!(
                reads
                    .iter()
                    .filter(|(sql, _)| sql.contains("'Device'"))
                    .count(),
                1
            );
            assert_eq!(
                reads
                    .iter()
                    .filter(|(sql, _)| sql.contains("FROM plugins"))
                    .count(),
                1
            );
            // MysqlRows records executions, even when the SDK reuses prepared statements.
            assert_eq!(fixture.queries().len() - previous_executions, 5);
        }
    }
}

#[tokio::test]
async fn empty_and_device_free_lists_skip_unneeded_reads() {
    let empty = fixture(0, vec![], vec![], vec![]).await;
    let observed = ObservedMysql::new(empty.mysql.clone());
    assert_eq!(
        authenticated_list(&observed, None).await,
        json!({"items": []})
    );
    assert_eq!(observed.take_reads().len(), 2);

    let no_devices = fixture(
        1,
        vec![],
        vec![],
        vec![vec![
            ("id", Cell::I64(1)),
            ("latest_release_id", Cell::I64(11)),
        ]],
    )
    .await;
    let observed = ObservedMysql::new(no_devices.mysql.clone());
    let body = authenticated_list(&observed, None).await;
    assert_eq!(body["items"][0]["spec"]["installState"], "update_available");
    assert_eq!(observed.take_reads().len(), 4);
    let body = authenticated_list(&observed, Some("host-1")).await;
    assert_eq!(body["items"][0]["spec"]["installState"], "not_installed");
    assert_eq!(observed.take_reads().len(), 3);
}

fn item(id: i64, plugin_id: Value, release_id: Value) -> Value {
    json!({
        "metadata": {"labels": {"id": id.to_string()}},
        "spec": {"pluginId": plugin_id, "releaseId": release_id, "installState": "account-state"},
        "status": {"state": "Available", "devices": []}
    })
}

fn expected_device(display: &str, release: Value, state: &str) -> Value {
    json!({
        "deviceId": display, "desiredReleaseId": 10, "actualReleaseId": release,
        "state": state, "errorCode": null, "errorMessage": null, "attemptCount": 0,
        "lastSyncAt": "2026-10-23T00:00:00.000000", "updatedAt": "2026-10-23T00:00:00.000000"
    })
}

#[tokio::test]
async fn response_contract_preserves_device_precedence_and_marketplace_edge_cases() {
    let rows = vec![
        installation(1, "host-1", 10, "installed"),
        installation(2, "host-1", 9, "installed"),
        installation(3, "host-1", 0, "failed"),
        installation(5, "host-1", 10, "installed"),
        installation(7, "host-1", 10, "installed"),
        installation(8, "host-1", 0, "pending"),
    ];
    let fixture = fixture(
        0,
        vec![device(7, 1001, "host-1")],
        rows,
        vec![
            vec![("id", Cell::I64(1)), ("latest_release_id", Cell::I64(11))],
            vec![("id", Cell::I64(5)), ("latest_release_id", Cell::I64(11))],
        ],
    )
    .await;
    let mut items: Vec<_> = (1..=9).map(|id| item(id, json!(id), json!(10))).collect();
    items[4]["spec"]["releaseId"] = Value::Null;
    items[5]["spec"]["pluginId"] = Value::Null;
    items[8]["spec"]["pluginId"] = json!(0);
    let mut expected = items.clone();
    for (index, release, state) in [
        (0, json!(10), "installed"),
        (1, json!(9), "installed"),
        (2, Value::Null, "failed"),
        (4, json!(10), "installed"),
        (6, json!(10), "installed"),
        (7, Value::Null, "pending"),
    ] {
        expected[index]["status"]["devices"] = json!([expected_device("host-1", release, state)]);
    }
    for (index, state) in [
        "update_available",
        "update_available",
        "failed",
        "not_installed",
        "installed",
        "account-state",
        "installed",
        "not_installed",
        "not_installed",
    ]
    .iter()
    .enumerate()
    {
        expected[index]["spec"]["installState"] = json!(state);
    }
    enrich_installed_list(&fixture.mysql, &mut items, Some("host-1"))
        .await
        .unwrap();
    assert_eq!(items, expected);
    let sql = fixture.queries();
    assert_eq!(sql.len(), 3);
    assert!(
        sql[2].contains("IN (?, ?, ?)"),
        "only IDs 1, 5, 7 need marketplace reads"
    );
}

#[tokio::test]
async fn duplicate_plugin_ids_are_loaded_once_and_existing_status_is_appended() {
    let fixture = fixture(
        0,
        vec![device(7, 1001, "host-1")],
        vec![installation(1, "host-1", 10, "installed")],
        vec![vec![
            ("id", Cell::I64(1)),
            ("latest_release_id", Cell::I64(11)),
        ]],
    )
    .await;
    let mut items = vec![item(1, json!(1), json!(10)), item(2, json!(1), json!(10))];
    items[0]["status"]["devices"] = json!([{"existing": true}]);
    let mut expected = items.clone();
    expected[0]["status"]["devices"] =
        json!([{"existing": true}, expected_device("app-record-1001", json!(10), "installed")]);
    for item in &mut expected {
        item["spec"]["installState"] = json!("update_available");
    }
    enrich_installed_list(&fixture.mysql, &mut items, None)
        .await
        .unwrap();
    assert_eq!(items, expected);
    assert!(fixture.queries()[2].contains("IN (?)"));
}

#[tokio::test]
async fn absent_empty_and_whitespace_request_devices_keep_their_branch_semantics() {
    for stored in ["host-1", ""] {
        let fixture = fixture(
            0,
            vec![device(7, 1001, "host-1")],
            vec![installation(1, stored, 10, "installed")],
            vec![],
        )
        .await;
        for requested in [None, Some(""), Some("   ")] {
            let mut items = vec![item(1, json!(1), json!(10))];
            let mut expected = items.clone();
            let canonical = if stored.is_empty() {
                ""
            } else {
                "app-record-1001"
            };
            let matched = requested.is_some() && stored.is_empty();
            let display = if matched {
                requested.unwrap()
            } else {
                canonical
            };
            expected[0]["status"]["devices"] =
                json!([expected_device(display, json!(10), "installed")]);
            expected[0]["spec"]["installState"] = json!(match (requested, matched) {
                (None, _) => "account-state",
                (_, true) => "installed",
                _ => "not_installed",
            });
            enrich_installed_list(&fixture.mysql, &mut items, requested)
                .await
                .unwrap();
            assert_eq!(
                items, expected,
                "stored={stored:?}, requested={requested:?}"
            );
        }
    }
}

#[tokio::test]
async fn database_failures_propagate_from_each_batch_stage() {
    let fixture = fixture(
        0,
        vec![device(7, 1001, "host-1")],
        vec![installation(1, "host-1", 10, "installed")],
        vec![],
    )
    .await;
    for failing in [
        "FROM plugin_device_installations",
        "'Device'",
        "FROM plugins",
    ] {
        let observed = ObservedMysql::new(fixture.mysql.clone()).failing(failing);
        let mut items = vec![item(1, json!(1), json!(10))];
        let error = enrich_installed_list(&observed, &mut items, None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("fixture read failure"));
        assert!(observed.take_reads().last().unwrap().0.contains(failing));
    }
}
