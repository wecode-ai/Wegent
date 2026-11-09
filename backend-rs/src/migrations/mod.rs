//! Native MySQL schema lifecycle using the existing Alembic revision identities.

use std::collections::BTreeSet;

use anyhow::{Context, Result, ensure};
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlService, MysqlTransaction};

mod assets;
mod collaboration;
mod data_changes;
pub mod graph;
mod legacy;
#[cfg(test)]
mod mysql_tests;
mod plugin_publication;
mod rows;
mod runtime_profiles;
mod schema_changes;

const VERSION_TABLE: &str =
    "CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)";

#[derive(FromMysqlRow)]
struct Name {
    name: String,
}

/// Backfills need a longer callback budget than ordinary HTTP queries.
pub fn connect(url: &str) -> brz_mysql::MysqlResult<MysqlService> {
    let options = crate::startup::mysql::pool_options()
        .with_max_connections(1)
        .with_query_timeout(std::time::Duration::from_secs(3600));
    MysqlService::connect_lazy_with_options(url, options)
}

pub async fn current(mysql: &MysqlService) -> Result<BTreeSet<String>> {
    let table: Option<Name> = mysql.fetch_optional(
        "SELECT CAST(TABLE_NAME AS CHAR) AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='alembic_version'", ()
    ).await?;
    if table.is_none() {
        return Ok(BTreeSet::new());
    }
    let rows: Vec<Name> = mysql
        .fetch_all("SELECT version_num AS name FROM alembic_version", ())
        .await?;
    Ok(rows.into_iter().map(|r| r.name).collect())
}

async fn is_fresh(mysql: &MysqlService) -> Result<bool> {
    let tables: Vec<Name> = mysql.fetch_all(
        "SELECT CAST(TABLE_NAME AS CHAR) AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()", ()
    ).await?;
    // Keep env.py's sentinel set: unrelated tables do not make a Wegent database.
    Ok(!tables.iter().any(|t| {
        ["alembic_version", "users", "kinds", "tasks", "namespaces"].contains(&t.name.as_str())
    }))
}

pub async fn upgrade(mysql: &MysqlService) -> Result<()> {
    let graph = graph::Graph::load()?;
    if is_fresh(mysql).await? {
        initialize(mysql, &graph).await?;
        return Ok(());
    }
    migrate(mysql, &graph, &graph.head, false).await
}

pub async fn downgrade(mysql: &MysqlService, target: &str) -> Result<()> {
    let graph = graph::Graph::load()?;
    migrate(mysql, &graph, target, true).await
}

async fn initialize(mysql: &MysqlService, graph: &graph::Graph) -> Result<()> {
    #[derive(serde::Deserialize)]
    struct Table {
        table: String,
        statements: Vec<String>,
    }
    #[derive(serde::Deserialize)]
    struct Schema {
        revision: String,
        tables: Vec<Table>,
    }
    let schema: Schema = serde_json::from_str(include_str!("../../migrations/schema.json"))?;
    ensure!(
        schema.revision == graph.head,
        "latest schema must be updated together with migration head"
    );
    let tables = schema.tables;
    let existing: Vec<Name> = mysql.fetch_all("SELECT CAST(TABLE_NAME AS CHAR) AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()", ()).await?;
    let existing: BTreeSet<_> = existing.into_iter().map(|r| r.name).collect();
    tracing::info!(head = graph.head, "initializing fresh MySQL schema");
    // DDL can implicitly commit. Never stamp until every table/index succeeded.
    mysql
        .with_transaction(async |tx| {
            for table in &tables {
                if existing.contains(&table.table) {
                    continue;
                }
                for statement in &table.statements {
                    tx.execute(statement, ()).await?;
                }
            }
            tx.execute(VERSION_TABLE, ()).await?;
            tx.execute(
                "INSERT INTO alembic_version (version_num) VALUES (?)",
                (graph.head.as_str(),),
            )
            .await?;
            Ok(())
        })
        .await
        .context("fresh MySQL schema initialization failed; version was not stamped")
}

async fn migrate(
    mysql: &MysqlService,
    graph: &graph::Graph,
    target: &str,
    down: bool,
) -> Result<()> {
    let heads = current(mysql).await?;
    let plan = if down && target == "-1" {
        ensure!(
            heads.len() == 1,
            "downgrade -1 requires one current revision"
        );
        vec![graph.get(heads.first().unwrap())?]
    } else if down {
        graph.downgrade(&heads, target)?
    } else {
        graph.upgrade(&heads, target)?
    };
    // Validate the entire plan before applying any changes.
    for revision in &plan {
        legacy::validate(revision, down)?;
    }
    let mut applied = graph.ancestors(&heads)?;
    for revision in plan {
        tracing::info!(
            revision = revision.revision,
            source = revision.source,
            down,
            "running MySQL migration"
        );
        let mut next = applied.clone();
        if down {
            next.remove(&revision.revision);
        } else {
            next.insert(revision.revision.clone());
        }
        let frontier = graph.frontier(&next)?;
        mysql
            .with_transaction(async |tx| {
                legacy::execute(tx, revision, down).await?;
                tx.execute(VERSION_TABLE, ()).await?;
                write_heads(tx, &heads_for(&applied, graph), &frontier).await?;
                Ok(())
            })
            .await
            .with_context(|| {
                format!(
                    "MySQL migration {} failed; inspect partial DDL before retrying",
                    revision.revision
                )
            })?;
        applied = next;
    }
    Ok(())
}

fn heads_for(applied: &BTreeSet<String>, graph: &graph::Graph) -> BTreeSet<String> {
    graph.frontier(applied).expect("validated revision graph")
}

async fn write_heads(
    tx: &mut impl MysqlTransaction,
    old: &BTreeSet<String>,
    new: &BTreeSet<String>,
) -> MysqlResult<()> {
    for id in old.difference(new) {
        tx.execute(
            "DELETE FROM alembic_version WHERE version_num=?",
            (id.as_str(),),
        )
        .await?;
    }
    for id in new.difference(old) {
        tx.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            (id.as_str(),),
        )
        .await?;
    }
    Ok(())
}

pub async fn status(mysql: &MysqlService) -> Result<()> {
    let graph = graph::Graph::load()?;
    let heads = current(mysql).await?;
    graph.ancestors(&heads)?;
    tracing::info!(current = ?heads, latest = graph.head, "MySQL migration status");
    Ok(())
}

pub async fn check(mysql: &MysqlService) -> Result<()> {
    let graph = graph::Graph::load()?;
    let heads = current(mysql).await?;
    ensure!(
        heads == BTreeSet::from([graph.head.clone()]),
        "database migration pending: current={heads:?}, latest={}",
        graph.head
    );
    Ok(())
}
