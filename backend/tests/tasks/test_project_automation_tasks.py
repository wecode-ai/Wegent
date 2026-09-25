# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for project automation Celery task entry points."""

import asyncio
from collections.abc import Coroutine
from typing import Any
from unittest.mock import AsyncMock, MagicMock


def test_due_scan_ignores_closed_process_event_loop(monkeypatch) -> None:
    from app.tasks import project_automation_tasks

    db = MagicMock()
    check_due = AsyncMock(return_value=3)
    monkeypatch.setattr(
        project_automation_tasks,
        "SessionLocal",
        MagicMock(return_value=db),
    )
    monkeypatch.setattr(
        project_automation_tasks.project_automation_service,
        "check_due",
        check_due,
    )

    closed_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(closed_loop)
    closed_loop.close()

    def run_in_process_loop(coro: Coroutine[Any, Any, Any]) -> Any:
        try:
            return asyncio.get_event_loop().run_until_complete(coro)
        except Exception:
            coro.close()
            raise

    monkeypatch.setattr(asyncio, "run", run_in_process_loop)

    try:
        assert project_automation_tasks.check_due_project_automations_sync() == 3
    finally:
        asyncio.set_event_loop(None)

    check_due.assert_awaited_once_with(db)
    db.rollback.assert_not_called()
    db.close.assert_called_once_with()
