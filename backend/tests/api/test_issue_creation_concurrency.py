"""Request progress while a synchronous Issue transaction waits for a lock."""

import asyncio
from threading import Event
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.api.endpoints import deliveries
from app.schemas.delivery import LoopItemCreate


@pytest.mark.asyncio
async def test_issue_lock_wait_does_not_block_other_request_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = asyncio.get_running_loop()
    transaction_released = Event()
    project = SimpleNamespace(id=1, task_provider="internal", metadata_json={})
    user = SimpleNamespace(id=2)
    db = MagicMock()
    values = LoopItemCreate(title="Concurrent Issue")
    failure = HTTPException(status_code=422, detail="Assignee changed")
    monkeypatch.setattr(deliveries.cloud_project_service, "get", lambda *_: project)
    monkeypatch.setattr(
        deliveries, "_selected_event_automation_id", lambda *_args, **_kwargs: None
    )

    def create(*args: object) -> None:
        assert args == (db, project, user, values)
        # Another request releases its transaction on the same event loop.
        loop.call_soon_threadsafe(transaction_released.set)
        assert transaction_released.wait(
            timeout=2
        ), "Issue lock wait blocked request cleanup"
        raise failure

    monkeypatch.setattr(deliveries.loop_item_provider_router, "create", create)
    with pytest.raises(HTTPException) as rejected:
        await deliveries.create_loop_item(1, values, db, user)
    assert rejected.value is failure
