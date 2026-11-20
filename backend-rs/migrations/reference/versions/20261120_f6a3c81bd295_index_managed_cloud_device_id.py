# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index cross-user managed cloud device identity lookups."""

from alembic import op
from sqlalchemy import text

revision = "f6a3c81bd295"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None

INDEX_NAME = "idx_kinds_cloud_device_id"
COLUMN_NAME = "cloud_device_id_key"


def _has_column() -> bool:
    return bool(
        op.get_bind().scalar(
            text(
                "SELECT COUNT(*) FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='kinds' "
                "AND COLUMN_NAME=:name"
            ),
            {"name": COLUMN_NAME},
        )
    )


def _has_index() -> bool:
    return bool(
        op.get_bind().scalar(
            text(
                "SELECT COUNT(*) FROM information_schema.STATISTICS "
                "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='kinds' "
                "AND INDEX_NAME=:name"
            ),
            {"name": INDEX_NAME},
        )
    )


def upgrade() -> None:
    """Add the virtual key and index used by cloud registration."""
    if op.get_bind().dialect.name != "mysql":
        return
    if not _has_column():
        op.execute(
            f"ALTER TABLE kinds ADD COLUMN {COLUMN_NAME} VARBINARY(400) "
            "GENERATED ALWAYS AS (LEFT(JSON_UNQUOTE(JSON_EXTRACT(json, "
            "'$.spec.cloudConfig.deviceId')), 100)) VIRTUAL, ALGORITHM=INPLACE, LOCK=NONE"
        )
    if not _has_index():
        op.execute(
            f"CREATE INDEX {INDEX_NAME} ON kinds "
            f"({COLUMN_NAME}, kind, namespace, is_active, user_id) "
            "ALGORITHM=INPLACE LOCK=NONE"
        )


def downgrade() -> None:
    """Drop the lookup key while preserving all device records."""
    if op.get_bind().dialect.name != "mysql":
        return
    if _has_index():
        op.execute(f"DROP INDEX {INDEX_NAME} ON kinds ALGORITHM=INPLACE LOCK=NONE")
    if _has_column():
        op.execute(
            f"ALTER TABLE kinds DROP COLUMN {COLUMN_NAME}, ALGORITHM=INPLACE, LOCK=NONE"
        )
