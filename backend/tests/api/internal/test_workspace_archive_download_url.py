# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.endpoints.internal.workspace_archives import (
    get_workspace_archive_download_url,
)


def _task(storage_key: str | None = "workspace-archives/1/archive.tar.gz"):
    archive = {"storageKey": storage_key} if storage_key else None
    return SimpleNamespace(
        id=1,
        json={
            "status": {
                "archive": archive,
            }
        },
    )


@pytest.mark.asyncio
async def test_download_url_uses_task_archive_storage_key(monkeypatch):
    monkeypatch.setattr(
        "app.api.endpoints.internal.workspace_archives._get_active_task",
        lambda db, task_id: _task(),
    )
    monkeypatch.setattr(
        "app.api.endpoints.internal.workspace_archives.archive_storage_service.generate_download_url",
        lambda storage_key: f"https://minio.local/{storage_key}",
    )

    response = await get_workspace_archive_download_url(task_id=1, db=object())

    assert response.storage_key == "workspace-archives/1/archive.tar.gz"
    assert response.download_url == (
        "https://minio.local/workspace-archives/1/archive.tar.gz"
    )


@pytest.mark.asyncio
async def test_download_url_rejects_mismatched_storage_key(monkeypatch):
    monkeypatch.setattr(
        "app.api.endpoints.internal.workspace_archives._get_active_task",
        lambda db, task_id: _task(),
    )

    with pytest.raises(HTTPException) as exc:
        await get_workspace_archive_download_url(
            task_id=1,
            storage_key="workspace-archives/other/archive.tar.gz",
            db=object(),
        )

    assert exc.value.status_code == 403
    assert exc.value.detail == "archive_storage_key_mismatch"
