"""Add the single-table project and task tree.

Revision ID: a6d94c3e5217
Revises: 051cd1f603d6
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "a6d94c3e5217"
down_revision: Union[str, None] = "051cd1f603d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bigint = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
    op.create_table(
        "loop_items",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("resource_type", sa.String(24), nullable=False),
        sa.Column(
            "project_space", sa.String(100), server_default="default", nullable=False
        ),
        sa.Column("cloud_project_id", sa.String(64), nullable=True),
        sa.Column("parent_id", sa.String(64), nullable=True),
        sa.Column("loop_item_id", sa.String(64), nullable=True),
        sa.Column("delivery_id", sa.String(64), nullable=True),
        sa.Column("public_id", sa.String(36), unique=True),
        sa.Column("project_key", sa.String(16), unique=True),
        sa.Column("name", sa.String(255)),
        sa.Column("title", sa.String(255)),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("storage_prefix", sa.String(512), unique=True),
        sa.Column("sequence_number", sa.Integer()),
        sa.Column("next_item_number", sa.Integer()),
        sa.Column("created_by_user_id", sa.Integer()),
        sa.Column("updated_by_user_id", sa.Integer()),
        sa.Column("assignee_user_id", sa.Integer()),
        sa.Column("user_id", sa.Integer()),
        sa.Column("added_by_user_id", sa.Integer()),
        sa.Column("source", sa.String(20)),
        sa.Column("status", sa.String(32)),
        sa.Column("priority", sa.String(20)),
        sa.Column("due_at", sa.DateTime()),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("current_delivery_id", sa.String(64)),
        sa.Column("local_project_id", sa.Integer()),
        sa.Column("device_id", sa.String(100)),
        sa.Column("is_default", sa.Boolean()),
        sa.Column("task_user_id", sa.Integer()),
        sa.Column("task_id", sa.String(255)),
        sa.Column("task_title", sa.String(255)),
        sa.Column("backend_task_id", bigint),
        sa.Column("linked_by_user_id", sa.Integer()),
        sa.Column("linked_at", sa.DateTime()),
        sa.Column("unlinked_at", sa.DateTime()),
        sa.Column("path", sa.String(700)),
        sa.Column("kind", sa.String(32)),
        sa.Column("display_name", sa.String(255)),
        sa.Column("relative_path", sa.String(700)),
        sa.Column("object_key", sa.String(1400)),
        sa.Column("content_type", sa.String(255)),
        sa.Column("size_bytes", bigint),
        sa.Column("sha256", sa.String(64)),
        sa.Column("source_task_binding_id", sa.String(64)),
        sa.Column("source_task_snapshot", sa.JSON()),
        sa.Column("markdown_object_key", sa.String(1024)),
        sa.Column("chat_object_key", sa.String(1024)),
        sa.Column("manifest_object_key", sa.String(1024)),
        sa.Column("metadata", sa.JSON()),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("completed_at", sa.DateTime()),
        sa.Column("delivered_at", sa.DateTime()),
        sa.ForeignKeyConstraint(
            ["cloud_project_id"], ["loop_items.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["parent_id"], ["loop_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["loop_item_id"], ["loop_items.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["delivery_id"], ["loop_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["local_project_id"], ["projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["backend_task_id"], ["tasks.id"], ondelete="SET NULL"),
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_loop_items_project_type",
        "loop_items",
        ["cloud_project_id", "resource_type"],
    )
    op.create_index(
        "idx_loop_items_parent_type",
        "loop_items",
        ["parent_id", "resource_type", "sort_order"],
    )
    op.create_index(
        "idx_loop_items_project_path", "loop_items", ["cloud_project_id", "path"]
    )
    op.create_index("ix_loop_items_resource_type", "loop_items", ["resource_type"])
    op.create_index("ix_loop_items_project_space", "loop_items", ["project_space"])


def downgrade() -> None:
    op.drop_table("loop_items")
