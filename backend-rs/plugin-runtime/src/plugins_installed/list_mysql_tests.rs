// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real, disposable MySQL checks for the installed-plugin read path.
use super::test_support::{ObservedMysql, authenticated_list};
use crate::plugins_installed::test_support::{seed, with_database};
use serde_json::json;
use std::time::{Duration, Instant};

fn percentile(samples: &[Duration], percentage: usize) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    sorted[(sorted.len() * percentage).div_ceil(100) - 1].as_secs_f64() * 1000.0
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by the Rust CI job"]
async fn installed_list_mysql_contract_and_measurements() {
    with_database(|mysql| async move {
        seed(&mysql, 20).await;
        let observed = ObservedMysql::new(mysql);
        for device in [None, Some("host-1")] {
            let mut elapsed = Vec::new();
            let mut database_elapsed = Vec::new();
            // Prime connections and prepared statements outside the measurement.
            authenticated_list(&observed, device).await;
            observed.take_reads();
            for _ in 0..30 {
                let start = Instant::now();
                let body = authenticated_list(&observed, device).await;
                elapsed.push(start.elapsed());
                assert_eq!(body["items"].as_array().unwrap().len(), 20);
                assert_eq!(body["items"][0]["metadata"]["labels"]["id"], "20");
                for item in body["items"].as_array().unwrap() {
                    assert_eq!(item["spec"]["installState"], "installed");
                    assert_eq!(item["status"]["devices"].as_array().unwrap().len(), 3);
                }
                let reads = observed.take_reads();
                assert_eq!(reads.len(), 5, "the authenticated GET has a fixed SELECT budget");
                database_elapsed.push(reads.iter().map(|(_, time)| *time).sum());
                if elapsed.len() == 1 {
                    eprintln!("installed-list device={device:?} SELECT={}", reads.len());
                }
            }
            eprintln!(
                "installed-list device={device:?} n=30 concurrency=1 handler_p50_ms={:.3} handler_p95_ms={:.3} mysql_p50_ms={:.3} mysql_p95_ms={:.3}",
                percentile(&elapsed, 50), percentile(&elapsed, 95),
                percentile(&database_elapsed, 50), percentile(&database_elapsed, 95),
            );
        }
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by the Rust CI job"]
async fn installed_list_mysql_preserves_owner_filters_and_latest_alias_status() {
    with_database(|mysql| async move {
        seed(&mysql, 1).await;
        for (id, owner, namespace, active, kind) in [
            (2001, 8, "default", true, "Device"),
            (2002, 7, "other", true, "Device"),
            (2003, 7, "default", false, "Device"),
            (2004, 7, "default", true, "Ghost"),
        ] {
            mysql.execute(
                "INSERT INTO kinds (id,user_id,kind,name,namespace,json,is_active) VALUES (?,?,?,?,?,?,?)",
                (id, owner, kind, format!("foreign-{id}"), namespace,
                 json!({"spec": {"deviceType": "app", "appDeviceId": "host-1"}}).to_string(), active),
            ).await.unwrap();
        }
        let observed = ObservedMysql::new(mysql.clone());
        let mut snapshot = crate::device_identity::DeviceIdentitySnapshot::load(&observed, vec![(7, "host-1".into()), (8, "host-1".into()), (7, "host-1".into())]).await.unwrap();
        assert_eq!(observed.take_reads().len(), 1);
        assert_eq!(snapshot.device_count(), 4);
        assert_eq!(snapshot.resolve(7, "host-1"), "app-record-1001");
        assert_eq!(snapshot.resolve(8, "host-1"), "app-record-2001");
        assert_eq!(snapshot.resolve(9, "host-1"), "host-1");
        assert_eq!(snapshot.resolve(7, "foreign-2002"), "foreign-2002");
        assert_eq!(snapshot.resolve(7, "foreign-2003"), "foreign-2003");

        mysql.execute(
            "INSERT INTO plugin_device_installations (installed_kind_id,user_id,device_id,desired_release_id,actual_release_id,state,last_sync_at) VALUES (1,7,'app-record-1001',10,9,'installed','2026-11-17 00:00:00')", (),
        ).await.unwrap();
        let body = authenticated_list(&observed, Some("host-1")).await;
        assert_eq!(observed.take_reads().len(), 4, "the device mismatch skips marketplace lookup");
        assert_eq!(body["items"][0]["spec"]["installState"], "update_available");
        let devices = body["items"][0]["status"]["devices"].as_array().unwrap();
        assert_eq!(devices.len(), 3, "aliases coalesce and all devices remain visible");
        let current = devices.iter().find(|device| device["deviceId"] == "host-1").unwrap();
        assert_eq!(current["actualReleaseId"], 9);

        mysql.execute("UPDATE plugin_device_installations SET actual_release_id=0,state='failed' WHERE device_id='host-2'", ()).await.unwrap();
        let body = authenticated_list(&observed, Some("host-2")).await;
        assert_eq!(body["items"][0]["spec"]["installState"], "failed");
        assert_eq!(observed.take_reads().len(), 4);
    }).await;
}
