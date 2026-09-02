# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep direct Pydantic projection work out of Uvicorn async handlers."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

BACKEND_ROOT = Path(__file__).parents[2]
TARGET_ROOTS = (
    BACKEND_ROOT / "app/api/endpoints",
    BACKEND_ROOT / "app/api/ws",
    BACKEND_ROOT / "app/mcp_server",
)
DIRECT_MODEL_PROJECTIONS = {
    "model_dump",
    "model_dump_json",
    "model_validate",
}


@dataclass(frozen=True)
class _ProjectionCall:
    function: str
    line: int
    method: str


def _direct_async_projection_calls(source: str) -> list[_ProjectionCall]:
    tree = ast.parse(source)
    violations: list[_ProjectionCall] = []

    class AsyncFunctionVisitor(ast.NodeVisitor):
        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            body_visitor = AsyncBodyVisitor(node.name)
            for statement in node.body:
                body_visitor.visit(statement)
            self.generic_visit(node)

    class AsyncBodyVisitor(ast.NodeVisitor):
        def __init__(self, function_name: str) -> None:
            self.function_name = function_name

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            del node

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            del node

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            del node

        def visit_Lambda(self, node: ast.Lambda) -> None:
            del node

        def visit_Call(self, node: ast.Call) -> None:
            if (
                isinstance(node.func, ast.Attribute)
                and node.func.attr in DIRECT_MODEL_PROJECTIONS
            ):
                violations.append(
                    _ProjectionCall(
                        function=self.function_name,
                        line=node.lineno,
                        method=node.func.attr,
                    )
                )
            self.generic_visit(node)

    AsyncFunctionVisitor().visit(tree)
    return violations


def test_web_handlers_have_no_direct_pydantic_projection() -> None:
    violations = [
        (path.relative_to(BACKEND_ROOT).as_posix(), call)
        for root in TARGET_ROOTS
        for path in sorted(root.rglob("*.py"))
        for call in _direct_async_projection_calls(path.read_text())
    ]

    assert not violations, "\n" + "\n".join(
        f"{path}:{call.line} {call.function} -> {call.method}"
        for path, call in violations
    )


def test_projection_gate_detects_direct_calls_and_ignores_sync_helpers() -> None:
    calls = _direct_async_projection_calls(
        """
async def handler(value):
    return value.model_dump()

def worker(value):
    return Model.model_validate(value)
"""
    )

    assert calls == [_ProjectionCall("handler", 3, "model_dump")]
