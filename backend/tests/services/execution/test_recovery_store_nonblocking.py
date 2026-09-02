# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Store-owned executor recovery boundaries."""

import asyncio
import threading
from unittest.mock import AsyncMock, patch

import pytest

from app.services.execution.recovery_service import (
    ExecutorRecoveryContext,
    ExecutorRecoveryOutcome,
    ExecutorRecoveryService,
)
from shared.models.execution import ExecutionRequest


async def _wait_for_thread(started: threading.Event) -> None:
    while not started.is_set():
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_store_recovery_load_and_persistence_do_not_block_event_loop() -> None:
    service = ExecutorRecoveryService()
    request = ExecutionRequest(task_id=22, subtask_id=11)
    context = ExecutorRecoveryContext(
        task_id=22,
        subtask_id=11,
        task_json={},
        previous_executor_name="old",
        previous_executor_namespace="default",
        executor_deleted_at=True,
        archive_available=False,
        archive_reason=None,
        prior_claude_session_evidence=False,
        subtask_error=None,
        task_error=None,
    )
    outcome = ExecutorRecoveryOutcome(
        executor_name="new",
        executor_namespace="default",
    )
    started = threading.Event()
    release = threading.Event()

    def blocking_load(*_args):
        started.set()
        release.wait()
        return context

    safety_release = threading.Timer(2, release.set)
    safety_release.start()
    try:
        with (
            patch.object(
                service,
                "_load_detached_context_sync",
                side_effect=blocking_load,
            ),
            patch.object(
                service,
                "recover_detached",
                new=AsyncMock(return_value=outcome),
            ) as recover_detached,
            patch.object(service, "_persist_recovered_executor_sync") as persist,
        ):
            recovery = asyncio.create_task(
                service.recover_from_store(
                    task_id=22,
                    subtask_id=11,
                    request=request,
                )
            )
            await asyncio.wait_for(_wait_for_thread(started), timeout=0.5)
            assert not recovery.done()
            release.set()
            assert await recovery == outcome
            recover_detached.assert_awaited_once_with(
                context=context,
                request=request,
            )
            persist.assert_called_once_with(11, "new", "default")
    finally:
        release.set()
        safety_release.cancel()
