# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import ast
import asyncio
import threading
from pathlib import Path
from typing import Any

import pytest

from app.api.ws import device_namespace
from app.api.ws.local_task_responses import LocalTaskResponsesHandler
from shared.models import EventType, ExecutionEvent


class _DirectAsyncSyncCallVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self._async_depth = 0
        self.calls: list[tuple[int, str]] = []

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._async_depth += 1
        self.generic_visit(node)
        self._async_depth -= 1

    def visit_Call(self, node: ast.Call) -> None:
        if (
            self._async_depth
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"model_dump", "parse"}
        ):
            self.calls.append((node.lineno, ast.unparse(node.func)))
        self.generic_visit(node)


def _parse_kwargs() -> dict[str, Any]:
    return {
        "task_id": 101,
        "subtask_id": 202,
        "message_id": 303,
        "event_type": "response.output_text.delta",
        "event_data": {"delta": "hello", "items": range(3)},
    }


@pytest.mark.asyncio
async def test_websocket_parser_materializes_event_off_event_loop() -> None:
    loop_thread = threading.get_ident()
    observed: dict[str, Any] = {}

    class Parser:
        def parse(self, **kwargs: Any) -> ExecutionEvent:
            observed["thread"] = threading.get_ident()
            observed["kwargs"] = kwargs
            with pytest.raises(RuntimeError, match="no running event loop"):
                asyncio.get_running_loop()
            return ExecutionEvent(
                type=EventType.CHUNK.value,
                task_id=kwargs["task_id"],
                subtask_id=kwargs["subtask_id"],
                content=kwargs["data"]["delta"],
                data={"items": list(kwargs["data"]["items"])},
            )

    handler = LocalTaskResponsesHandler(Parser())  # type: ignore[arg-type]

    event = await handler.parse_event(**_parse_kwargs())

    assert observed["thread"] != loop_thread
    assert observed["kwargs"] == {
        "task_id": 101,
        "subtask_id": 202,
        "message_id": 303,
        "event_type": "response.output_text.delta",
        "data": {"delta": "hello", "items": range(3)},
    }
    assert isinstance(event, ExecutionEvent)
    assert event.content == "hello"
    assert event.data == {"items": [0, 1, 2]}


@pytest.mark.asyncio
async def test_websocket_model_dump_runs_off_event_loop() -> None:
    loop_thread = threading.get_ident()

    class Model:
        def model_dump(self, **kwargs: Any) -> dict[str, Any]:
            assert threading.get_ident() != loop_thread
            return {"kwargs": kwargs}

    result = await device_namespace._dump_websocket_model(
        Model(),
        by_alias=True,
        exclude_none=True,
    )

    assert result == {"kwargs": {"by_alias": True, "exclude_none": True}}


@pytest.mark.asyncio
async def test_websocket_parser_propagates_worker_exception() -> None:
    loop_thread = threading.get_ident()

    class ParserFailure(RuntimeError):
        pass

    class Parser:
        def parse(self, **kwargs: Any) -> ExecutionEvent:
            assert threading.get_ident() != loop_thread
            raise ParserFailure("invalid response event")

    handler = LocalTaskResponsesHandler(Parser())  # type: ignore[arg-type]

    with pytest.raises(ParserFailure, match="invalid response event"):
        await handler.parse_event(**_parse_kwargs())


@pytest.mark.asyncio
async def test_websocket_parser_never_returns_lazy_result_to_event_loop() -> None:
    loop_thread = threading.get_ident()

    class Parser:
        def parse(self, **kwargs: Any) -> Any:
            assert threading.get_ident() != loop_thread
            return iter(
                [
                    ExecutionEvent(
                        type=EventType.CHUNK.value,
                        task_id=kwargs["task_id"],
                        subtask_id=kwargs["subtask_id"],
                    )
                ]
            )

    handler = LocalTaskResponsesHandler(Parser())  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="materialized ExecutionEvent"):
        await handler.parse_event(**_parse_kwargs())


@pytest.mark.asyncio
async def test_websocket_parser_cancellation_does_not_abandon_worker() -> None:
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    finished = asyncio.Event()
    release = threading.Event()
    worker_threads: list[int] = []

    class Parser:
        def parse(self, **kwargs: Any) -> ExecutionEvent:
            worker_threads.append(threading.get_ident())
            loop.call_soon_threadsafe(started.set)
            if not release.wait(timeout=5):
                raise TimeoutError("parser test release timed out")
            loop.call_soon_threadsafe(finished.set)
            return ExecutionEvent(
                type=EventType.CHUNK.value,
                task_id=kwargs["task_id"],
                subtask_id=kwargs["subtask_id"],
            )

    handler = LocalTaskResponsesHandler(Parser())  # type: ignore[arg-type]
    parse_task = asyncio.create_task(handler.parse_event(**_parse_kwargs()))
    await asyncio.wait_for(started.wait(), timeout=1)

    parse_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await parse_task
    assert not finished.is_set()

    release.set()
    await asyncio.wait_for(finished.wait(), timeout=1)
    event = await asyncio.wait_for(
        handler.parse_event(**_parse_kwargs()),
        timeout=1,
    )

    assert isinstance(event, ExecutionEvent)
    assert len(worker_threads) == 2
    assert worker_threads[0] == worker_threads[1]


def test_websocket_async_paths_never_call_sync_parser_or_model_dump_directly() -> None:
    backend_root = Path(__file__).resolve().parents[3]
    violations: list[str] = []
    for relative_path in (
        "app/api/ws/device_namespace.py",
        "app/api/ws/local_task_responses.py",
    ):
        path = backend_root / relative_path
        visitor = _DirectAsyncSyncCallVisitor()
        visitor.visit(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
        violations.extend(
            f"{relative_path}:{line}: {name}" for line, name in visitor.calls
        )

    assert violations == []
