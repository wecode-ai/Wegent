# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.models.delivery import LoopItem
from app.services import issue_workflow_start
from app.services.issue_workflow_start import issue_workflow_start_service


def _direct_workflow() -> dict:
    return {
        "version": 1,
        "definition_version": 1,
        "stage_mode": "dag",
        "advancement_policy": "manual",
        "execution_config": {
            "execution_device_id": "device-1",
            "model": "model-1",
            "workspace_binding": {"type": "standalone"},
        },
        "nodes": [
            {
                "id": "verify",
                "name": "Verify",
                "execution_mode": "robot",
                "depends_on": [],
                "required": True,
                "workspace_policy": "none",
                "automation_rule_id": None,
                "status": "ready",
            }
        ],
    }


@pytest.mark.asyncio
async def test_continuation_storage_does_not_block_loop_or_cross_session(
    monkeypatch,
) -> None:
    main_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []
    storage_started = threading.Event()
    release_storage = threading.Event()
    session_open = False
    item = SimpleNamespace(
        id="issue-1",
        cloud_project_id="project-1",
        metadata_json={"workflow": _direct_workflow()},
    )

    class _DB:
        def get(self, model, key):
            assert model is LoopItem
            assert key == "issue-1"
            worker_thread_ids.append(threading.get_ident())
            storage_started.set()
            release_storage.wait(timeout=2)
            return item

    @contextmanager
    def session_scope():
        nonlocal session_open
        session_open = True
        try:
            yield _DB()
        finally:
            session_open = False

    async def dispatch_direct(**kwargs):
        assert session_open is False
        assert threading.get_ident() == main_thread_id
        assert kwargs == {
            "project_id": "project-1",
            "item_id": "issue-1",
            "workflow_node_id": "verify",
            "user_id": 7,
        }
        return {"id": "run-1"}

    monkeypatch.setattr(issue_workflow_start, "get_db_session", session_scope)
    monkeypatch.setattr(
        issue_workflow_start.project_automation_service,
        "run_direct_workflow_node_nonblocking",
        AsyncMock(side_effect=dispatch_direct),
    )
    release_timer = threading.Timer(1, release_storage.set)
    release_timer.start()
    try:
        continuation = asyncio.create_task(
            issue_workflow_start_service.continue_ready_stages_nonblocking(
                item_id="issue-1",
                user_id=7,
                stage_ids={"verify"},
            )
        )
        assert await asyncio.to_thread(storage_started.wait, 0.5)
        await asyncio.sleep(0)
        assert release_storage.is_set() is False
        assert continuation.done() is False
        release_storage.set()
        assert await continuation == 1
    finally:
        release_storage.set()
        release_timer.cancel()

    assert worker_thread_ids
    assert set(worker_thread_ids) == {worker_thread_ids[0]}
    assert worker_thread_ids[0] != main_thread_id
    assert session_open is False
