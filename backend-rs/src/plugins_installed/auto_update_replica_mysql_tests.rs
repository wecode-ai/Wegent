// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real primary/replica routing checks on the existing auto-update MySQL fixture.

use super::*;
use anyhow::{Context, Result, ensure};
use brz_redis::{Redis, cmd};

const KEY: &str = "wegent:plugin-write:7";
const BARRIER: &str = "wegent:plugin-write-test:replication-barrier";

struct Replica {
    reader: RedisService,
    routed: RedisService,
    primary_address: String,
}

impl Replica {
    async fn connect() -> Result<Self> {
        let writer = std::env::var("WEGENT_TEST_REDIS_ADDRESS")?;
        let reader = std::env::var("WEGENT_TEST_REDIS_REPLICA_ADDRESS")?;
        ensure!(
            reader.starts_with("127.0.0.1:"),
            "replica must use loopback"
        );
        ensure!(
            writer != reader,
            "reader and writer must be distinct servers"
        );
        let primary_address = std::env::var("WEGENT_TEST_REDIS_REPLICA_PRIMARY")?;
        Ok(Self {
            reader: RedisService::single_with_options(reader.clone(), fixture_redis_options())
                .await?,
            routed: RedisService::noshard_with_options(writer, [reader], fixture_redis_options())
                .await?,
            primary_address,
        })
    }

    async fn follow(&self, primary: &RedisService) -> Result<()> {
        self.master_auth("").await?;
        let (host, port) = self
            .primary_address
            .rsplit_once(':')
            .context("primary host:port")?;
        let mut command = cmd("REPLICAOF");
        command.arg(host).arg(port);
        let _: String = self.reader.command(command).await?;
        self.synchronize(primary).await
    }

