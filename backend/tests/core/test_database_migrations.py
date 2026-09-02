# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for Backend database schema preparation."""

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.config import settings
from app.core.database_migrations import (
    RUNTIME_SCHEMA_READY_ENV,
    prepare_runtime_database_schema,
)


def test_prepare_runtime_database_schema_completes_before_marking_ready(
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(settings, "DB_AUTO_MIGRATE", True)
    monkeypatch.delenv(RUNTIME_SCHEMA_READY_ENV, raising=False)

    with patch("app.core.database_migrations.subprocess.run") as run:
        prepare_runtime_database_schema()

    run.assert_called_once_with(
        ["alembic", "upgrade", "head"],
        cwd=Path(__file__).resolve().parents[2],
        check=True,
    )
    assert os.environ[RUNTIME_SCHEMA_READY_ENV] == "1"


def test_prepare_runtime_database_schema_does_not_mark_failed_migration_ready(
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(settings, "DB_AUTO_MIGRATE", True)
    monkeypatch.delenv(RUNTIME_SCHEMA_READY_ENV, raising=False)

    with (
        patch(
            "app.core.database_migrations.subprocess.run",
            side_effect=RuntimeError("migration failed"),
        ),
        pytest.raises(RuntimeError, match="migration failed"),
    ):
        prepare_runtime_database_schema()

    assert RUNTIME_SCHEMA_READY_ENV not in os.environ


def test_prepare_runtime_database_schema_skips_automatic_production_migration(
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "DB_AUTO_MIGRATE", True)
    monkeypatch.delenv(RUNTIME_SCHEMA_READY_ENV, raising=False)

    with patch("app.core.database_migrations.subprocess.run") as run:
        prepare_runtime_database_schema()

    run.assert_not_called()
    assert RUNTIME_SCHEMA_READY_ENV not in os.environ
