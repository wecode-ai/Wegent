//! MySQL operations ported from the historical Alembic revisions.

use anyhow::{Result, ensure};
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};

use super::graph::Revision;

pub fn validate(revision: &Revision, down: bool) -> Result<()> {
    let statements = if down {
        &revision.downgrade
    } else {
        &revision.upgrade
    };
    if let Some(steps) = statements {
        for sql in steps.iter().flat_map(|step| {
            step.sql
                .iter()
                .chain(step.when.iter().map(|condition| &condition.query))
        }) {
            ensure!(
                !sql.contains("%s") && !sql.contains("__[POSTCOMPILE_"),
                "unbound SQLAlchemy parameters in {}",
                revision.revision
            );
        }
    }
    ensure!(
        statements.is_some()
            || matches!(
                revision.revision.as_str(),
                "d1e2f3a4b5c6"
                    | "d5e6f7a8b9c0"
                    | "730e43eb7d0f"
                    | "f1a2b3c4d5e6"
                    | "a3b4c5d6e7f8"
                    | "8a4c1f2d9e70"
                    | "64356fbc03dd"
                    | "d47dd270f4b6"
                    | "e58ee381a7c2"
                    | "b8e2c4f6a901"
                    | "c2f8d4a6b901"
                    | "c9d4e7f1a2b3"
                    | "e6f1a2b3c4d5"
            ),
        "native migration {} is not registered",
        revision.revision
    );
    Ok(())
}

pub async fn execute(
    tx: &mut impl MysqlTransaction,
    revision: &Revision,
    down: bool,
) -> MysqlResult<()> {
    if down && revision.revision == "a9c1e3f5b702" {
        #[derive(FromMysqlRow)]
        struct Count {
            n: i64,
        }
        for table in ["plugin_local_sync_operations", "plugin_sync_outbox"] {
            let count: Count = tx
                .fetch_one(format!("SELECT COUNT(*) AS n FROM {table}"), ())
                .await?;
            if count.n != 0 {
                return Err(brz_mysql::MysqlError::InvalidQuery {
                    reason: "Drain and archive plugin local sync records before downgrade".into(),
                });
            }
        }
    }
    let statements = if down {
        &revision.downgrade
    } else {
        &revision.upgrade
    };
    if statements.is_none() {
        use super::{data_changes as data, schema_changes as schema};
        return match revision.revision.as_str() {
            "d1e2f3a4b5c6" => schema::members(tx, down).await,
            "d5e6f7a8b9c0" => schema::bigint_ids(tx, down).await,
            "730e43eb7d0f" => schema::wiki(tx).await,
            "f1a2b3c4d5e6" => schema::teams(tx).await,
            "a3b4c5d6e7f8" => schema::sentinels(tx).await,
            "8a4c1f2d9e70" => data::plugin_policy(tx, down).await,
            "64356fbc03dd" => data::workflows(tx, down).await,
            "d47dd270f4b6" => data::retrieval_key(tx, down).await,
            "c9d4e7f1a2b3" => data::codex(tx, down).await,
            "e6f1a2b3c4d5" => data::project_permissions(tx, down).await,
            "e58ee381a7c2" if down => super::runtime_profiles::downgrade(tx).await,
            "e58ee381a7c2" => super::runtime_profiles::upgrade(tx).await,
            "b8e2c4f6a901" if down => super::collaboration::downgrade(tx).await,
            "b8e2c4f6a901" => super::collaboration::upgrade(tx).await,
            "c2f8d4a6b901" => super::plugin_publication::execute(tx, down).await,
            _ => unreachable!("validated native migration"),
        };
    }
    for step in statements
        .as_ref()
        .expect("validated migration implementation")
    {
        if let Some(condition) = &step.when {
            #[derive(FromMysqlRow)]
            struct Count {
                n: i64,
            }
            let count: Count = tx.fetch_one(&condition.query, ()).await?;
            if (count.n != 0) != condition.nonzero {
                continue;
            }
        }
        for statement in &step.sql {
            if let Err(error) = tx.execute(statement, ()).await {
                if !step.warning {
                    return Err(error);
                }
                tracing::warn!(revision = revision.revision, %error, "optional historical migration step failed");
            }
        }
    }
    Ok(())
}
