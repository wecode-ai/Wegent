# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Normalize the MySQL ``loop_items`` table to its sentinel-value schema."""

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import sqlalchemy as sa
from sqlalchemy.engine import Connection


@dataclass(frozen=True)
class SentinelColumn:
    type_sql: str
    value_sql: str
    default_sql: str | None


MYSQL_LOOP_ITEM_SENTINEL_COLUMNS: dict[str, SentinelColumn] = {
    "cloud_project_id": SentinelColumn("VARCHAR(64)", "''", "''"),
    "parent_id": SentinelColumn("VARCHAR(64)", "''", "''"),
    "loop_item_id": SentinelColumn("VARCHAR(64)", "''", "''"),
    "delivery_id": SentinelColumn("VARCHAR(64)", "''", "''"),
    "public_id": SentinelColumn("VARCHAR(36)", "''", "''"),
    "project_key": SentinelColumn("VARCHAR(16)", "''", "''"),
    "name": SentinelColumn("VARCHAR(255)", "''", "''"),
    "title": SentinelColumn("VARCHAR(255)", "''", "''"),
    "storage_prefix": SentinelColumn("VARCHAR(512)", "''", "''"),
    "sequence_number": SentinelColumn("INTEGER", "0", "0"),
    "next_item_number": SentinelColumn("INTEGER", "1", "1"),
    "created_by_user_id": SentinelColumn("INTEGER", "0", "0"),
    "updated_by_user_id": SentinelColumn("INTEGER", "0", "0"),
    "assignee_user_id": SentinelColumn("INTEGER", "0", "0"),
    "user_id": SentinelColumn("INTEGER", "0", "0"),
    "added_by_user_id": SentinelColumn("INTEGER", "0", "0"),
    "source": SentinelColumn("VARCHAR(20)", "''", "''"),
    "status": SentinelColumn("VARCHAR(32)", "''", "''"),
    "priority": SentinelColumn("VARCHAR(20)", "''", "''"),
    "due_at": SentinelColumn(
        "DATETIME", "'1970-01-01 00:00:01'", "'1970-01-01 00:00:01'"
    ),
    "current_delivery_id": SentinelColumn("VARCHAR(64)", "''", "''"),
    "local_project_id": SentinelColumn("INTEGER", "0", "0"),
    "device_id": SentinelColumn("VARCHAR(100)", "''", "''"),
    "is_default": SentinelColumn("TINYINT(1)", "0", "0"),
    "task_user_id": SentinelColumn("INTEGER", "0", "0"),
    "task_id": SentinelColumn("VARCHAR(255)", "''", "''"),
    "task_title": SentinelColumn("VARCHAR(255)", "''", "''"),
    "backend_task_id": SentinelColumn("BIGINT", "0", "0"),
    "linked_by_user_id": SentinelColumn("INTEGER", "0", "0"),
    "linked_at": SentinelColumn(
        "DATETIME", "'1970-01-01 00:00:01'", "'1970-01-01 00:00:01'"
    ),
    "unlinked_at": SentinelColumn(
        "DATETIME", "'1970-01-01 00:00:01'", "'1970-01-01 00:00:01'"
    ),
    "path": SentinelColumn("VARCHAR(700)", "''", "''"),
    "kind": SentinelColumn("VARCHAR(32)", "''", "''"),
    "display_name": SentinelColumn("VARCHAR(255)", "''", "''"),
    "relative_path": SentinelColumn("VARCHAR(700)", "''", "''"),
    "object_key": SentinelColumn("VARCHAR(1400)", "''", "''"),
    "content_type": SentinelColumn("VARCHAR(255)", "''", "''"),
    "size_bytes": SentinelColumn("BIGINT", "0", "0"),
    "sha256": SentinelColumn("VARCHAR(64)", "''", "''"),
    "source_task_binding_id": SentinelColumn("VARCHAR(64)", "''", "''"),
    "source_task_snapshot": SentinelColumn("JSON", "JSON_OBJECT()", None),
    "markdown_object_key": SentinelColumn("VARCHAR(1024)", "''", "''"),
    "chat_object_key": SentinelColumn("VARCHAR(1024)", "''", "''"),
    "manifest_object_key": SentinelColumn("VARCHAR(1024)", "''", "''"),
    "metadata": SentinelColumn("JSON", "JSON_OBJECT()", None),
    "completed_at": SentinelColumn(
        "DATETIME", "'1970-01-01 00:00:01'", "'1970-01-01 00:00:01'"
    ),
    "delivered_at": SentinelColumn(
        "DATETIME", "'1970-01-01 00:00:01'", "'1970-01-01 00:00:01'"
    ),
    "deleted_at": SentinelColumn(
        "DATETIME", "'1970-01-01 00:00:01'", "'1970-01-01 00:00:01'"
    ),
}

