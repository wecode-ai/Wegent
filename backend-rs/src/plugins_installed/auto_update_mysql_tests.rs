// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Explicit integration proof with disposable loopback MySQL 8 and Redis.
//! Set WEGENT_TEST_MYSQL_ADDRESS and WEGENT_TEST_REDIS_ADDRESS to
//! 127.0.0.1:PORT, then run cargo test auto_update_mysql_tests -- --ignored.

use super::*;
use brz_mysql::{MysqlError, MysqlService, MysqlTransaction};
use brz_redis::RedisService;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

const SCHEMA: &[&str] = &[
    r#"CREATE TABLE kinds (`id` BIGINT NOT NULL AUTO_INCREMENT, `user_id` BIGINT NOT NULL DEFAULT 0, `kind` VARCHAR(1000) NOT NULL DEFAULT '', `name` VARCHAR(1000) NOT NULL DEFAULT '', `namespace` VARCHAR(1000) NOT NULL DEFAULT '', `json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `is_active` BOOLEAN NOT NULL DEFAULT 0, `created_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `updated_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
    r#"CREATE TABLE plugins (`id` BIGINT NOT NULL DEFAULT 0, `catalog_namespace` VARCHAR(1000) NOT NULL DEFAULT '', `slug` VARCHAR(1000) NOT NULL DEFAULT '', `name` VARCHAR(1000) NOT NULL DEFAULT '', `display_name` VARCHAR(1000) NOT NULL DEFAULT '', `summary` VARCHAR(1000) NOT NULL DEFAULT '', `description_md` VARCHAR(1000) NOT NULL DEFAULT '', `listing_type` VARCHAR(1000) NOT NULL DEFAULT '', `source_type` VARCHAR(1000) NOT NULL DEFAULT '', `source_provider` VARCHAR(1000) NOT NULL DEFAULT '', `owner_user_id` BIGINT NOT NULL DEFAULT 0, `origin_plugin_id` BIGINT NOT NULL DEFAULT 0, `category` VARCHAR(1000) NOT NULL DEFAULT '', `keywords_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `interface_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `visibility` VARCHAR(1000) NOT NULL DEFAULT '', `allow_copy` BOOLEAN NOT NULL DEFAULT 0, `status` VARCHAR(1000) NOT NULL DEFAULT '', `latest_release_id` BIGINT NOT NULL DEFAULT 0, `featured_rank` BIGINT NOT NULL DEFAULT 0, `created_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `updated_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `published_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
    r#"CREATE TABLE plugin_releases (`id` BIGINT NOT NULL DEFAULT 0, `plugin_id` BIGINT NOT NULL DEFAULT 0, `version` VARCHAR(1000) NOT NULL DEFAULT '', `manifest_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `interface_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `release_notes` VARCHAR(1000) NOT NULL DEFAULT '', `storage_key` VARCHAR(1000) NOT NULL DEFAULT '', `sha256` VARCHAR(1000) NOT NULL DEFAULT '', `size_bytes` BIGINT NOT NULL DEFAULT 0, `status` VARCHAR(1000) NOT NULL DEFAULT '', `scan_status` VARCHAR(1000) NOT NULL DEFAULT '', `scan_report_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `created_by_user_id` BIGINT NOT NULL DEFAULT 0, `publication_revision_id` BIGINT NOT NULL DEFAULT 0, `source_commit_sha` VARCHAR(1000) NOT NULL DEFAULT '', `created_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `published_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
    r#"CREATE TABLE resource_members (`id` BIGINT NOT NULL DEFAULT 0, `resource_type` VARCHAR(1000) NOT NULL DEFAULT '', `resource_id` BIGINT NOT NULL DEFAULT 0, `entity_type` VARCHAR(1000) NOT NULL DEFAULT '', `entity_id` VARCHAR(1000) NOT NULL DEFAULT '', `entity_display_name` VARCHAR(1000) NOT NULL DEFAULT '', `user_id` BIGINT NOT NULL DEFAULT 0, `role` VARCHAR(1000) NOT NULL DEFAULT '', `status` VARCHAR(1000) NOT NULL DEFAULT '', `invited_by_user_id` BIGINT NOT NULL DEFAULT 0, `share_link_id` BIGINT NOT NULL DEFAULT 0, `reviewed_by_user_id` BIGINT NOT NULL DEFAULT 0, `reviewed_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `copied_resource_id` BIGINT NOT NULL DEFAULT 0, `requested_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `created_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `updated_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
    r#"CREATE TABLE namespace (`id` BIGINT NOT NULL DEFAULT 0, `name` VARCHAR(1000) NOT NULL DEFAULT '', `is_active` BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
];

