"""Add HTTP tool definitions to connector applications.

Revision ID: f8a9b0c1d2e3
Revises: e7f8a9b0c1d2
Create Date: 2026-07-20
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f8a9b0c1d2e3"
down_revision: Union[str, Sequence[str], None] = "e7f8a9b0c1d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(table_name: str) -> bool:
    return table_name in sa.inspect(op.get_bind()).get_table_names()


def _column_exists(table_name: str, column_name: str) -> bool:
    if not _table_exists(table_name):
        return False
    return any(
        column["name"] == column_name
        for column in sa.inspect(op.get_bind()).get_columns(table_name)
    )


def _column_nullable(table_name: str, column_name: str) -> bool:
    return next(
        (
            bool(column["nullable"])
            for column in sa.inspect(op.get_bind()).get_columns(table_name)
            if column["name"] == column_name
        ),
        False,
    )


def _fill_empty_http_tools() -> None:
    if op.get_bind().dialect.name == "sqlite":
        op.execute(
            "UPDATE connector_apps SET http_tools = json('[]') "
            "WHERE http_tools IS NULL"
        )
    else:
        op.execute(
            "UPDATE connector_apps SET http_tools = JSON_ARRAY() "
            "WHERE http_tools IS NULL"
        )


def upgrade() -> None:
    if _column_exists("connector_apps", "http_tools"):
        _fill_empty_http_tools()
        if op.get_bind().dialect.name != "sqlite" and _column_nullable(
            "connector_apps", "http_tools"
        ):
            op.alter_column(
                "connector_apps",
                "http_tools",
                existing_type=sa.JSON(),
                nullable=False,
            )
        return
    if op.get_bind().dialect.name == "sqlite":
        op.add_column(
            "connector_apps",
            sa.Column("http_tools", sa.JSON(), nullable=False, server_default="[]"),
        )
        with op.batch_alter_table("connector_apps") as batch_op:
            batch_op.alter_column("http_tools", server_default=None)
    else:
        op.add_column(
            "connector_apps", sa.Column("http_tools", sa.JSON(), nullable=True)
        )
        op.execute("UPDATE connector_apps SET http_tools = JSON_ARRAY()")
        op.alter_column(
            "connector_apps",
            "http_tools",
            existing_type=sa.JSON(),
            nullable=False,
        )


def downgrade() -> None:
    if _column_exists("connector_apps", "http_tools"):
        op.drop_column("connector_apps", "http_tools")
