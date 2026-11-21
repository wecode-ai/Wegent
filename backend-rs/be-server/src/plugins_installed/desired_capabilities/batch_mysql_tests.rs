// SPDX-License-Identifier: Apache-2.0
//! Compare pooled single projections with the full-sync batched projection.
use super::*;
use crate::plugins_installed::test_support::{ObservedMysql, seed, with_database};

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Rust CI"]
async fn local_plugins_batch_preserves_payload_order_and_snapshot() {
    for count in [0, 1, 20, 100] {
        with_database(move |mysql| async move {
            seed(&mysql,count).await;
            for id in 1..=count {
                let release=match id % 5 { 0=>999, 1=>11, 2=>12, 3=>13, _=>14 };
                mysql.execute("UPDATE kinds SET json=? WHERE id=?",(serde_json::json!({"metadata":{"name":format!("plugin-{id}")},"spec":{"releaseId":release,"version":format!("v{id}"),"enabled":id%2==0,"packageRef":{"checksum":format!("checksum-{id}")},"source":{"type":"marketplace"}}}).to_string(),id)).await.unwrap();
            }
            for (id,status,scan) in [(11,"ready","passed"),(12,"pending","passed"),(13,"ready","failed"),(14,"ready","passed")] {
                mysql.execute("INSERT INTO plugin_releases (id,version,status,scan_status,storage_key) VALUES (?,? ,?,?,?)",(id,format!("r{id}"),status,scan,format!("key-{id}"))).await.unwrap();
            }
            let observed=ObservedMysql::new(mysql);
            let rows:Vec<InstalledKindRow>=observed.fetch_all(format!("SELECT {KIND_COLUMNS} FROM kinds WHERE user_id=7 AND kind='InstalledPlugin' ORDER BY id ASC"),()).await.unwrap();
            let mut expected=Vec::new();
            for row in &rows {
                expected.push(plugin_payload(&mut &observed,row,None,true).await.unwrap());
            }
            observed.take_reads();
            let (actual,revisions)=build_local_plugins(&mut &observed,7).await.unwrap();
            let reads=observed.take_reads();
            assert_eq!(reads.len(),if count==0 { 1 } else { 2 });
            let expected=serde_json::json!({"mode":"merge","scope":"plugins","plugins":expected});
            assert_eq!(actual.to_string(),expected.to_string());
            assert_eq!(capability_snapshot(&actual),capability_snapshot(&expected));
            assert_eq!(revisions.as_object().unwrap().len(),count as usize);
            if count>0 {
                assert_eq!(actual["plugins"][0], serde_json::json!({
                    "installed_plugin_id":1,"name":"plugin-1","display_name":"plugin-1",
                    "description":"","enabled":false,"marketplace":null,"version":"v1",
                    "source":{"type":"marketplace"},"checksum":"checksum-1",
                    "download_path":"/api/plugins/installed/1/download?expected_release_id=11",
                    "download_url_expires_at":"","release_id":11
                }));
                if count>=3 {
                    assert_eq!(actual["plugins"][1],serde_json::json!({
                        "installed_plugin_id":2,"name":"plugin-2","display_name":"plugin-2",
                        "description":"","enabled":true,"marketplace":null,"version":"v2",
                        "source":{"type":"marketplace"},"checksum":"checksum-2",
                        "download_path":"/api/plugins/installed/2/download?expected_release_id=12"
                    }));
                    assert!(actual["plugins"][2].get("release_id").is_none());
                    assert!(actual["plugins"][1]["download_path"].as_str().unwrap().ends_with("expected_release_id=12"));
                }
            }
        }).await;
    }
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Rust CI"]
async fn local_plugins_batch_preserves_package_free_and_mixed_records() {
    for packaged in [false, true] {
        with_database(move |mysql| async move {
            seed(&mysql, 100).await;
            let mut expected_plugins = Vec::new();
            let mut expected_revisions = Map::new();
            for id in 1..=100 {
                let active = id % 11 != 0;
                let synced = id % 13 != 0;
                let release = packaged.then_some(id % 5).and_then(|slot| match slot {
                    0 => Some(11), 1 => Some(999), _ => None,
                });
                let source = serde_json::json!({"type":if release.is_some() {"marketplace"} else {"local"},"pluginKey":format!("plugin-{id}")});
                let revision = if id % 17 == 0 { Value::String("invalid".into()) } else { Value::from(id) };
                let mut document = serde_json::json!({"metadata":{"name":format!("plugin-{id}")},"spec":{
                    "source":source,"displayName":format!("Display {id}"),"enabled":id%2==0,
                    "installState":if synced {"installed"} else {"uninstalled"},"revision":revision,
                    "manifest":{"description":"x".repeat(12_288)}
                }});
                if let Some(release_id) = release {
                    document["spec"]["packageRef"] = serde_json::json!({"checksum":format!("stored-{id}")});
                    document["spec"]["releaseId"] = Value::from(release_id);
                } else if id % 2 == 0 {
                    document["spec"]["packageRef"] = Value::Null;
                }
                mysql.execute("UPDATE kinds SET json=?,is_active=? WHERE id=?", (document.to_string(),active,id)).await.unwrap();
                if id % 17 != 0 { expected_revisions.insert(id.to_string(),Value::from(id)); }
                if !active || !synced { continue; }
                let mut expected = serde_json::json!({
                    "installed_plugin_id":id,"name":format!("plugin-{id}"),"display_name":format!("Display {id}"),
                    "description":"","enabled":id%2==0,"marketplace":null,"version":"latest","source":source
                });
                if let Some(release_id) = release {
                    expected["checksum"] = Value::String(format!("stored-{id}"));
                    expected["download_path"] = Value::String(format!("/api/plugins/installed/{id}/download?expected_release_id={release_id}"));
                    if release_id == 11 {
                        expected["download_url_expires_at"] = Value::String(String::new());
                        expected["release_id"] = Value::from(11);
                    }
                }
                expected_plugins.push(expected);
            }
            mysql.execute("INSERT INTO plugin_releases (id,version,status,scan_status) VALUES (11,'target','ready','passed')",()).await.unwrap();
            let observed = ObservedMysql::new(mysql);
            let (actual, revisions) = build_local_plugins(&mut &observed, 7).await.unwrap();
            let expected = serde_json::json!({"mode":"merge","scope":"plugins","plugins":expected_plugins});
            assert_eq!(actual.to_string(), expected.to_string());
            assert_eq!(capability_snapshot(&actual), capability_snapshot(&expected));
            assert_eq!(revisions, Value::Object(expected_revisions));
            let reads = observed.take_reads();
            assert_eq!(reads.len(), if packaged {2} else {1});
            if packaged { assert!(reads[1].0.contains("IN (?, ?)")); }
        }).await;
    }
}
