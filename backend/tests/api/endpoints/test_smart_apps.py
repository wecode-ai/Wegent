# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.api.endpoints import smart_apps
from app.services.marketplace_artifact_storage import MarketplaceArtifactStorageError


def test_init_submission_reports_storage_unavailable(monkeypatch) -> None:
    def fail_init(*_args, **_kwargs):
        raise MarketplaceArtifactStorageError("connection refused")

    monkeypatch.setattr(
        smart_apps.smart_app_marketplace_service,
        "init_submission",
        fail_init,
    )

    with pytest.raises(HTTPException) as raised:
        smart_apps.init_submission(
            request=Mock(),
            db=Mock(),
            current_user=SimpleNamespace(id=7),
        )

    assert raised.value.status_code == 503
    assert raised.value.detail == {
        "code": "smart_app_storage_unavailable",
        "message": "Smart app file storage is unavailable",
    }
