"""Add parent/root message ids for one-level comment reply threads.

Revision ID: a7b8c9d0e1f2
Revises: e3f4a5b6c7d8
"""

import sqlalchemy as sa

from alembic import op

revision = "a7b8c9d0e1f2"
down_revision = "e3f4a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {
        column["name"] for column in inspector.get_columns("project_chat_messages")
    }
    if "reply_to_message_id" not in columns:
        op.add_column(
            "project_chat_messages",
            sa.Column("reply_to_message_id", sa.String(length=64), nullable=True),
        )
    if "thread_root_message_id" not in columns:
        op.add_column(
            "project_chat_messages",
            sa.Column("thread_root_message_id", sa.String(length=64), nullable=True),
        )
    indexes = {
        index["name"] for index in inspector.get_indexes("project_chat_messages")
    }
    if "ix_project_chat_thread_order" not in indexes:
        op.create_index(
            "ix_project_chat_thread_order",
            "project_chat_messages",
            ["thread_root_message_id", "id"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    indexes = {
        index["name"] for index in inspector.get_indexes("project_chat_messages")
    }
    if "ix_project_chat_thread_order" in indexes:
        op.drop_index(
            "ix_project_chat_thread_order",
            table_name="project_chat_messages",
        )
    columns = {
        column["name"] for column in inspector.get_columns("project_chat_messages")
    }
    if "thread_root_message_id" in columns:
        op.drop_column("project_chat_messages", "thread_root_message_id")
    if "reply_to_message_id" in columns:
        op.drop_column("project_chat_messages", "reply_to_message_id")
