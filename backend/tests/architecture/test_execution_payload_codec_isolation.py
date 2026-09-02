# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep unbounded payload codecs off async execution paths."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"
SCAN_ROOTS = (
    APP_ROOT / "api" / "endpoints" / "adapter" / "shells.py",
    APP_ROOT / "services" / "adapters" / "executor_kinds.py",
    APP_ROOT / "services" / "execution",
)
_DIRECT_JSON_CODECS = {
    "json.dumps",
    "json.loads",
    "orjson.dumps",
    "orjson.loads",
}


@dataclass(frozen=True)
class _Violation:
    path: str
    function: str
    line: int
    operation: str

    def render(self) -> str:
        return f"{self.path}:{self.line} {self.function} -> {self.operation}"


def _paths() -> list[Path]:
    paths: list[Path] = []
    for root in SCAN_ROOTS:
        paths.extend(sorted(root.rglob("*.py")) if root.is_dir() else [root])
    return paths


def _dotted_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def _import_aliases(tree: ast.Module) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for value in node.names:
                aliases[value.asname or value.name.split(".")[0]] = value.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for value in node.names:
                aliases[value.asname or value.name] = f"{node.module}.{value.name}"
    return aliases


def _resolve_call_name(call: ast.Call, aliases: dict[str, str]) -> str:
    dotted = _dotted_name(call.func)
    root, separator, suffix = dotted.partition(".")
    resolved_root = aliases.get(root, root)
    return f"{resolved_root}.{suffix}" if separator else resolved_root


def _async_codec_violations(path: Path) -> list[_Violation]:
    relative_path = path.relative_to(APP_ROOT.parent).as_posix()
    tree = ast.parse(path.read_text(), filename=str(path))
    aliases = _import_aliases(tree)
    violations: list[_Violation] = []

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
            call_name = _resolve_call_name(node, aliases)
            if call_name in _DIRECT_JSON_CODECS:
                violations.append(
                    _Violation(
                        path=relative_path,
                        function=self.function_name,
                        line=node.lineno,
                        operation=call_name,
                    )
                )
            if call_name.endswith(".json"):
                violations.append(
                    _Violation(
                        path=relative_path,
                        function=self.function_name,
                        line=node.lineno,
                        operation=call_name,
                    )
                )
            for keyword in node.keywords:
                if keyword.arg == "json":
                    violations.append(
                        _Violation(
                            path=relative_path,
                            function=self.function_name,
                            line=node.lineno,
                            operation=f"{call_name}(json=...)",
                        )
                    )
            self.generic_visit(node)

        def visit_Attribute(self, node: ast.Attribute) -> None:
            if node.attr == "text":
                violations.append(
                    _Violation(
                        path=relative_path,
                        function=self.function_name,
                        line=node.lineno,
                        operation="synchronous response.text decode",
                    )
                )
            self.generic_visit(node)

    AsyncFunctionVisitor().visit(tree)
    return violations


def test_execution_async_code_uses_bounded_payload_codec() -> None:
    violations = [
        violation for path in _paths() for violation in _async_codec_violations(path)
    ]

    assert not violations, "\n" + "\n".join(
        violation.render() for violation in violations
    )
