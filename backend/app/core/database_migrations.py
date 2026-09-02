# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Database schema preparation shared by Backend process entrypoints."""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

RUNTIME_SCHEMA_READY_ENV = "WEGENT_RUNTIME_SCHEMA_READY"


def runtime_schema_is_ready() -> bool:
    """Return whether the runtime supervisor completed schema preparation."""
    return os.getenv(RUNTIME_SCHEMA_READY_ENV) == "1"


def prepare_runtime_database_schema() -> None:
    """Run development migrations before any supervisor-owned worker starts."""
    from app.core.config import settings

    if settings.ENVIRONMENT != "development" or not settings.DB_AUTO_MIGRATE:
        return
    if runtime_schema_is_ready():
        return

    backend_dir = Path(__file__).resolve().parents[2]
    logger.info("Running database migrations before Backend workers start...")
    subprocess.run(
        ["alembic", "upgrade", "head"],
        cwd=backend_dir,
        check=True,
    )
    os.environ[RUNTIME_SCHEMA_READY_ENV] = "1"
    logger.info("Database schema is ready for Backend workers")
