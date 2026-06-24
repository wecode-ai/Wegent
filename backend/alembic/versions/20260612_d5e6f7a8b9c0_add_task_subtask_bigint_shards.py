# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add task subtask bigint shards

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-06-12
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from wecode.config.task_sharding_config import task_sharding_settings

revision: str = "d5e6f7a8b9c0"
down_revision: Union[str, Sequence[str], None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SHARD_COUNT = task_sharding_settings.WECODE_TASK_SHARD_COUNT
TASK_SHARD_TABLES = tuple(f"tasks_{index:04d}" for index in range(SHARD_COUNT))
SUBTASK_SHARD_TABLES = tuple(f"subtasks_{index:04d}" for index in range(SHARD_COUNT))

TASK_ID_COLUMNS = (
    ("tasks", "id", False, "Primary key", None, True),
    ("resource_members", "resource_id", False, "Resource ID", None, None),
    (
        "resource_members",
        "copied_resource_id",
        False,
        "Copied resource ID (0 = not copied, for Task copy behavior)",
        "0",
        None,
    ),
    (
        "share_links",
        "resource_id",
        False,
        "Resource ID (kinds.id or tasks.id)",
        None,
        None,
    ),
    ("background_executions", "task_id", False, None, None, None),
    ("wiki_generations", "task_id", False, None, None, None),
    (
        "queue_messages",
        "source_task_id",
        False,
        "Original task/conversation ID",
        None,
        None,
    ),
    (
        "queue_messages",
        "process_task_id",
        False,
        "Task ID created for processing (0 = not processed)",
        None,
        None,
    ),
)

SUBTASK_ID_COLUMNS = (
    ("subtasks", "id", False, None, None, True),
    ("subtasks", "task_id", False, None, None, None),
    ("subtasks", "parent_id", True, None, None, None),
    ("subtasks", "reply_to_subtask_id", False, None, None, None),
    ("subtask_contexts", "subtask_id", False, None, None, None),
)


def _bigint() -> sa.BigInteger:
    return sa.BigInteger().with_variant(sa.Integer, "sqlite")


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table_name: str) -> set[str]:
    return {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns(table_name)
    }


def _alter_id_columns(
    columns: tuple[tuple[str, str, bool, str | None, str | None, bool | None], ...],
    type_: sa.types.TypeEngine,
    existing_type: sa.types.TypeEngine,
) -> None:
    existing_tables = _table_names()
    for (
        table_name,
        column_name,
        nullable,
        comment,
        server_default,
        autoincrement,
    ) in columns:
        if table_name not in existing_tables or column_name not in _column_names(
            table_name
        ):
            continue

        alter_kwargs = {
            "type_": type_,
            "existing_type": existing_type,
            "existing_nullable": nullable,
            "existing_comment": comment,
        }
        if server_default is not None:
            alter_kwargs["existing_server_default"] = server_default
        if autoincrement is not None:
            alter_kwargs["autoincrement"] = autoincrement

        if op.get_bind().dialect.name == "sqlite":
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.alter_column(column_name, **alter_kwargs)
        else:
            op.alter_column(table_name, column_name, **alter_kwargs)


def _create_task_shard(table_name: str) -> None:
    op.create_table(
        table_name,
        sa.Column("id", _bigint(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), nullable=False, default=0),
        sa.Column("kind", sa.String(length=50), nullable=False, default=""),
        sa.Column("name", sa.String(length=100), nullable=False, default=""),
        sa.Column(
            "namespace", sa.String(length=100), nullable=False, default="default"
        ),
        sa.Column("json", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Integer(), nullable=False, default=1),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False, default=0),
        sa.Column(
            "client_origin",
            sa.String(length=32),
            nullable=False,
            server_default="frontend",
        ),
        sa.Column("is_group_chat", sa.Boolean(), nullable=False, default=False),
        sa.UniqueConstraint(
            "user_id",
            "kind",
            "name",
            "namespace",
            name=f"uniq_{table_name}_user_kind_name_namespace",
        ),
        sqlite_autoincrement=True,
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(f"ix_{table_name}_user_id", table_name, ["user_id"])
    op.create_index(f"ix_{table_name}_kind", table_name, ["kind"])
    op.create_index(f"ix_{table_name}_created_at", table_name, ["created_at"])
    op.create_index(f"ix_{table_name}_project_id", table_name, ["project_id"])
    op.create_index(f"ix_{table_name}_is_group_chat", table_name, ["is_group_chat"])
    op.create_index(
        f"ix_{table_name}_user_origin_active_project",
        table_name,
        ["user_id", "client_origin", "is_active", "project_id"],
    )


def _create_subtask_shard(table_name: str) -> None:
    op.create_table(
        table_name,
        sa.Column("id", _bigint(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("task_id", _bigint(), nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("bot_ids", sa.JSON(), nullable=False),
        sa.Column(
            "role",
            sa.Enum("USER", "ASSISTANT", name=f"{table_name}_role"),
            nullable=False,
            default="ASSISTANT",
        ),
        sa.Column("executor_namespace", sa.String(length=100), nullable=True),
        sa.Column("executor_name", sa.String(length=100), nullable=True),
        sa.Column("executor_deleted_at", sa.Boolean(), nullable=False, default=False),
        sa.Column("prompt", sa.Text(), nullable=True),
        sa.Column("message_id", sa.Integer(), nullable=False, default=1),
        sa.Column("parent_id", _bigint(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "PENDING",
                "RUNNING",
                "COMPLETED",
                "FAILED",
                "CANCELLED",
                "DELETE",
                "PENDING_CONFIRMATION",
                name=f"{table_name}_status",
            ),
            nullable=False,
            default="PENDING",
        ),
        sa.Column("progress", sa.Integer(), nullable=False, default=0),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=False),
        sa.Column("sender_type", sa.String(length=20), nullable=False, default=""),
        sa.Column("sender_user_id", sa.Integer(), nullable=False, default=0),
        sa.Column("reply_to_subtask_id", _bigint(), nullable=False, default=0),
        sqlite_autoincrement=True,
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(f"ix_{table_name}_task_id", table_name, ["task_id"])
    op.create_index(f"ix_{table_name}_status", table_name, ["status"])
    op.create_index(f"ix_{table_name}_created_at", table_name, ["created_at"])


def _create_shard_tables() -> None:
    existing_tables = _table_names()
    for table_name in TASK_SHARD_TABLES:
        if table_name not in existing_tables:
            _create_task_shard(table_name)

    existing_tables = _table_names()
    for table_name in SUBTASK_SHARD_TABLES:
        if table_name not in existing_tables:
            _create_subtask_shard(table_name)


def upgrade() -> None:
    """Use BIGINT task identifiers and create task/subtask shard tables."""
    _alter_id_columns(TASK_ID_COLUMNS, _bigint(), sa.Integer())
    _alter_id_columns(SUBTASK_ID_COLUMNS, _bigint(), sa.Integer())
    _create_shard_tables()


def downgrade() -> None:
    """Drop shard tables and restore legacy integer task identifier columns."""
    existing_tables = _table_names()
    for table_name in reversed(SUBTASK_SHARD_TABLES):
        if table_name in existing_tables:
            op.drop_table(table_name)

    existing_tables = _table_names()
    for table_name in reversed(TASK_SHARD_TABLES):
        if table_name in existing_tables:
            op.drop_table(table_name)

    _alter_id_columns(SUBTASK_ID_COLUMNS, sa.Integer(), _bigint())
    _alter_id_columns(TASK_ID_COLUMNS, sa.Integer(), _bigint())
