// SPDX-License-Identifier: Apache-2.0
//! Fixed read budgets and projections through disposable MySQL.
use super::test_support::{ObservedMysql, seed, with_database};
use crate::permissions::EntityResolvers;
use crate::plugins_marketplace::{MarketplaceQuery, db::UserRepository, list_plugins};
use serde_json::json;

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Rust CI"]
async fn marketplace_missing_device_has_constant_reads() {
    for count in [1, 20, 100] {
        with_database(move |mysql| async move {
            seed(&mysql, count).await;
            for id in 1..=count {
                mysql.execute("UPDATE plugins SET name=?,slug=?,catalog_namespace='enterprise',status='published',visibility='public',owner_user_id=7,latest_release_id=? WHERE id=?", (format!("plugin-{id}"),format!("plugin-{id}"),100+id,id)).await.unwrap();
                mysql.execute("INSERT INTO plugin_releases (id,plugin_id,version,status,scan_status) VALUES (?,?,?,'ready','passed')", (100+id,id,format!("1.0.{id}"))).await.unwrap();
            }
            let observed = ObservedMysql::new(mysql.clone());
            let user = UserRepository::find_by_username(&observed, "list-fixture").await.unwrap().unwrap();
            let resolvers = EntityResolvers::<brz_redis::RedisService>::public(mysql.clone());
            observed.take_reads();
            for device in [None, Some(""), Some("host-1"), Some("unknown"), Some("   ")] {
                let response = list_plugins(&observed, None, &resolvers, Some(&user), &MarketplaceQuery { device_id:device.map(str::to_string), ..Default::default() }).await.unwrap();
                let reads = observed.take_reads();
                assert_eq!(reads.len(), if device.is_some_and(|id| !id.is_empty()) { 8 } else { 6 }, "count={count} device={device:?}");
                assert_eq!(response.items.len(), count as usize);
                let body=serde_json::to_value(response).unwrap();
                for item in body["items"].as_array().unwrap() {
                    let id=item["id"].as_i64().unwrap();
                    assert_eq!(item["version"],format!("1.0.{id}"));
                    if matches!(device, Some("unknown" | "   ")) {
                        assert_eq!(item["installed"],false);
                        assert_eq!(item["currentDeviceInstallation"],json!(null));
                    } else {
                        assert_eq!(item["installed"],true);
                    }
                }
            }
            mysql.execute("UPDATE plugins SET visibility='personal',owner_user_id=8 WHERE id=1",()).await.unwrap();
            let result=list_plugins(&observed,None,&resolvers,Some(&user),&MarketplaceQuery { device_id:Some("unknown".into()),q:Some("plugin-1".into()),..Default::default() }).await.unwrap();
            assert!(result.items.iter().all(|item| item.id != 1));
        }).await;
    }
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Rust CI"]
async fn device_snapshot_limits_record_ids_and_keeps_alias_owners_separate() {
    with_database(|mysql| async move {
        seed(&mysql, 0).await;
        for (id, owner, namespace, active, kind) in [
            (1004_i64, 8_i64, "default", true, "Device"),
            (2000, 7, "other", true, "Device"),
            (2001, 7, "default", false, "Device"),
            (2002, 7, "default", true, "Ghost"),
        ] {
            mysql.execute(
                "INSERT INTO kinds (id,user_id,kind,name,namespace,json,is_active) VALUES (?,?,?,?,?,?,?)",
                (id,owner,kind,"host-1",namespace,json!({"spec":{"deviceType":"app","appDeviceId":"host-1"}}).to_string(),active),
            ).await.unwrap();
        }
        let observed = ObservedMysql::new(mysql);
        let mut snapshot = crate::device_identity::DeviceIdentitySnapshot::load(
            &observed,
            vec![
                (7, "app-record-1001".into()),
                (7, "app-record-1004".into()),
                (7, "app-record-2000".into()),
                (7, "app-record-2001".into()),
                (7, "app-record-2002".into()),
                (8, "host-1".into()),
            ],
        ).await.unwrap();
        let reads = observed.take_reads();
        assert_eq!(reads.len(), 1);
        assert!(reads[0].0.contains("kinds.id IN"));
        assert_eq!(snapshot.device_count(), 2);
        assert_eq!(snapshot.resolve(7, "host-1"), "app-record-1001");
        assert_eq!(snapshot.resolve(8, "host-1"), "app-record-1004");
        assert_eq!(snapshot.resolve(7, "device-2"), "device-2");
        assert!(observed.take_reads().is_empty());
    }).await;
}
