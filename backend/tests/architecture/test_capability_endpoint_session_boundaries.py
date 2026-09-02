# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Static guards for capability endpoint database isolation."""

from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"
ENDPOINT_PATHS = (
    APP_ROOT / "api/endpoints/installed_plugins.py",
    APP_ROOT / "api/endpoints/installed_mcps.py",
    APP_ROOT / "api/endpoints/system_skills.py",
)
ASYNC_SERVICE_PATHS = (
    APP_ROOT / "services/device/capability_sync_service.py",
    APP_ROOT / "services/plugin_device_installation_service.py",
    APP_ROOT / "services/system_skill_providers/service.py",
)


def _annotation_name(annotation: ast.expr | None) -> str:
    if annotation is None:
        return ""
    return ast.unparse(annotation)


def test_capability_endpoints_have_no_session_or_get_db_dependency() -> None:
    violations: list[str] = []
    for path in ENDPOINT_PATHS:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id in {
                "Session",
                "get_db",
                "get_db_session",
            }:
                violations.append(f"{path.name}:{node.lineno} name={node.id}")
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for argument in (*node.args.posonlyargs, *node.args.args):
                    if argument.arg == "db":
                        violations.append(
                            f"{path.name}:{argument.lineno} arg={argument.arg}"
                        )

    assert violations == []


def test_transitive_async_services_accept_no_session_or_orm_arguments() -> None:
    violations: list[str] = []
    for path in ASYNC_SERVICE_PATHS:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncFunctionDef):
                continue
            for argument in (*node.args.posonlyargs, *node.args.args):
                annotation = _annotation_name(argument.annotation)
                if (
                    argument.arg == "db"
                    or "Session" in annotation
                    or annotation == "User"
                ):
                    violations.append(
                        f"{path.name}:{argument.lineno} {node.name}({argument.arg}: {annotation})"
                    )

    assert violations == []


def test_capability_async_paths_do_not_use_implicit_default_executor() -> None:
    forbidden = {"to_thread", "run_in_threadpool"}
    violations: list[str] = []
    for path in (*ENDPOINT_PATHS, *ASYNC_SERVICE_PATHS):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Attribute) and node.func.attr in forbidden:
                violations.append(f"{path.name}:{node.lineno} {node.func.attr}")
            if (
                isinstance(node.func, ast.Attribute)
                and node.func.attr == "run_in_executor"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value is None
            ):
                violations.append(f"{path.name}:{node.lineno} default executor")

    assert violations == []