    async fn synchronize(&self, primary: &RedisService) -> Result<()> {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_nanos()
            .to_string();
        primary.set(BARRIER, marker.as_str()).await?;
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let info = self.replication_info().await?;
                if info.contains("master_link_status:up")
                    && info.contains("master_sync_in_progress:0")
                    && self.reader.get::<_, String>(BARRIER).await?.as_deref()
                        == Some(marker.as_str())
                {
                    return Ok::<_, anyhow::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await??;
        Ok(())
    }

    async fn freeze(&self, primary: &RedisService, owner: Option<&str>) -> Result<()> {
        self.synchronize(primary).await?;
        ensure!(self.routed.get::<_, String>(KEY).await?.as_deref() == owner);
        // Fail the real replication reconnect while preserving the replica's
        // synchronized dataset and its existing primary. No Redis replies are mocked.
        self.master_auth("replication-paused-for-fixture").await?;
        let mut command = cmd("CLIENT");
        command.arg("KILL").arg("TYPE").arg("master");
        let _: i64 = self.reader.command(command).await?;
        self.assert_frozen(owner).await
    }

    async fn assert_frozen(&self, owner: Option<&str>) -> Result<()> {
        let info = self.replication_info().await?;
        ensure!(
            info.contains("role:slave"),
            "reader must remain a real replica"
        );
        ensure!(
            info.contains("master_link_status:down"),
            "replication must be paused"
        );
        ensure!(self.routed.get::<_, String>(KEY).await?.as_deref() == owner);
        Ok(())
    }

    async fn replication_info(&self) -> Result<String> {
        let mut command = cmd("INFO");
        command.arg("replication");
        Ok(self.reader.command(command).await?)
    }

    async fn master_auth(&self, value: &str) -> Result<()> {
        let mut command = cmd("CONFIG");
        command.arg("SET").arg("masterauth").arg(value);
        let _: String = self.reader.command(command).await?;
        Ok(())
    }

    async fn clean(&self, primary: &RedisService) -> Result<()> {
        self.master_auth("").await?;
        let mut command = cmd("REPLICAOF");
        command.arg("NO").arg("ONE");
        let _: String = self.reader.command(command).await?;
        let _: i64 = primary.del_many([KEY, BARRIER]).await?;
        let _: i64 = self.reader.del_many([KEY, BARRIER]).await?;
        Ok(())
    }
}

pub(super) async fn verify(mysql: &MysqlService, primary: &RedisService) -> Result<()> {
    let replica = Replica::connect().await?;
    let result = async {
        for owner in [None, Some("previous-owner")] {
            verify_current_owner(mysql, primary, &replica, owner).await?;
        }
        verify_replaced_owner(mysql, primary, &replica).await
    }
    .await;
    let cleanup = replica.clean(primary).await;
    result?;
    cleanup
}

async fn reset_installation(mysql: &MysqlService) -> MysqlResult<()> {
    mysql
        .execute("UPDATE plugins SET visibility='public' WHERE id=1", ())
        .await?;
    mysql
        .execute(
            "UPDATE kinds SET json=JSON_SET(json,'$.spec.releaseId',1) WHERE id=1 \
         AND user_id=7 AND kind='InstalledPlugin' AND namespace='default' AND name='example'",
            (),
        )
        .await?;
    Ok(())
}

async fn persisted_state(mysql: &MysqlService) -> MysqlResult<(i64, i64)> {
    let release: i64 = mysql.fetch_one(
        "SELECT CAST(JSON_EXTRACT(json,'$.spec.releaseId') AS SIGNED) FROM kinds \
         WHERE id=1 AND user_id=7 AND kind='InstalledPlugin' AND namespace='default' AND name='example'",
        (),
    ).await?;
    let revision: i64 = mysql.fetch_one(
        "SELECT CAST(JSON_EXTRACT(json,'$.spec.revision') AS SIGNED) FROM kinds \
         WHERE user_id=7 AND kind='ConnectorAuthPolicy' AND namespace='plugin-auth' AND name='account'",
        (),
    ).await?;
    Ok((release, revision))
}

async fn verify_current_owner(
    mysql: &MysqlService,
    primary: &RedisService,
    replica: &Replica,
    stale_owner: Option<&str>,
) -> Result<()> {
    reset_installation(mysql).await?;
    replica.follow(primary).await?;
    let _: i64 = primary.del(KEY).await?;
    if let Some(owner) = stale_owner {
        primary.set_ex(KEY, 30, owner).await?;
    }
    replica.freeze(primary, stale_owner).await?;
    let _: i64 = primary.del(KEY).await?;
    let (_, revision) = persisted_state(mysql).await?;
    let updated = auto_update_batch(mysql, Some(&replica.routed), &registry(), 7).await?;
    ensure!(
        updated.updated_count == 1,
        "valid owner must complete the real batch write"
    );
    ensure!(
        persisted_state(mysql).await? == (2, revision + 1),
        "batch and policy must commit"
    );
    replica.assert_frozen(stale_owner).await?;
    ensure!(
        primary.get::<_, String>(KEY).await?.is_none(),
        "current owner must release its lease"
    );
    eprintln!(
        "real Redis replica regression passed: valid owner, stale reader present={}",
        stale_owner.is_some()
    );
    Ok(())
}

async fn verify_replaced_owner(
    mysql: &MysqlService,
    primary: &RedisService,
    replica: &Replica,
) -> Result<()> {
    reset_installation(mysql).await?;
    let installed = mysql
        .with_transaction(async |tx| list_installed_kinds(tx, 7).await)
        .await?;
    let catalog = load_auto_update_catalog(mysql, Some(primary), &registry(), 7, &installed)
        .await?
        .expect("fixture installation is eligible");
    replica.follow(primary).await?;
    let lease = PluginWriteLease::acquire(Some(&replica.routed), 7).await?;
    let token = primary
        .get::<_, String>(KEY)
        .await?
        .expect("primary owns the acquired lease");
    replica.freeze(primary, Some(&token)).await?;
    lease.verify_owned().await?;
    let before = persisted_state(mysql).await?;
    let result = mysql
        .with_transaction(async |tx| {
            write_before_replacement(tx, &catalog, &lease, primary, replica, &token).await
        })
        .await;
    let verification = lease.verify_owned().await;
    lease.release().await;
    let error = http_error(result.err().context("stale owner must not commit")?);
    ensure!(error.status() == brz_http_server::StatusCode::SERVICE_UNAVAILABLE);
    ensure!(error.detail_message() == Some("plugin_write_lease_lost"));
    ensure!(
        verification.is_err(),
        "stale owner must fail real ownership validation"
    );
    ensure!(
        persisted_state(mysql).await? == before,
        "installation and policy CAS must roll back"
    );
    ensure!(
        primary.get::<_, String>(KEY).await?.as_deref() == Some("successor"),
        "release must preserve the successor lease"
    );
    replica.assert_frozen(Some(&token)).await?;
    eprintln!(
        "real Redis replica regression passed: replaced owner rejected, MySQL rolled back, successor retained"
    );
    Ok(())
}

async fn write_before_replacement<T: MysqlTransaction>(
    transaction: &mut T,
    catalog: &AutoUpdateCatalog,
    lease: &PluginWriteLease<'_, RedisService>,
    primary: &RedisService,
    replica: &Replica,
    token: &str,
) -> MysqlResult<()> {
    let revision = lease.read_revision(transaction).await?;
    let installed = list_installed_kinds(transaction, 7).await?;
    assert_eq!(
        apply_auto_update_batch(transaction, catalog, &installed, 7)
            .await?
            .updated_count,
        1
    );
    let release: i64 = transaction.fetch_one(
        "SELECT CAST(JSON_EXTRACT(json,'$.spec.releaseId') AS SIGNED) FROM kinds \
         WHERE id=1 AND user_id=7 AND kind='InstalledPlugin' AND namespace='default' AND name='example'",
        (),
    ).await?;
    assert_eq!(release, 2, "the real UPDATE must precede lease replacement");
    primary
        .set_ex(KEY, 30, "successor")
        .await
        .map_err(|_| coordination_error("fixture Redis write failed"))?;
    let readable = replica
        .routed
        .get::<_, String>(KEY)
        .await
        .map_err(|_| coordination_error("fixture Redis read failed"))?;
    assert_eq!(
        readable.as_deref(),
        Some(token),
        "reader must retain the previous owner"
    );
    assert!(
        tokio::time::Instant::now() < lease.deadline,
        "ownership replacement must be rejected before the operation budget expires"
    );
    lease.commit_revision(transaction, revision).await
}
