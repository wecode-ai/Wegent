# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""ensure plugin packages reuse skill binaries

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-06-04

"""

import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence, Union

import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

revision: str = "d5e6f7a8b9c0"
down_revision: Union[str, Sequence[str], None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Repair databases that already ran the short-lived plugin package migration."""
    bind = op.get_bind()
    _add_column_if_missing(
        bind,
        "skill_binaries",
        sa.Column("type", sa.String(length=32), nullable=True),
    )
    _add_column_if_missing(
        bind,
        "skill_binaries",
        sa.Column("file_name", sa.String(length=255), nullable=True),
    )
    _migrate_existing_package_rows(bind)
    _migrate_existing_files(bind)
    _drop_legacy_plugin_package_table(bind)


def downgrade() -> None:
    """No-op; the previous migration owns the new skill_binaries columns."""


def _add_column_if_missing(bind, table_name: str, column: sa.Column) -> None:
    columns = {info["name"] for info in inspect(bind).get_columns(table_name)}
    if column.name not in columns:
        op.add_column(table_name, column)


def _table_exists(bind, table_name: str) -> bool:
    return inspect(bind).has_table(table_name)


def _migrate_existing_package_rows(bind) -> None:
    if not _table_exists(bind, "installed_plugin_packages"):
        return

    legacy_packages = sa.table(
        "installed_plugin_packages",
        sa.column("kind_id", sa.Integer()),
        sa.column("binary_data", sa.LargeBinary()),
        sa.column("file_size", sa.Integer()),
        sa.column("file_hash", sa.String()),
        sa.column("file_name", sa.String()),
    )
    skill_binaries = _skill_binaries_table()
    for row in bind.execute(sa.select(legacy_packages)):
        _upsert_plugin_binary(
            bind,
            skill_binaries=skill_binaries,
            kind_id=row.kind_id,
            binary_data=row.binary_data,
            file_size=row.file_size,
            file_hash=row.file_hash,
            file_name=row.file_name,
        )


def _migrate_existing_files(bind) -> None:
    kinds = sa.table(
        "kinds",
        sa.column("id", sa.Integer()),
        sa.column("kind", sa.String()),
        sa.column("json", sa.JSON()),
        sa.column("is_active", sa.Boolean()),
    )
    skill_binaries = _skill_binaries_table()
    rows = bind.execute(
        sa.select(kinds.c.id, kinds.c.json).where(
            kinds.c.kind == "InstalledPlugin",
            kinds.c.is_active == sa.true(),
        )
    )
    root = Path("data/plugin_packages")
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
        source_payload = spec.get("sourcePayload") or {}
        filename = (
            source_payload.get("filename") if isinstance(source_payload, dict) else None
        )
        _upsert_plugin_binary(
            bind,
            skill_binaries=skill_binaries,
            kind_id=row.id,
            binary_data=data,
            file_size=len(data),
            file_hash=_package_hash(package_ref, data),
            file_name=filename or path.name,
        )


def _drop_legacy_plugin_package_table(bind) -> None:
    if _table_exists(bind, "installed_plugin_packages"):
        op.drop_table("installed_plugin_packages")


def _skill_binaries_table() -> sa.TableClause:
    return sa.table(
        "skill_binaries",
        sa.column("kind_id", sa.Integer()),
        sa.column("binary_data", sa.LargeBinary()),
        sa.column("file_size", sa.Integer()),
        sa.column("file_hash", sa.String()),
        sa.column("type", sa.String()),
        sa.column("file_name", sa.String()),
        sa.column("created_at", sa.DateTime()),
    )


def _upsert_plugin_binary(
    bind,
    *,
    skill_binaries: sa.TableClause,
    kind_id: int,
    binary_data: bytes,
    file_size: int,
    file_hash: str,
    file_name: str | None,
) -> None:
    existing = bind.execute(
        sa.select(skill_binaries.c.kind_id).where(skill_binaries.c.kind_id == kind_id)
    ).first()
    values = {
        "binary_data": binary_data,
        "file_size": file_size,
        "file_hash": file_hash,
        "type": "plugin",
        "file_name": file_name,
    }
    if existing:
        bind.execute(
            skill_binaries.update()
            .where(skill_binaries.c.kind_id == kind_id)
            .values(**values)
        )
        return

    bind.execute(
        skill_binaries.insert().values(
            kind_id=kind_id,
            created_at=datetime.now(),
            **values,
        )
    )


def _package_hash(package_ref: dict[str, Any], data: bytes) -> str:
    checksum = str(package_ref.get("checksum") or "")
    file_hash = checksum.removeprefix("sha256:")
    return file_hash or hashlib.sha256(data).hexdigest()


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
