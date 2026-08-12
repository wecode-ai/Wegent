# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for project workflow service modules."""

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException, status

from app.models.project_workflow import EPOCH_TIME


def _id() -> str:
    return uuid.uuid4().hex


def _iso(value: datetime) -> str:
    return value.replace(tzinfo=UTC).isoformat()


def _optional_text(value: str) -> str | None:
    return value or None


def _optional_iso(value: datetime) -> str | None:
    return None if value == EPOCH_TIME else _iso(value)


def _row_version(row: object, expected: int) -> None:
    if int(getattr(row, "version", 0)) != expected:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Resource was modified; reload it before saving",
        )
