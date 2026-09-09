"""Store notification read state explicitly and satisfy database DDL rules.

Revision ID: b7d0e2f5a4c3
Revises: a6c9d1e4f3b2
"""

import sqlalchemy as sa

from alembic import op

revision = "b7d0e2f5a4c3"
down_revision = "a6c9d1e4f3b2"
branch_labels = None
depends_on = None

_COLUMNS = [
    ("id", sa.String(36), None, "Notification UUID"),
    ("user_id", sa.Integer(), "0", "Recipient user ID"),
    ("actor_user_id", sa.Integer(), "0", "Sender user ID"),
    ("kind", sa.String(64), "message", "Notification kind"),
    ("title", sa.String(256), "", "Notification title"),
    ("body", sa.Text(), None, "Notification body"),
    ("url", sa.String(2048), "", "Click destination; empty means no navigation"),
    ("payload", sa.JSON(), None, "Structured source context"),
    ("created_at", sa.DateTime(), sa.text("CURRENT_TIMESTAMP"), "Creation time in UTC"),
]


def upgrade() -> None:
    with op.batch_alter_table("wework_notifications") as batch_op:
        batch_op.add_column(
            sa.Column(
                "is_read",
                sa.Boolean(),
                nullable=False,
                server_default="0",
                comment="Read state: 0 unread, 1 read",
            ),
        )
        batch_op.add_column(
            sa.Column(
                "read_status_changed_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                comment="Read state transition time in UTC",
            ),
        )
    op.execute(
        "UPDATE wework_notifications SET "
        "is_read = CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, "
        "read_status_changed_at = COALESCE(read_at, created_at), "
        "url = COALESCE(url, '')"
    )
    with op.batch_alter_table("wework_notifications") as batch_op:
        for name, column_type, default, comment in _COLUMNS:
            batch_op.alter_column(
                name,
                existing_type=column_type,
                nullable=False,
                server_default=default,
                comment=comment,
            )
        batch_op.drop_column("read_at")
        batch_op.drop_index("ix_wework_notifications_inbox")
        batch_op.create_index(
            "idx_wework_notifications_inbox", ["user_id", "created_at", "id"]
        )
    if op.get_bind().dialect.name == "mysql":
        op.create_table_comment(
            "wework_notifications", "Persistent Wework inbox notifications"
        )


def downgrade() -> None:
    op.add_column(
        "wework_notifications", sa.Column("read_at", sa.DateTime(), nullable=True)
    )
    op.execute(
        "UPDATE wework_notifications SET "
        "read_at = CASE WHEN is_read = 1 THEN read_status_changed_at ELSE NULL END"
    )
    with op.batch_alter_table("wework_notifications") as batch_op:
        batch_op.drop_column("is_read")
        batch_op.drop_column("read_status_changed_at")
        for name, column_type, _, _ in _COLUMNS:
            batch_op.alter_column(
                name,
                existing_type=column_type,
                nullable=name == "url",
                server_default=None,
                comment=None,
            )
        batch_op.drop_index("idx_wework_notifications_inbox")
        batch_op.create_index(
            "ix_wework_notifications_inbox", ["user_id", "created_at", "id"]
        )
    op.execute("UPDATE wework_notifications SET url = NULL WHERE url = ''")
    if op.get_bind().dialect.name == "mysql":
        op.drop_table_comment("wework_notifications")
