//! Historical revisions whose DDL depends on the database's existing structure.

use brz_mysql::{FromMysqlRow, MysqlError, MysqlResult, MysqlTransaction};

#[derive(FromMysqlRow)]
struct Count {
    n: i64,
}

pub(super) async fn column(
    tx: &mut impl MysqlTransaction,
    table: &str,
    name: &str,
) -> MysqlResult<bool> {
    let result: Count = tx.fetch_one("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?", (table, name)).await?;
    Ok(result.n != 0)
}

async fn index(tx: &mut impl MysqlTransaction, table: &str, name: &str) -> MysqlResult<bool> {
    let result: Count = tx.fetch_one("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?", (table, name)).await?;
    Ok(result.n != 0)
}

pub(super) fn ident(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

#[derive(FromMysqlRow)]
struct Unique {
    name: String,
    columns: String,
}

async fn unique(
    tx: &mut impl MysqlTransaction,
    table: &str,
    columns: &str,
) -> MysqlResult<Option<String>> {
    let rows: Vec<Unique> = tx.fetch_all("SELECT CAST(INDEX_NAME AS CHAR) AS name, CAST(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS CHAR) AS columns FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND NON_UNIQUE=0 AND INDEX_NAME<>'PRIMARY' GROUP BY INDEX_NAME", (table,)).await?;
    Ok(rows
        .into_iter()
        .find(|r| r.columns == columns)
        .map(|r| r.name))
}

async fn ensure_index(
    tx: &mut impl MysqlTransaction,
    table: &str,
    name: &str,
    columns: &str,
) -> MysqlResult<()> {
    if !index(tx, table, name).await? {
        tx.execute(
            format!(
                "CREATE INDEX {} ON {} ({columns})",
                ident(name),
                ident(table)
            ),
            (),
        )
        .await?;
    }
    Ok(())
}

async fn drop_index(tx: &mut impl MysqlTransaction, table: &str, name: &str) -> MysqlResult<()> {
    if index(tx, table, name).await? {
        tx.execute(
            format!("DROP INDEX {} ON {}", ident(name), ident(table)),
            (),
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn members(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    let old_columns = "resource_type,resource_id,user_id";
    let new_columns = "resource_type,resource_id,entity_type,entity_id";
    if !down {
        for (name, definition) in [
            (
                "entity_type",
                "VARCHAR(20) NOT NULL DEFAULT 'user' COMMENT 'Entity type: user, namespace'",
            ),
            (
                "entity_id",
                "VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Entity identifier: user_id for ''user'', external ID for others'",
            ),
        ] {
            if !column(tx, "resource_members", name).await? {
                tx.execute(
                    format!("ALTER TABLE resource_members ADD COLUMN {name} {definition}"),
                    (),
                )
                .await?;
            }
        }
        tx.execute(
            "UPDATE resource_members SET entity_id=CAST(user_id AS CHAR), entity_type='user'",
            (),
        )
        .await?;
        if !column(tx, "resource_members", "entity_display_name").await? {
            tx.execute("ALTER TABLE resource_members ADD COLUMN entity_display_name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Display name snapshot for entity-type members'", ()).await?;
        }
    } else {
        drop_index(tx, "resource_members", "idx_resource_members_entity").await?;
    }
    let (remove, add, name) = if down {
        (new_columns, old_columns, "uniq_resource_members")
    } else {
        (old_columns, new_columns, "uniq_resource_members_entity")
    };
    if let Some(name) = unique(tx, "resource_members", remove).await? {
        tx.execute(
            format!("ALTER TABLE resource_members DROP INDEX {}", ident(&name)),
            (),
        )
        .await?;
    }
    if unique(tx, "resource_members", add).await?.is_none() {
        tx.execute(
            format!("ALTER TABLE resource_members ADD CONSTRAINT {name} UNIQUE ({add})"),
            (),
        )
        .await?;
    }
    if down {
        for name in ["entity_display_name", "entity_id", "entity_type"] {
            if column(tx, "resource_members", name).await? {
                tx.execute(
                    format!("ALTER TABLE resource_members DROP COLUMN {name}"),
                    (),
                )
                .await?;
            }
        }
    } else {
        ensure_index(
            tx,
            "resource_members",
            "idx_resource_members_entity",
            "entity_type,entity_id,resource_type,status",
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn wiki(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    let legacy = unique(tx, "wiki_projects", "source_url").await?.ok_or_else(|| MysqlError::InvalidQuery {
        reason: "wiki_projects has no source_url unique constraint; refusing a partial code-wiki migration".into()
    })?;
    tx.execute("ALTER TABLE wiki_projects ADD COLUMN kind_id INTEGER NOT NULL DEFAULT '0' COMMENT 'Code wiki knowledge base built from this repository; 0 = none'", ()).await?;
    tx.execute(
        "CREATE INDEX ix_wiki_projects_kind_id ON wiki_projects (kind_id)",
        (),
    )
    .await?;
    tx.execute("ALTER TABLE wiki_projects ADD CONSTRAINT uq_wiki_projects_source_url_kind_id UNIQUE (source_url,kind_id)", ()).await?;
    tx.execute(
        format!("ALTER TABLE wiki_projects DROP INDEX {}", ident(&legacy)),
        (),
    )
    .await?;
    Ok(())
}

pub(super) async fn bigint_ids(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    let tasks = [
        (
            "tasks",
            "id",
            "NOT NULL AUTO_INCREMENT COMMENT 'Primary key'",
        ),
        (
            "resource_members",
            "resource_id",
            "NOT NULL COMMENT 'Resource ID'",
        ),
        (
            "resource_members",
            "copied_resource_id",
            "NOT NULL DEFAULT '0' COMMENT 'Copied resource ID (0 = not copied, for Task copy behavior)'",
        ),
        (
            "share_links",
            "resource_id",
            "NOT NULL COMMENT 'Resource ID (kinds.id or tasks.id)'",
        ),
        ("background_executions", "task_id", "NOT NULL"),
        ("wiki_generations", "task_id", "NOT NULL"),
        (
            "queue_messages",
            "source_task_id",
            "NOT NULL COMMENT 'Original task/conversation ID'",
        ),
        (
            "queue_messages",
            "process_task_id",
            "NOT NULL COMMENT 'Task ID created for processing (0 = not processed)'",
        ),
    ];
    let subtasks = [
        ("subtasks", "id", "NOT NULL AUTO_INCREMENT"),
        ("subtasks", "task_id", "NOT NULL"),
        ("subtasks", "parent_id", "NULL"),
        ("subtasks", "reply_to_subtask_id", "NOT NULL"),
        ("subtask_contexts", "subtask_id", "NOT NULL"),
    ];
    let groups = if down {
        [&subtasks[..], &tasks[..]]
    } else {
        [&tasks[..], &subtasks[..]]
    };
    let kind = if down { "INTEGER" } else { "BIGINT" };
    for group in groups {
        for (table, name, attributes) in group {
            if column(tx, table, name).await? {
                tx.execute(
                    format!("ALTER TABLE {table} MODIFY {name} {kind} {attributes}"),
                    (),
                )
                .await?;
            }
        }
    }
    Ok(())
}

#[derive(FromMysqlRow)]
struct ForeignKey {
    name: String,
    target: String,
    target_column: String,
    columns: String,
}

async fn foreign_keys(tx: &mut impl MysqlTransaction, table: &str) -> MysqlResult<Vec<ForeignKey>> {
    tx.fetch_all("SELECT CAST(CONSTRAINT_NAME AS CHAR) AS name, CAST(REFERENCED_TABLE_NAME AS CHAR) AS target, CAST(GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION) AS CHAR) AS target_column, CAST(GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) AS CHAR) AS columns FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL GROUP BY CONSTRAINT_NAME,REFERENCED_TABLE_NAME", (table,)).await
}

const EXECUTION_COLUMNS: &[(&str, &str, &str, &str, &str)] = &[
    (
        "loop_items",
        "assignee_team_id",
        "INTEGER",
        "fk_loop_items_assignee_team_id_kinds",
        "kinds",
    ),
    (
        "loop_item_executions",
        "team_id",
        "INTEGER",
        "fk_loop_item_executions_team_id_kinds",
        "kinds",
    ),
    (
        "loop_item_executions",
        "backend_task_id",
        "BIGINT",
        "fk_loop_item_executions_backend_task_id_tasks",
        "tasks",
    ),
];

pub(super) async fn teams(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    for &(table, name, kind, constraint, target) in EXECUTION_COLUMNS {
        let operation = if column(tx, table, name).await? {
            "MODIFY"
        } else {
            "ADD COLUMN"
        };
        tx.execute(
            format!("ALTER TABLE {table} {operation} {name} {kind} NULL"),
            (),
        )
        .await?;
        let existing = foreign_keys(tx, table)
            .await?
            .into_iter()
            .find(|fk| fk.columns == name && fk.target == target && fk.target_column == "id");
        if existing.as_ref().is_none_or(|fk| fk.name != constraint) {
            if let Some(fk) = existing {
                tx.execute(
                    format!("ALTER TABLE {table} DROP FOREIGN KEY {}", ident(&fk.name)),
                    (),
                )
                .await?;
            }
            tx.execute(format!("ALTER TABLE {table} ADD CONSTRAINT {constraint} FOREIGN KEY ({name}) REFERENCES {target} (id) ON DELETE SET NULL"), ()).await?;
        }
        if name == "assignee_team_id" {
            ensure_index(tx, table, "ix_loop_items_assignee_team_id", name).await?;
        }
    }
    ensure_index(
        tx,
        "loop_item_executions",
        "idx_exec_team_status",
        "team_id,status",
    )
    .await
}

pub(super) async fn sentinels(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    for &(table, name, kind, _, _) in EXECUTION_COLUMNS {
        for fk in foreign_keys(tx, table)
            .await?
            .into_iter()
            .filter(|fk| fk.columns == name)
        {
            tx.execute(
                format!("ALTER TABLE {table} DROP FOREIGN KEY {}", ident(&fk.name)),
                (),
            )
            .await?;
        }
        tx.execute(
            format!("UPDATE {table} SET {name}=0 WHERE {name} IS NULL"),
            (),
        )
        .await?;
        tx.execute(
            format!("ALTER TABLE {table} MODIFY {name} {kind} NOT NULL DEFAULT '0'"),
            (),
        )
        .await?;
    }
    Ok(())
}