MYSQL_LOOP_ITEM_FOREIGN_KEYS = {
    "cloud_project_id": ("loop_items", "id", "CASCADE"),
    "parent_id": ("loop_items", "id", "CASCADE"),
    "loop_item_id": ("loop_items", "id", "CASCADE"),
    "delivery_id": ("loop_items", "id", "CASCADE"),
    "local_project_id": ("projects", "id", "CASCADE"),
    "backend_task_id": ("tasks", "id", "SET NULL"),
}

MYSQL_LOOP_ITEM_UNIQUE_PROJECTIONS = {
    "unique_public_id": ("public_id", "VARCHAR(36)"),
    "unique_project_key": ("project_key", "VARCHAR(16)"),
    "unique_storage_prefix": ("storage_prefix", "VARCHAR(512)"),
}

MYSQL_LOOP_ITEM_UNIQUE_INDEXES = {
    "uniq_loop_items_public_id": "unique_public_id",
    "uniq_loop_items_project_key": "unique_project_key",
    "uniq_loop_items_storage_prefix": "unique_storage_prefix",
}

MYSQL_LOOP_ITEM_LOOKUP_INDEXES = {
    "idx_loop_items_loop_item_id": ("loop_item_id",),
    "idx_loop_items_delivery_id": ("delivery_id",),
    "idx_loop_items_local_project_id": ("local_project_id",),
    "idx_loop_items_backend_task_id": ("backend_task_id",),
}


def _quote(connection: Connection, identifier: str) -> str:
    return connection.dialect.identifier_preparer.quote_identifier(identifier)


def _comment_sql(comment: str | None) -> str:
    if comment is None:
        return ""
    escaped = comment.replace("\\", "\\\\").replace("'", "''")
    return f" COMMENT '{escaped}'"


def _column_definition(
    connection: Connection,
    name: str,
    spec: SentinelColumn,
    *,
    nullable: bool,
    comment: str | None,
) -> str:
    null_sql = "NULL DEFAULT NULL" if nullable else "NOT NULL"
    if not nullable and spec.default_sql is not None:
        null_sql += f" DEFAULT {spec.default_sql}"
    return (
        f"{_quote(connection, name)} {spec.type_sql} {null_sql}"
        f"{_comment_sql(comment)}"
    )


def _drop_mysql_foreign_keys(connection: Connection, inspector: sa.Inspector) -> None:
    for foreign_key in inspector.get_foreign_keys("loop_items"):
        columns = set(foreign_key.get("constrained_columns") or ())
        name = foreign_key.get("name")
        if name and columns.intersection(MYSQL_LOOP_ITEM_FOREIGN_KEYS):
            connection.exec_driver_sql(
                "ALTER TABLE `loop_items` DROP FOREIGN KEY " + _quote(connection, name)
            )


def _drop_direct_unique_indexes(
    connection: Connection, inspector: sa.Inspector
) -> None:
    unique_columns = {
        (source,) for source, _type in MYSQL_LOOP_ITEM_UNIQUE_PROJECTIONS.values()
    }
    indexes: dict[str, tuple[str, ...]] = {}
    for index in inspector.get_indexes("loop_items"):
        name = index.get("name")
        columns = tuple(
            column
            for column in (index.get("column_names") or ())
            if isinstance(column, str)
        )
        if index.get("unique") and isinstance(name, str):
            indexes[name] = columns
    for constraint in inspector.get_unique_constraints("loop_items"):
        name = constraint.get("name")
        columns = tuple(
            column
            for column in (constraint.get("column_names") or ())
            if isinstance(column, str)
        )
        if isinstance(name, str):
            indexes[name] = columns
    for name, columns in indexes.items():
        if columns in unique_columns:
            connection.exec_driver_sql(
                "ALTER TABLE `loop_items` DROP INDEX " + _quote(connection, name)
            )