fn registry() -> EntityResolvers<brz_redis::RedisService> {
    EntityResolvers::public(MysqlService::connect_lazy("mysql://unused@127.0.0.1/unused").unwrap())
}

#[tokio::test]
#[ignore = "requires disposable local MySQL 8 and Redis; creates and drops its own database/accounts"]
async fn writer_batch_preserves_rollback_and_rejects_stale_updates() {
    let address =
        std::env::var("WEGENT_TEST_MYSQL_ADDRESS").expect("set local MySQL fixture address");
    assert!(
        address.starts_with("127.0.0.1:"),
        "only an isolated loopback fixture is allowed"
    );
    let redis_address =
        std::env::var("WEGENT_TEST_REDIS_ADDRESS").expect("set local Redis fixture address");
    assert!(
        redis_address.starts_with("127.0.0.1:"),
        "only an isolated loopback Redis fixture is allowed"
    );
    let redis = RedisService::noshard_with_options(
        redis_address.clone(),
        [redis_address],
        brz_redis::RedisServiceOptions::default().with_timeout(Duration::from_secs(5)),
    )
    .await
    .unwrap();
    let admin =
        MysqlService::connect(format!("mysql://root@{address}/mysql?ssl-mode=disabled").as_str())
            .await
            .unwrap();
    let name = format!(
        "plugin_tx_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    admin
        .execute(format!("CREATE DATABASE {name}"), ())
        .await
        .unwrap();
    let writer = format!("{name}_w");
    let reader = format!("{name}_r");
    for user in [&writer, &reader] {
        admin
            .execute(
                format!("CREATE USER '{user}'@'%' IDENTIFIED BY 'fixture-only'"),
                (),
            )
            .await
            .unwrap();
    }
    admin
        .execute(format!("GRANT ALL ON {name}.* TO '{writer}'@'%'"), ())
        .await
        .unwrap();
    admin
        .execute(format!("GRANT SELECT ON {name}.* TO '{reader}'@'%'"), ())
        .await
        .unwrap();
    let write_url = format!("mysql://{writer}:fixture-only@{address}/{name}?ssl-mode=disabled");
    let read_url = format!("mysql://{reader}:fixture-only@{address}/{name}?ssl-mode=disabled");
    let mysql = MysqlService::connect_lazy_read_write_named_with_options(
        &write_url,
        &read_url,
        "plugin-test",
        brz_mysql::MysqlServiceOptions::default().with_query_timeout(Duration::from_secs(20)),
    )
    .unwrap();
    for sql in SCHEMA {
        mysql.execute(*sql, ()).await.unwrap();
    }
    mysql.execute("INSERT INTO kinds (id,user_id,kind,name,namespace,is_active,json) VALUES (1,7,'InstalledPlugin','example','default',1,?)", (serde_json::to_string(&serde_json::json!({"spec":{"pluginId":1,"releaseId":1,"updatePolicy":"auto","enabled":false,"componentStates":{"skills/example":false},"source":{"type":"marketplace"}}})).unwrap(),)).await.unwrap();
    mysql.execute("INSERT INTO plugins (id,owner_user_id,latest_release_id,status,visibility,catalog_namespace,name,slug,source_type) VALUES (1,99,2,'published','public','enterprise','example','example','marketplace')", ()).await.unwrap();
    for id in [1_i64, 2] {
        mysql.execute("INSERT INTO plugin_releases (id,plugin_id,version,status,scan_status,manifest_json) VALUES (?,1,?,'ready','passed',?)", (id,format!("1.0.{id}"), serde_json::to_string(&serde_json::json!({"components":{"skills":[{"name":"example"}]}})).unwrap())).await.unwrap();
    }
    let resolvers = registry();
    let result = async {
        assert_eq!(
            auto_update_batch(&mysql, Some(&redis), &resolvers, 8)
                .await?
                .updated_count,
            0
        );
        verify_rollback(&mysql, &redis, &resolvers).await?;
        verify_stale_batch(&mysql, &redis).await?;
        Ok::<_, MysqlError>(())
    }
    .await;
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE {name}"), ())
        .await
        .unwrap();
    for user in [&writer, &reader] {
        admin
            .execute(format!("DROP USER '{user}'@'%'"), ())
            .await
            .unwrap();
    }
    admin.close().await;
    result.unwrap();
}

async fn verify_rollback(
    mysql: &MysqlService,
    redis: &RedisService,
    resolvers: &EntityResolvers<brz_redis::RedisService>,
) -> MysqlResult<()> {
    let lease = PluginWriteLease::acquire(Some(redis), 7).await?;
    lease.ensure_policy(mysql).await?;
    let installed = mysql
        .with_transaction(async |tx| list_installed_kinds(tx, 7).await)
        .await?;
    let catalog = load_auto_update_catalog(mysql, Some(redis), resolvers, 7, &installed)
        .await?
        .expect("fixture installation is eligible");
    let failure: MysqlResult<()> = mysql.with_transaction(async |tx| {
            let revision = lease.read_revision(tx).await?;
            let installed = list_installed_kinds(tx, 7).await?;
            assert_eq!(apply_auto_update_batch(tx, &catalog, &installed, 7).await?.updated_count, 1);
            let id: i64 = tx.fetch_one("SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.releaseId')) AS SIGNED) FROM kinds WHERE id=1", ()).await?;
            assert_eq!(id, 2);
            lease.commit_revision(tx, revision).await?;
            Err(MysqlError::InvalidQuery { reason: "forced rollback after actual batch UPDATE".into() })
        }).await;
    lease.release().await;
    assert!(
        matches!(failure, Err(MysqlError::InvalidQuery { .. })),
        "expected injected rollback, got {failure:?}"
    );
    let id: i64 = mysql
        .fetch_one(
            "SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.releaseId')) AS SIGNED) FROM kinds WHERE id=1",
            (),
        )
        .await?;
    assert_eq!(id, 1, "failed batch must roll back UPDATE");
    let revision: i64 = mysql
        .fetch_one(
            "SELECT CAST(JSON_EXTRACT(json, '$.spec.revision') AS SIGNED) FROM kinds \
             WHERE user_id=7 AND kind='ConnectorAuthPolicy' AND namespace='plugin-auth' \
             AND name='account'",
            (),
        )
        .await?;
    assert_eq!(revision, 0, "failed batch must roll back the policy CAS");

    Ok(())
}

async fn verify_stale_batch(mysql: &MysqlService, redis: &RedisService) -> MysqlResult<()> {
    let installed = mysql
        .with_transaction(async |tx| list_installed_kinds(tx, 7).await)
        .await?;
    let catalog = load_auto_update_catalog(mysql, Some(redis), &registry(), 7, &installed)
        .await?
        .expect("fixture installation is eligible");
    let (snapshot_tx, snapshot_rx) = oneshot::channel();
    let (resume_tx, resume_rx) = oneshot::channel();
    let stale_mysql = mysql.clone();
    // Keep an ordinary snapshot open while the current lease holder commits.
    let stale = tokio::spawn(async move {
        stale_mysql
            .with_transaction(async |tx| {
                let installed = list_installed_kinds(tx, 7).await?;
                snapshot_tx.send(()).unwrap();
                resume_rx.await.unwrap();
                apply_auto_update_batch(tx, &catalog, &installed, 7).await
            })
            .await
    });
    snapshot_rx.await.unwrap();
    let current = auto_update_batch(mysql, Some(redis), &registry(), 7).await;
    resume_tx.send(()).unwrap();
    let stale_error = stale.await.unwrap().unwrap_err();
    assert_eq!(current?.updated_count, 1);
    assert_eq!(
        http_error(stale_error).detail_message(),
        Some("plugin_write_conflict"),
        "a stale snapshot must not overwrite a committed installation"
    );
    assert_eq!(
        auto_update_batch(mysql, Some(redis), &registry(), 7)
            .await?
            .updated_count,
        0,
        "the next batch must see the latest committed installed release"
    );
    let rows: Vec<InstalledKindRow> = mysql
        .fetch_all(format!("SELECT {KIND_COLUMNS} FROM kinds WHERE id=1"), ())
        .await?;
    let spec = installed_document(&rows[0]).unwrap();
    assert_eq!(spec.enabled, Some(serde_json::json!(false)));
    assert_eq!(
        spec.component_states,
        Some(serde_json::json!({"skills/example": false}))
    );
    mysql
        .execute("UPDATE plugins SET visibility='personal' WHERE id=1", ())
        .await?;
    mysql
        .execute(
            "UPDATE kinds SET json=JSON_SET(json,'$.spec.releaseId',1) WHERE id=1",
            (),
        )
        .await?;
    assert_eq!(
        auto_update_batch(mysql, Some(redis), &registry(), 7)
            .await?
            .updated_count,
        0,
        "a private plugin without matching grants must not auto-update"
    );

    Ok(())
}
