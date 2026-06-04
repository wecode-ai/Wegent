# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add installed plugin package storage

Revision ID: c4d5e6f7a8b9
Revises: b2c3d4e5f6a7
Create Date: 2026-06-04

"""

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, Sequence[str], None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Store uploaded plugin ZIP packages in the database."""
    bind = op.get_bind()
    binary_type = (
        mysql.MEDIUMBLOB() if bind.dialect.name == "mysql" else sa.LargeBinary()
    )
    op.create_table(
        "installed_plugin_packages",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind_id", sa.Integer(), nullable=False),
        sa.Column("binary_data", binary_type, nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("file_hash", sa.String(length=64), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["kind_id"], ["kinds.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("kind_id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
        sqlite_autoincrement=True,
    )
    op.create_index(
        op.f("ix_installed_plugin_packages_id"),
        "installed_plugin_packages",
        ["id"],
        unique=False,
    )
    _migrate_existing_files(bind)


def downgrade() -> None:
    """Remove uploaded plugin package storage."""
    op.drop_index(
        op.f("ix_installed_plugin_packages_id"),
        table_name="installed_plugin_packages",
    )
    op.drop_table("installed_plugin_packages")


def _migrate_existing_files(bind) -> None:
    """Move old filesystem plugin packages into the database when available."""
    kinds = sa.table(
        "kinds",
        sa.column("id", sa.Integer()),
        sa.column("kind", sa.String()),
        sa.column("json", sa.JSON()),
        sa.column("is_active", sa.Boolean()),
    )
    packages = sa.table(
        "installed_plugin_packages",
        sa.column("kind_id", sa.Integer()),
        sa.column("binary_data", sa.LargeBinary()),
        sa.column("file_size", sa.Integer()),
        sa.column("file_hash", sa.String()),
        sa.column("file_name", sa.String()),
        sa.column("created_at", sa.DateTime()),
        sa.column("updated_at", sa.DateTime()),
    )
    rows = bind.execute(
        sa.select(kinds.c.id, kinds.c.json).where(
            kinds.c.kind == "InstalledPlugin",
            kinds.c.is_active == sa.true(),
        )
    )
    root = Path("data/plugin_packages")
    now = datetime.now()
    for row in rows:
        payload = _json_payload(row.json)
        spec = payload.get("spec") if isinstance(payload, dict) else {}
        if not isinstance(spec, dict):
            continue
        package_ref = spec.get("packageRef") or {}
        if not isinstance(package_ref, dict):
            continue
        storage_key = package_ref.get("storageKey")
        if not isinstance(storage_key, str) or not storage_key:
            continue
        path = root / storage_key
        if not path.is_file():
            continue
        data = path.read_bytes()
        checksum = str(package_ref.get("checksum") or "")
        file_hash = checksum.removeprefix("sha256:")
        if not file_hash:
            import hashlib

            file_hash = hashlib.sha256(data).hexdigest()
        source_payload = spec.get("sourcePayload") or {}
        filename = (
            source_payload.get("filename") if isinstance(source_payload, dict) else None
        )
        bind.execute(
            packages.insert().values(
                kind_id=row.id,
                binary_data=data,
                file_size=len(data),
                file_hash=file_hash,
                file_name=filename or path.name,
                created_at=now,
                updated_at=now,
            )
        )


def _json_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}
