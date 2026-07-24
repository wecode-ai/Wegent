# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.services.loop_items.service import LoopItemService
from app.stores.tasks import task_store


def test_validate_backend_task_uses_owned_active_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    get_active_task = Mock(return_value=object())
    monkeypatch.setattr(task_store, "get_active_task", get_active_task)

    LoopItemService._validate_backend_task(db, backend_task_id=42, user_id=7)

    get_active_task.assert_called_once_with(
        db,
        task_id=42,
        owner_user_id=7,
    )


def test_validate_backend_task_rejects_missing_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    monkeypatch.setattr(task_store, "get_active_task", Mock(return_value=None))

    with pytest.raises(HTTPException) as error:
        LoopItemService._validate_backend_task(db, backend_task_id=42, user_id=7)

    assert error.value.status_code == 404
    assert error.value.detail == "Task not found"
