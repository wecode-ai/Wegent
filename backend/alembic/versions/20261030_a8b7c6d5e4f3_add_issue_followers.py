"""Persist per-user Issue subscriptions.

Revision ID: a8b7c6d5e4f3
Revises: f3a7c9e1b2d4
"""

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision = "a8b7c6d5e4f3"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    reporter = next(
        (
            column
            for column in inspector.get_columns("loop_items")
            if column["name"] == "reporter_user_id"
        ),
        None,
    )
    # MySQL commits DDL independently; resume after an interrupted revision.
    if reporter is None:
        op.add_column(
            "loop_items", sa.Column("reporter_user_id", sa.Integer(), nullable=True)
        )
    elif not isinstance(reporter["type"], sa.Integer) or not reporter["nullable"]:
        raise RuntimeError("Existing reporter_user_id must be a nullable integer")
    op.execute(
        "UPDATE loop_items SET reporter_user_id = created_by_user_id "
        "WHERE resource_type = 'task' AND reporter_user_id IS NULL"
    )
    if not inspector.has_table("issue_followers"):
        _create_followers()
    else:
        _validate_followers(sa.inspect(bind))
    if not any(
        index["name"] == "ix_issue_followers_user_issue"
        for index in sa.inspect(bind).get_indexes("issue_followers")
    ):
        op.create_index(
            "ix_issue_followers_user_issue", "issue_followers", ["user_id", "issue_id"]
        )


def _create_followers() -> None:
    op.create_table(
        "issue_followers",
        sa.Column("issue_id", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql"),
            nullable=False,
            server_default=sa.func.now(6),
        ),
        sa.ForeignKeyConstraint(["issue_id"], ["loop_items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("issue_id", "user_id"),
        sa.Index("ix_issue_followers_user_issue", "user_id", "issue_id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )


def _validate_followers(inspector: sa.Inspector) -> None:
    columns = {
        column["name"]: column for column in inspector.get_columns("issue_followers")
    }
    primary_key = inspector.get_pk_constraint("issue_followers")["constrained_columns"]
    foreign_keys = inspector.get_foreign_keys("issue_followers")
    if (
        not {"issue_id", "user_id", "created_at"}.issubset(columns)
        or set(primary_key) != {"issue_id", "user_id"}
        or any(
            columns[name]["nullable"] for name in ("issue_id", "user_id", "created_at")
        )
        or not any(
            key["constrained_columns"] == ["issue_id"]
            and key["referred_table"] == "loop_items"
            and key["referred_columns"] == ["id"]
            and key.get("options", {}).get("ondelete", "").upper() == "CASCADE"
            for key in foreign_keys
        )
    ):
        raise RuntimeError(
            "Existing issue_followers schema does not match this revision"
        )


def downgrade() -> None:
    op.drop_table("issue_followers")
    op.drop_column("loop_items", "reporter_user_id")
