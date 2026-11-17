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
