# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add task and subtask bigint ids

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-06-12
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "d5e6f7a8b9c0"
down_revision: Union[str, Sequence[str], None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

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


def upgrade() -> None:
    """Use BIGINT task and subtask identifier columns."""
    _alter_id_columns(TASK_ID_COLUMNS, _bigint(), sa.Integer())
    _alter_id_columns(SUBTASK_ID_COLUMNS, _bigint(), sa.Integer())


def downgrade() -> None:
    """Restore legacy integer task and subtask identifier columns."""
    _alter_id_columns(SUBTASK_ID_COLUMNS, sa.Integer(), _bigint())
    _alter_id_columns(TASK_ID_COLUMNS, sa.Integer(), _bigint())