def _backfill_mysql_sentinels(connection: Connection, column_names: set[str]) -> None:
    assignments = []
    predicates = []
    for name, spec in MYSQL_LOOP_ITEM_SENTINEL_COLUMNS.items():
        if name not in column_names:
            continue
        column = _quote(connection, name)
        assignments.append(f"{column} = COALESCE({column}, {spec.value_sql})")
        predicates.append(f"{column} IS NULL")
    if not assignments:
        return
    connection.exec_driver_sql(
        "UPDATE `loop_items` SET "
        + ", ".join(assignments)
        + " WHERE "
        + " OR ".join(predicates)
    )


def _alter_sentinel_columns(
    connection: Connection,
    columns: Sequence[Mapping[str, Any]],
    *,
    nullable: bool,
) -> None:
    definitions = []
    for column in columns:
        name = str(column["name"])
        spec = MYSQL_LOOP_ITEM_SENTINEL_COLUMNS.get(name)
        if spec is None or bool(column.get("nullable")) == nullable:
            continue
        comment = column.get("comment")
        definitions.append(
            "MODIFY COLUMN "
            + _column_definition(
                connection,
                name,
                spec,
                nullable=nullable,
                comment=comment if isinstance(comment, str) else None,
            )
        )
    if definitions:
        connection.exec_driver_sql("ALTER TABLE `loop_items` " + ", ".join(definitions))


def _ensure_unique_projections(
    connection: Connection,
    inspector: sa.Inspector,
) -> None:
    column_names = {column["name"] for column in inspector.get_columns("loop_items")}
    for generated, (source, type_sql) in MYSQL_LOOP_ITEM_UNIQUE_PROJECTIONS.items():
        if generated in column_names:
            continue
        connection.exec_driver_sql(
            f"ALTER TABLE `loop_items` ADD COLUMN {_quote(connection, generated)} "
            f"{type_sql} GENERATED ALWAYS AS "
            f"(NULLIF({_quote(connection, source)}, '')) VIRTUAL"
        )

    existing_names = {
        index["name"]
        for index in inspector.get_indexes("loop_items")
        if index.get("name")
    }
    existing_unique_columns = {
        tuple(index.get("column_names") or ())
        for index in inspector.get_indexes("loop_items")
        if index.get("unique")
    }
    for index_name, column_name in MYSQL_LOOP_ITEM_UNIQUE_INDEXES.items():
        if index_name in existing_names or (column_name,) in existing_unique_columns:
            continue
        connection.exec_driver_sql(
            f"CREATE UNIQUE INDEX {_quote(connection, index_name)} "
            f"ON `loop_items` ({_quote(connection, column_name)})"
        )


def _ensure_lookup_indexes(connection: Connection, inspector: sa.Inspector) -> None:
    existing_columns = {
        tuple(index.get("column_names") or ())
        for index in inspector.get_indexes("loop_items")
    }
    for index_name, columns in MYSQL_LOOP_ITEM_LOOKUP_INDEXES.items():
        if columns in existing_columns:
            continue
        column_sql = ", ".join(_quote(connection, column) for column in columns)
        connection.exec_driver_sql(
            f"CREATE INDEX {_quote(connection, index_name)} "
            f"ON `loop_items` ({column_sql})"
        )


