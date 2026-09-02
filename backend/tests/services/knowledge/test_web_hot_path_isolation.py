# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import ast
import asyncio
import inspect
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.core.bounded_executor import BoundedExecutorOverloaded
from app.services.knowledge import web_db


@pytest.mark.asyncio
async def test_knowledge_db_phase_owns_session_in_named_worker(monkeypatch) -> None:
    session = MagicMock()
    observed: dict[str, object] = {}
    monkeypatch.setattr(web_db.db_session, "SessionLocal", lambda: session)

    def operation(db, value: int) -> int:
        observed["db"] = db
        observed["thread"] = threading.current_thread().name
        return value + 1

    result = await web_db.run_knowledge_db_phase(operation, 4)

    assert result == 5
    assert observed["db"] is session
    assert str(observed["thread"]).startswith("wegent-db")
    session.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_knowledge_db_phase_waits_for_session_close_on_cancel(
    monkeypatch,
) -> None:
    session = MagicMock()
    started = threading.Event()
    release = threading.Event()
    monkeypatch.setattr(web_db.db_session, "SessionLocal", lambda: session)

    def operation(db) -> None:
        assert db is session
        started.set()
        assert release.wait(timeout=1)

    task = asyncio.create_task(web_db.run_knowledge_db_phase(operation))
    for _ in range(100):
        if started.is_set():
            break
        await asyncio.sleep(0.001)
    assert started.is_set()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()

    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    session.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_knowledge_db_phase_propagates_overload(monkeypatch) -> None:
    async def reject(*args, **kwargs):
        del args, kwargs
        raise BoundedExecutorOverloaded("full")

    monkeypatch.setattr(web_db, "run_sync_in_executor", reject)

    with pytest.raises(BoundedExecutorOverloaded, match="full"):
        await web_db.run_knowledge_db_phase(lambda db: db)


def test_async_knowledge_routes_never_accept_sync_sessions() -> None:
    root = Path(__file__).parents[3]
    route_files = (
        root / "app/api/endpoints/internal/rag.py",
        root / "app/api/endpoints/rag.py",
        root / "app/api/endpoints/knowledge.py",
        root / "app/api/endpoints/knowledge_artifacts.py",
        root / "app/api/endpoints/knowledge_open.py",
        root / "app/api/endpoints/web_scraper.py",
    )

    for path in route_files:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncFunctionDef):
                continue
            if not any(
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and decorator.func.attr in {"get", "post", "put", "patch", "delete"}
                for decorator in node.decorator_list
            ):
                continue
            argument_names = {argument.arg for argument in node.args.args}
            segment = ast.get_source_segment(source, node) or ""
            assert "db" not in argument_names, f"{path}:{node.name} accepts db"
            assert "Depends(get_db)" not in segment
            assert "SessionLocal" not in segment


def test_web_hot_paths_have_no_default_executor_calls() -> None:
    root = Path(__file__).parents[3]
    paths = (
        root / "app/api/endpoints/internal/rag.py",
        root / "app/api/endpoints/rag.py",
        root / "app/api/endpoints/knowledge.py",
        root / "app/api/endpoints/knowledge_artifacts.py",
        root / "app/api/endpoints/knowledge_open.py",
        root / "app/api/endpoints/web_scraper.py",
        root / "app/services/knowledge/orchestrator.py",
        root / "app/services/knowledge/protected_mediation.py",
        root / "app/services/rag/local_gateway.py",
        root / "app/services/rag/retrieval_service.py",
        root / "app/services/web_scraper",
    )
    forbidden = ("asyncio.to_thread", "run_in_executor(", "run_in_threadpool(")

    for path in paths:
        candidates = path.rglob("*.py") if path.is_dir() else (path,)
        for candidate in candidates:
            source = candidate.read_text(encoding="utf-8")
            for token in forbidden:
                assert token not in source, f"{candidate} contains {token}"

    from app.services.rag.retrieval_service import _build_local_query_executor

    assert "sync_runner=run_knowledge_io" in inspect.getsource(
        _build_local_query_executor
    )
