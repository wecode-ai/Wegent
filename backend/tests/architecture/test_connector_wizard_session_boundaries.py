# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Static isolation invariants for connector and wizard web paths."""

from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"
ENDPOINT_PATHS = (
    APP_ROOT / "api/endpoints/connector_app_projection.py",
    APP_ROOT / "api/endpoints/connector_apps.py",
    APP_ROOT / "api/endpoints/connector_runtime.py",
    APP_ROOT / "api/endpoints/wizard.py",
    APP_ROOT / "api/endpoints/admin/connector_apps.py",
)
ASYNC_SERVICE_PATHS = (
    APP_ROOT / "services/connector_oauth.py",
    APP_ROOT / "services/connector_runtime.py",
)
ISOLATION_PATHS = (
    *ENDPOINT_PATHS,
    *ASYNC_SERVICE_PATHS,
    APP_ROOT / "services/connector_endpoint_db.py",
    APP_ROOT / "services/wizard_db.py",
)


def _annotation_name(annotation: ast.expr | None) -> str:
    return ast.unparse(annotation) if annotation is not None else ""


def _annotation_identifiers(annotation: ast.expr | None) -> set[str]:
    if annotation is None:
        return set()
    return {
        node.id if isinstance(node, ast.Name) else node.attr
        for node in ast.walk(annotation)
        if isinstance(node, (ast.Name, ast.Attribute))
    }


def test_connector_and_wizard_endpoints_have_no_sync_session_dependency() -> None:
    violations: list[str] = []
    for path in ENDPOINT_PATHS:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id in {
                "Session",
                "SessionLocal",
                "get_db",
                "get_db_session",
            }:
                violations.append(f"{path.name}:{node.lineno} name={node.id}")
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for argument in (
                    *node.args.posonlyargs,
                    *node.args.args,
                    *node.args.kwonlyargs,
                ):
                    if argument.arg == "db" or "Session" in _annotation_identifiers(
                        argument.annotation
                    ):
                        violations.append(
                            f"{path.name}:{argument.lineno} arg={argument.arg}"
                        )

    assert violations == []


def test_connector_async_services_accept_no_sync_session_or_orm_arguments() -> None:
    violations: list[str] = []
    for path in ASYNC_SERVICE_PATHS:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncFunctionDef):
                continue
            for argument in (
                *node.args.posonlyargs,
                *node.args.args,
                *node.args.kwonlyargs,
            ):
                annotation = _annotation_name(argument.annotation)
                identifiers = _annotation_identifiers(argument.annotation)
                if (
                    argument.arg == "db"
                    or "Session" in identifiers
                    or identifiers.intersection({"User", "Kind"})
                ):
                    violations.append(
                        f"{path.name}:{argument.lineno} "
                        f"{node.name}({argument.arg}: {annotation})"
                    )

    assert violations == []


def test_connector_and_wizard_paths_do_not_use_implicit_executor() -> None:
    forbidden = {"to_thread", "run_in_threadpool"}
    violations: list[str] = []
    for path in ISOLATION_PATHS:
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


def test_async_endpoints_do_not_project_response_models_inline() -> None:
    response_models = {
        "ConnectorOAuthSessionCreateResponse",
        "ConnectorOAuthSessionPollResponse",
        "ConnectorToolCallResponse",
        "ConnectorToolListResponse",
        "FollowUpQuestion",
        "FollowUpResponse",
        "GeneratePromptResponse",
        "IteratePromptResponse",
        "TestPromptResponse",
    }
    violations: list[str] = []

    class AsyncVisitor(ast.NodeVisitor):
        def __init__(self, path: Path) -> None:
            self.path = path

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            body_visitor = AsyncBodyVisitor(self.path, node.name)
            for statement in node.body:
                body_visitor.visit(statement)
            self.generic_visit(node)

    class AsyncBodyVisitor(ast.NodeVisitor):
        def __init__(self, path: Path, function_name: str) -> None:
            self.path = path
            self.function_name = function_name

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            del node

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            del node

        def visit_Call(self, node: ast.Call) -> None:
            if isinstance(node.func, ast.Name) and node.func.id in response_models:
                violations.append(
                    f"{self.path.name}:{node.lineno} "
                    f"{self.function_name} -> {node.func.id}"
                )
            self.generic_visit(node)

    for path in (*ENDPOINT_PATHS, *ASYNC_SERVICE_PATHS):
        AsyncVisitor(path).visit(ast.parse(path.read_text(), filename=str(path)))

    assert violations == []


def test_replaced_connector_and_wizard_entry_points_stay_deleted() -> None:
    forbidden_names = {
        "_connected_apps",
        "_get_model_for_wizard",
        "_resolve_wizard_stream_model_sync",
        "_server_config",
    }
    defined_names: set[str] = set()
    for path in ISOLATION_PATHS:
        tree = ast.parse(path.read_text(), filename=str(path))
        defined_names.update(
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        )

    assert defined_names.isdisjoint(forbidden_names)
