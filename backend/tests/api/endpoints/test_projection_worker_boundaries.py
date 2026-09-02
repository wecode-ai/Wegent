# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import threading
from typing import Any

import pytest

from app.api.endpoints import project_incoming_hooks
from app.api.endpoints.adapter import shells
from app.api.endpoints.internal import tables as internal_tables


@pytest.mark.asyncio
async def test_shell_status_projects_nested_checks_once_off_loop(monkeypatch) -> None:
    loop_thread = threading.get_ident()
    projection_threads: list[int] = []
    captured_update: dict[str, Any] = {}

    class Request:
        def model_dump(self, **kwargs: Any) -> dict[str, Any]:
            assert kwargs == {"mode": "python"}
            projection_threads.append(threading.get_ident())
            return {
                "status": "completed",
                "stage": "Done",
                "progress": 100,
                "valid": True,
                "checks": [{"name": "python", "status": "pass"}],
                "errors": None,
                "errorMessage": None,
                "executor_name": None,
            }

    async def update_status(validation_id: str, **kwargs: Any) -> bool:
        captured_update.update(validation_id=validation_id, **kwargs)
        return True

    monkeypatch.setattr(shells, "_update_validation_status", update_status)

    result = await shells.update_validation_status("validation-1", Request())

    assert result == {
        "status": "success",
        "message": "Validation status updated",
    }
    assert projection_threads == [projection_threads[0]]
    assert projection_threads[0] != loop_thread
    assert captured_update["checks"] == [{"name": "python", "status": "pass"}]


@pytest.mark.asyncio
async def test_internal_table_result_projection_runs_off_loop(monkeypatch) -> None:
    loop_thread = threading.get_ident()
    projection_thread: int | None = None

    class Result:
        def model_dump(self, **kwargs: Any) -> dict[str, Any]:
            nonlocal projection_thread
            assert kwargs == {}
            projection_thread = threading.get_ident()
            return {
                "field_schema": {"name": "string"},
                "records": [{"name": "Wegent"}],
                "total_count": 1,
            }

    class Service:
        async def query_table(self, request: object) -> Result:
            del request
            return Result()

    monkeypatch.setattr(internal_tables, "DataTableService", Service)
    request = internal_tables.InternalTableQueryRequest(
        provider="dingtalk",
        base_id="base-1",
        sheet_id_or_name="sheet-1",
        user_name="tester",
    )

    result = await internal_tables.query_table(request)

    assert result["records"] == [{"name": "Wegent"}]
    assert projection_thread is not None
    assert projection_thread != loop_thread


@pytest.mark.asyncio
async def test_incoming_receipt_validation_runs_off_loop(monkeypatch) -> None:
    loop_thread = threading.get_ident()
    validation_thread: int | None = None
    payload = {"accepted": True, "project_id": "project-1"}

    class Request:
        headers = {"content-type": "application/json", "x-event": "created"}

        async def body(self) -> bytes:
            return b'{"title":"Task"}'

    class Receipt:
        @classmethod
        def model_validate(cls, value: object, **kwargs: Any) -> object:
            nonlocal validation_thread
            assert kwargs == {}
            validation_thread = threading.get_ident()
            return value

    async def receive_nonblocking(*args: object) -> dict[str, object]:
        assert args == (
            "token-1",
            b'{"title":"Task"}',
            "application/json",
            Request.headers,
        )
        return payload

    monkeypatch.setattr(project_incoming_hooks, "ProjectIncomingReceipt", Receipt)
    monkeypatch.setattr(
        project_incoming_hooks.project_incoming_hook_service,
        "receive_nonblocking",
        receive_nonblocking,
    )

    result = await project_incoming_hooks.receive_project_incoming_hook(
        "token-1",
        Request(),
    )

    assert result is payload
    assert validation_thread is not None
    assert validation_thread != loop_thread
