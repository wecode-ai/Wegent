// SPDX-License-Identifier: Apache-2.0
//! Full projections and executed reads for package-free account snapshots.
use super::*;
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as Cell};
use serde_json::json;

fn installed_row(id: i64, document: Value) -> Row {
    vec![
        ("kinds_id", Cell::I64(id)),
        ("kinds_user_id", Cell::I64(7)),
        ("kinds_kind", Cell::Text("InstalledPlugin".into())),
        ("kinds_name", Cell::Text(format!("plugin-{id}"))),
        ("kinds_namespace", Cell::Text("default".into())),
        ("kinds_json", Cell::Text(document.to_string())),
        ("kinds_is_active", Cell::I8(1)),
        ("kinds_created_at", Cell::DateTime),
        ("kinds_updated_at", Cell::DateTime),
    ]
}

#[tokio::test]
async fn package_free_snapshots_preserve_complete_payloads_with_one_read() {
    for count in [0, 1, 20, 100] {
        let rows: Vec<_> = (1..=count)
            .map(|id| {
                let mut document = json!({
                    "metadata":{"name":format!("plugin-{id}")},
                    "spec":{
                        "source":{"type":"local","pluginKey":format!("plugin-{id}")},
                        "version":null,"enabled":false,"revision":id,"releaseId":42,
                        "componentStates":{"skill-a":false},
                        "components":{"skills":[{"name":"skill-a"}]},
                        "manifest":{"description":"x".repeat(12_288)}
                    }
                });
                match id % 3 {
                    0 => document["spec"]["packageRef"] = json!({}),
                    1 => document["spec"]["packageRef"] = Value::Null,
                    _ => {}
                }
                installed_row(id, document)
            })
            .collect();
        let fixture = MysqlRows::start_results(move |sql| {
            assert!(
                sql.contains("FROM kinds"),
                "Package-free snapshots must not read releases: {sql}"
            );
            (installed_row(0, json!({})), rows.clone())
        })
        .await;
        let (actual, revisions) = build_local_plugins(&mut &fixture.mysql, 7).await.unwrap();
        let expected: Vec<_> = (1..=count)
            .map(|id| {
                json!({
                    "installed_plugin_id":id,"name":format!("plugin-{id}"),
                    "display_name":format!("plugin-{id}"),"description":"","enabled":false,
                    "marketplace":null,"version":"latest",
                    "source":{"type":"local","pluginKey":format!("plugin-{id}")},
                    "component_states":{"skill-a":false},
                    "components":{"skills":[{"name":"skill-a"}]}
                })
            })
            .collect();
        let expected = json!({"mode":"merge","scope":"plugins","plugins":expected});
        assert_eq!(actual, expected);
        assert_eq!(capability_snapshot(&actual), capability_snapshot(&expected));
        let expected_revisions: Map<String, Value> =
            (1..=count).map(|id| (id.to_string(), json!(id))).collect();
        assert_eq!(revisions, Value::Object(expected_revisions));
        assert_eq!(fixture.queries().len(), 1);
    }
}

#[test]
fn prepared_payload_keeps_override_and_unready_release_semantics() {
    let document = json!({"spec":{
        "source":{"type":"marketplace","pluginKey":"plugin-key"},
        "version":"stored","releaseId":11,"packageRef":{"checksum":"stored-checksum"},
        "components":{"skills":[{"name":"stored"}]}
    }});
    let installed = InstalledKindRow {
        id: 1,
        user_id: 7,
        kind: "InstalledPlugin".into(),
        name: "fallback".into(),
        namespace: "default".into(),
        json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(&document)),
        is_active: true,
        created_at: chrono::NaiveDateTime::default(),
        updated_at: chrono::NaiveDateTime::default(),
    };
    let mut release = PluginReleaseRow {
        id: 77,
        plugin_id: 7,
        version: "target".into(),
        manifest_json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(json!({}))),
        interface_json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(json!({}))),
        release_notes: String::new(),
        storage_key: String::new(),
        sha256: "target-sha".into(),
        size_bytes: 0,
        status: "ready".into(),
        scan_status: "passed".into(),
        scan_report_json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(
            json!({"components":{"skills":[{"name":"target"}]}}),
        )),
        created_by_user_id: 7,
        publication_revision_id: 0,
        source_commit_sha: String::new(),
        created_at: chrono::NaiveDateTime::default(),
        published_at: chrono::NaiveDateTime::default(),
    };
    let expected_base = json!({
        "installed_plugin_id":1,"name":"plugin-key","display_name":"fallback","description":"", "enabled":true,
        "marketplace":null,"version":"stored","source":{"type":"marketplace","pluginKey":"plugin-key"},
        "components":{"skills":[{"name":"stored"}]},"checksum":"stored-checksum"
    });
    for local_http in [true, false] {
        release.status = "pending".into();
        let prepared = plugin_payload::prepare(&installed, &document, Some(77), local_http);
        assert_eq!(prepared.release_id(), Some(77));
        let actual = prepared.render(Some(&release)).unwrap();
        let mut expected = expected_base.clone();
        expected["download_path"] = json!(if local_http {
            "/api/plugins/installed/1/download?expected_release_id=77"
        } else {
            "/api/plugins/installed/1/download"
        });
        assert_eq!(actual, expected);
    }
    let zero = plugin_payload::prepare(&installed, &document, Some(0), true);
    assert_eq!(zero.release_id(), Some(0));
    let mut expected_zero = expected_base.clone();
    expected_zero["download_path"] =
        json!("/api/plugins/installed/1/download?expected_release_id=0");
    assert_eq!(zero.render(None).unwrap(), expected_zero);
    release.status = "ready".into();
    let actual = plugin_payload::prepare(&installed, &document, Some(77), true)
        .render(Some(&release))
        .unwrap();
    let mut expected = expected_base.clone();
    expected["version"] = json!("target");
    expected["checksum"] = json!("sha256:target-sha");
    expected["components"] = json!({"skills":[{"name":"target"}]});
    expected["download_path"] = json!("/api/plugins/installed/1/download?expected_release_id=77");
    expected["download_url_expires_at"] = json!("");
    expected["release_id"] = json!(77);
    assert_eq!(actual, expected);
    release.id = 11;
    let actual = plugin_payload::prepare(&installed, &document, None, true)
        .render(Some(&release))
        .unwrap();
    let mut expected = expected_base;
    expected["download_path"] = json!("/api/plugins/installed/1/download?expected_release_id=11");
    expected["download_url_expires_at"] = json!("");
    expected["release_id"] = json!(11);
    assert_eq!(
        actual, expected,
        "A ready release without an override keeps stored package metadata"
    );
}
