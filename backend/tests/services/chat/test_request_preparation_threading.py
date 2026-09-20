# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression coverage for synchronous queries delaying unrelated requests."""

import asyncio
import threading
from unittest.mock import MagicMock

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.trigger import request_preparation, unified
from shared.models import ExecutionRequest
from shared.telemetry.context import get_request_id, request_context


@pytest.mark.parametrize("outcome", ["success", "error", "cancel"])
async def test_query_does_not_block_loop_and_session_closes_in_worker(
    monkeypatch, tmp_path, outcome
):
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    started = asyncio.Event()
    release = threading.Event()
    closed = threading.Event()
    engine = create_engine(f"sqlite:///{tmp_path / 'preparation.db'}")
    observed = {}

    class WorkerSession(Session):
        def __init__(self):
            observed["session_thread"] = threading.get_ident()
            super().__init__(bind=engine)

        def close(self):
            observed["close_thread"] = threading.get_ident()
            super().close()
            closed.set()

    @event.listens_for(engine, "before_cursor_execute")
    def slow_query(*_args):
        observed["query_thread"] = threading.get_ident()
        loop.call_soon_threadsafe(started.set)
        assert release.wait(5), "Event loop could not release the database query"

    class Builder:
        def __init__(self, db):
            self.db = db

        def build(self, **kwargs):
            observed["request_id"] = get_request_id()
            observed["task_json"] = kwargs["task"].json
            assert self.db.execute(text("SELECT 1")).scalar_one() == 1
            if outcome == "error":
                raise ValueError("model resolution failed")
            return ExecutionRequest(task_id=1, subtask_id=2)

    monkeypatch.setattr(request_preparation, "SessionLocal", WorkerSession)
    context_session = MagicMock()
    monkeypatch.setattr(unified, "SessionLocal", context_session)
    monkeypatch.setattr("app.services.execution.TaskRequestBuilder", Builder)
    task_json = {"metadata": {"labels": {}}, "spec": {"pending": "not committed"}}

    with request_context("request-thread-regression"):
        request_task = asyncio.create_task(
            unified.build_execution_request(
                task=TaskResource(id=1, json=task_json),
                assistant_subtask=Subtask(id=2),
                team=Kind(id=3),
                user=User(id=7),
                message="hello",
                device_id="device-1",
            )
        )
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        # Getting here while the SQL query waits proves the loop is responsive.
        assert not closed.is_set()
        assert observed["query_thread"] != loop_thread
        if outcome == "cancel":
            request_task.cancel()
            await asyncio.sleep(0)
            assert not request_task.done()
            assert not closed.is_set()
        release.set()
        if outcome == "cancel":
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(request_task, timeout=5)
        elif outcome == "error":
            with pytest.raises(ValueError, match="model resolution failed"):
                await asyncio.wait_for(request_task, timeout=5)
        else:
            result = await asyncio.wait_for(request_task, timeout=5)
            assert result.request_id == "request-thread-regression"
            assert result.device_id == "device-1"

        assert closed.is_set()
        assert observed["session_thread"] == observed["query_thread"]
        assert observed["close_thread"] == observed["query_thread"]
        assert observed["request_id"] == "request-thread-regression"
        assert observed["task_json"] == task_json
        if outcome != "success":
            context_session.assert_not_called()
    finally:
        release.set()
        if not request_task.done():
            request_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request_task
        engine.dispose()