def normalize_mysql_loop_items_schema(connection: Connection) -> None:
    """Converge nullable/FK MySQL tables to the production sentinel schema."""

    if connection.dialect.name != "mysql":
        return
    inspector = sa.inspect(connection)
    if "loop_items" not in inspector.get_table_names():
        return

    columns = inspector.get_columns("loop_items")
    nullable_columns = {
        str(column["name"])
        for column in columns
        if column.get("nullable")
        and str(column["name"]) in MYSQL_LOOP_ITEM_SENTINEL_COLUMNS
    }
    _drop_mysql_foreign_keys(connection, inspector)
    _drop_direct_unique_indexes(connection, inspector)
    _backfill_mysql_sentinels(connection, nullable_columns)
    _alter_sentinel_columns(connection, columns, nullable=False)

    refreshed = sa.inspect(connection)
    _ensure_unique_projections(connection, refreshed)
    _ensure_lookup_indexes(connection, refreshed)


def _drop_projection_indexes_and_columns(connection: Connection) -> None:
    inspector = sa.inspect(connection)
    projection_columns = set(MYSQL_LOOP_ITEM_UNIQUE_PROJECTIONS)
    index_names = {
        str(index["name"])
        for index in inspector.get_indexes("loop_items")
        if index.get("name")
        and projection_columns.intersection(index.get("column_names") or ())
    }
    for index_name in index_names:
        connection.exec_driver_sql(
            "ALTER TABLE `loop_items` DROP INDEX " + _quote(connection, index_name)
        )

    column_names = {column["name"] for column in inspector.get_columns("loop_items")}
    for column_name in MYSQL_LOOP_ITEM_UNIQUE_PROJECTIONS:
        if column_name in column_names:
            connection.exec_driver_sql(
                "ALTER TABLE `loop_items` DROP COLUMN "
                + _quote(connection, column_name)
            )


def _restore_nullable_constraint_values(connection: Connection) -> None:
    assignments = []
    string_columns = (
        "cloud_project_id",
        "parent_id",
        "loop_item_id",
        "delivery_id",
        "public_id",
        "project_key",
        "storage_prefix",
    )
    for name in string_columns:
        column = _quote(connection, name)
        assignments.append(f"{column} = NULLIF({column}, '')")
    for name in ("local_project_id", "backend_task_id"):
        column = _quote(connection, name)
        assignments.append(f"{column} = NULLIF({column}, 0)")
    connection.exec_driver_sql("UPDATE `loop_items` SET " + ", ".join(assignments))


def _restore_direct_unique_indexes(connection: Connection) -> None:
    inspector = sa.inspect(connection)
    unique_columns = {
        tuple(index.get("column_names") or ())
        for index in inspector.get_indexes("loop_items")
        if index.get("unique")
    }
    for source, _type in MYSQL_LOOP_ITEM_UNIQUE_PROJECTIONS.values():
        if (source,) in unique_columns:
            continue
        name = f"uq_loop_items_{source}"
        connection.exec_driver_sql(
            f"CREATE UNIQUE INDEX {_quote(connection, name)} "
            f"ON `loop_items` ({_quote(connection, source)})"
        )


def _restore_foreign_keys(connection: Connection) -> None:
    inspector = sa.inspect(connection)
    existing = {
        tuple(foreign_key.get("constrained_columns") or ())
        for foreign_key in inspector.get_foreign_keys("loop_items")
    }
    for column, (
        target_table,
        target_column,
        on_delete,
    ) in MYSQL_LOOP_ITEM_FOREIGN_KEYS.items():
        if (column,) in existing:
            continue
        name = f"fk_loop_items_{column}"
        connection.exec_driver_sql(
            f"ALTER TABLE `loop_items` ADD CONSTRAINT {_quote(connection, name)} "
            f"FOREIGN KEY ({_quote(connection, column)}) "
            f"REFERENCES {_quote(connection, target_table)} "
            f"({_quote(connection, target_column)}) ON DELETE {on_delete}"
        )


def restore_nullable_mysql_loop_items_schema(connection: Connection) -> None:
    """Restore the nullable/FK schema used before the convergence migration."""

    if connection.dialect.name != "mysql":
        return
    inspector = sa.inspect(connection)
    if "loop_items" not in inspector.get_table_names():
        return

    _drop_projection_indexes_and_columns(connection)
    columns = sa.inspect(connection).get_columns("loop_items")
    _alter_sentinel_columns(connection, columns, nullable=True)
    _restore_nullable_constraint_values(connection)
    _restore_direct_unique_indexes(connection)
    _restore_foreign_keys(connection)
