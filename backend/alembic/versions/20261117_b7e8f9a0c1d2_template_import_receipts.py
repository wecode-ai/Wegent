"""Persist actor-owned template imports and transaction-owned resource receipts.

Revision ID: b7e8f9a0c1d2
Revises: b1c2d3e4f5a6
"""

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision = "b7e8f9a0c1d2"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    timestamp = sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")
    options = {
        "mysql_engine": "InnoDB",
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_bin",
    }
    op.create_table(
        "template_import_operations",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("project_id", sa.String(255), nullable=False),
        sa.Column("actor_user_id", sa.BigInteger(), nullable=False),
        sa.Column("protocol_version", sa.Integer(), nullable=False),
        sa.Column("intent_sha256", sa.CHAR(64), nullable=False),
        sa.Column(
            "intent_encrypted",
            sa.Text().with_variant(mysql.LONGTEXT(), "mysql"),
            nullable=False,
        ),
        sa.Column("manifest", sa.JSON(), nullable=False),
        sa.Column("created_at", timestamp, nullable=False),
        sa.Column("updated_at", timestamp, nullable=False),
        sa.UniqueConstraint(
            "actor_user_id",
            "project_id",
            "protocol_version",
            "intent_sha256",
            name="uq_template_import_identity",
        ),
        **options,
    )
    op.create_table(
        "template_import_receipts",
        sa.Column("operation_id", sa.String(64), primary_key=True),
        sa.Column("step_key", sa.String(200), primary_key=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("request_sha256", sa.CHAR(64), nullable=False),
        sa.Column("resource_id", sa.String(255), nullable=False),
        sa.Column("completed_at", timestamp, nullable=False),
        sa.ForeignKeyConstraint(
            ["operation_id"],
            ["template_import_operations.id"],
            name="fk_template_import_receipt_operation",
            ondelete="CASCADE",
        ),
        **options,
    )


def downgrade() -> None:
    op.drop_table("template_import_receipts")
    op.drop_table("template_import_operations")
