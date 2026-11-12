"""Persist Runtime IM notification intents and delivery receipts.

Revision ID: a4d8e2f9c7b1
Revises: f3a7c9e1b2d4
"""

from alembic import op

revision = "a4d8e2f9c7b1"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE TABLE runtime_notification_deliveries (id VARCHAR(128) NOT NULL "
        "PRIMARY KEY, user_id BIGINT NOT NULL, payload JSON NOT NULL, status "
        "VARCHAR(16) NOT NULL DEFAULT 'pending', provider_result JSON NULL, attempts "
        "INTEGER UNSIGNED NOT NULL DEFAULT 0, next_attempt_at DATETIME(6) NOT NULL, "
        "lease_token VARCHAR(64) NULL, created_at DATETIME(6) NOT NULL, updated_at "
        "DATETIME(6) NOT NULL, INDEX ix_runtime_notification_due "
        "(status,next_attempt_at,id), INDEX ix_runtime_notification_user "
        "(user_id,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 "
        "COLLATE=utf8mb4_unicode_ci"
    )


def downgrade() -> None:
    op.drop_table("runtime_notification_deliveries")
