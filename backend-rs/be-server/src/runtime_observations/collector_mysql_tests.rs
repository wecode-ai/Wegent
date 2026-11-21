//! Exercise scheduler failure handling against the durable account ledger.
use anyhow::Result;
use serde_json::json;
use wegent_runtime_observations::test_support::{collect_account, command};

use super::job_state;

#[tokio::test]
#[ignore = "requires disposable WEGENT_TEST_MYSQL_ADDRESS; invoked by Backend Rust CI"]
async fn configuration_and_transport_failures_release_the_source_lease() -> Result<()> {
    crate::migrations::mysql_tests::isolated(verify).await
}

async fn verify(mysql: &brz_mysql::MysqlService) -> Result<()> {
    crate::migrations::upgrade(mysql).await?;
    let owner = 981003;
    mysql.execute("INSERT INTO users (id,user_name,password_hash,email,is_active,role,auth_source,preferences,git_info,created_at,updated_at) VALUES (?,'collector-failure-owner','unused','',1,'user','password','{}','{}',NOW(),NOW())", (owner,)).await?;
    for source_id in ["offline-device", "unregistered-device"] {
        let state = job_state(crate::app_test_support::app(mysql.clone()));
        let attached = command(mysql, owner, &json!({
            "action":"attach", "initialCheckpoint":{"cursor":17},
            "subscription":{
                "subscription_key":source_id,
                "device_id":source_id,"task_id":"original-task",
                "session":{"engine":"Codex","id":"original-thread"},
                "source":{"providerId":"documents","profile":"account","kind":"document",
                    "id":source_id,"name":"Release document","enabledAfter":"2026-11-15T00:00:00Z"},
                "match":{"/eventType":"document.updated"},"continuation":"Continue original work"
            }
        })).await?;
        assert!(!collect_account(&state, owner).await?, "{source_id}");
        let snapshot = command(mysql, owner, &json!({"action":"list"})).await?;
        let subscription = &snapshot["subscriptions"][attached["subscriptionId"].as_str().unwrap()];
        let observation =
            &snapshot["observations"][subscription["observationId"].as_str().unwrap()];
        assert_eq!(subscription["status"], "armed");
        assert_eq!(observation["errorCode"], "connection_host_unavailable");
        assert_eq!(observation["failureCount"], 1);
        assert!(observation["lease"].is_null());
        assert_eq!(observation["checkpoint"], json!({"cursor":17}));
        assert!(snapshot["deliveries"].as_object().unwrap().is_empty());
        assert!(
            command(mysql, owner, &json!({"action":"claim"})).await?["lease"].is_null(),
            "A failed source must respect its retry deadline instead of busy polling"
        );
    }
    Ok(())
}
