# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep IM channel lifecycles and callbacks free of synchronous loop work."""

from __future__ import annotations

import ast
import asyncio
import threading
from pathlib import Path

import pytest

from app.services.channels import manager as manager_module

APP_ROOT = Path(__file__).parents[2] / "app"
SCAN_ROOTS = (
    APP_ROOT / "services/channels",
    APP_ROOT / "services/im",
)
ORM_ARGUMENT_TYPES = {"Kind", "Session", "TaskResource", "User"}
SYNC_DB_CALLS = {
    "SessionLocal",
    "commit",
    "execute",
    "flush",
    "get_db_session",
    "query",
    "refresh",
    "rollback",
}
IMPLICIT_EXECUTOR_CALLS = {"run_in_threadpool", "to_thread"}
SYNC_DYNAMIC_PROPERTIES = {
    "default_model_name",
    "default_team_id",
    "user_mapping_config",
}
REMOVED_ASYNC_ENTRY_POINTS = {
    "append_message_to_task",
    "build_new_task_params",
    "resolve_existing_task_params",
    "resolve_user",
    "send_runtime_task_update",
    "send_task_switched",
}


def _paths() -> list[Path]:
    return [path for root in SCAN_ROOTS for path in sorted(root.rglob("*.py"))]


def _annotation_identifiers(annotation: ast.expr | None) -> set[str]:
    if annotation is None:
        return set()
    return {
        node.id if isinstance(node, ast.Name) else node.attr
        for node in ast.walk(annotation)
        if isinstance(node, (ast.Name, ast.Attribute))
    }


def _call_name(call: ast.Call) -> str:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return ""


def _is_response_attribute(node: ast.Attribute) -> bool:
    value = node.value
    return (
        isinstance(value, ast.Name)
        and value.id in {"response", "resp"}
        or isinstance(value, ast.Attribute)
        and value.attr == "response"
    )


def test_im_async_paths_accept_no_sync_session_or_orm_arguments() -> None:
    violations: list[str] = []
    for path in _paths():
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncFunctionDef):
                continue
            for argument in (
                *node.args.posonlyargs,
                *node.args.args,
                *node.args.kwonlyargs,
            ):
                identifiers = _annotation_identifiers(argument.annotation)
                if argument.arg == "db" or identifiers.intersection(ORM_ARGUMENT_TYPES):
                    violations.append(
                        f"{path.relative_to(APP_ROOT.parent)}:{argument.lineno} "
                        f"{node.name}({argument.arg})"
                    )

    assert violations == []


def test_im_async_paths_do_no_synchronous_db_codec_or_dynamic_config_work() -> None:
    violations: list[str] = []

    class AsyncBodyVisitor(ast.NodeVisitor):
        def __init__(self, path: Path, function_name: str) -> None:
            self.path = path
            self.function_name = function_name

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            del node

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            del node

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            del node

        def visit_Lambda(self, node: ast.Lambda) -> None:
            del node

        def _record(self, node: ast.AST, operation: str) -> None:
            violations.append(
                f"{self.path.relative_to(APP_ROOT.parent)}:{node.lineno} "
                f"{self.function_name} -> {operation}"
            )

        def visit_Call(self, node: ast.Call) -> None:
            name = _call_name(node)
            if name in SYNC_DB_CALLS | IMPLICIT_EXECUTOR_CALLS:
                self._record(node, name)
            if (
                name in {"loads", "dumps"}
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id
                in {
                    "json",
                    "orjson",
                    "ujson",
                    "yaml",
                }
            ):
                self._record(node, ast.unparse(node.func))
            if (
                isinstance(node.func, ast.Attribute)
                and node.func.attr == "json"
                and _is_response_attribute(node.func)
            ):
                self._record(node, "response.json()")
            self.generic_visit(node)

        def visit_Attribute(self, node: ast.Attribute) -> None:
            if node.attr in SYNC_DYNAMIC_PROPERTIES:
                self._record(node, node.attr)
            if node.attr == "text" and _is_response_attribute(node):
                self._record(node, "response.text")
            self.generic_visit(node)

    class AsyncFunctionVisitor(ast.NodeVisitor):
        def __init__(self, path: Path) -> None:
            self.path = path

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            visitor = AsyncBodyVisitor(self.path, node.name)
            for statement in node.body:
                visitor.visit(statement)
            self.generic_visit(node)

    for path in _paths():
        AsyncFunctionVisitor(path).visit(
            ast.parse(path.read_text(), filename=str(path))
        )

    assert violations == []


def test_removed_im_async_entry_points_stay_deleted() -> None:
    definitions = {
        node.name
        for path in _paths()
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path)))
        if isinstance(node, ast.AsyncFunctionDef)
    }

    assert definitions.isdisjoint(REMOVED_ASYNC_ENTRY_POINTS)


@pytest.mark.asyncio
async def test_channel_manager_db_load_cannot_block_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()

    def blocking_load() -> tuple[()]:
        entered.set()
        assert release.wait(timeout=2)
        return ()

    monkeypatch.setattr(
        manager_module,
        "_load_enabled_channels_sync",
        blocking_load,
    )
    manager_module.ChannelManager.reset_instance()
    manager = manager_module.ChannelManager()
    start_task = asyncio.create_task(manager.start_all_enabled())
    try:
        while not entered.is_set():
            await asyncio.sleep(0)
        ticks = 0
        for _ in range(5):
            await asyncio.sleep(0)
            ticks += 1
        assert ticks == 5
    finally:
        release.set()

    assert await start_task == 0
