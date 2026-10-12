# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capability-only Backend modules must not load the RAG execution kernel."""

from __future__ import annotations

import ast
import re
import subprocess
import sys
from pathlib import Path

from tests.services.rag.execution_kernel_dependencies import EXECUTION_KERNEL_MODULES

BACKEND_ROOT = Path(__file__).resolve().parents[3]
SCANNED_SOURCE_DIRS = ("app", "tests", "scripts", "alembic", "integration_checks")
STORAGE_FACTORY_MODULE = "knowledge_engine.storage.factory"

EXECUTION_KERNEL_IMPORT = re.compile(
    r"^\s*(?:from|import)\s+(?:%s)\b" % "|".join(EXECUTION_KERNEL_MODULES),
    re.MULTILINE,
)

CAPABILITY_IMPORT_SCRIPT = f"""
import importlib
import sys

for module_name in (
    "app.api.endpoints.adapter.retrievers",
    "app.services.rag.runtime_resolver",
    "app.services.model_embedding_dimension",
):
    importlib.import_module(module_name)

prefixes = {EXECUTION_KERNEL_MODULES!r}
loaded = [name for name in sys.modules if name.startswith(prefixes)]
print("|".join(sorted(loaded)))
"""

APP_IMPORT_SCRIPT = f"""
import importlib
import sys


class BlockExecutionKernel:
    # Fail loudly when anything reaches for a RAG execution dependency.
    blocked = {EXECUTION_KERNEL_MODULES!r}

    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in self.blocked:
            # Mirror the missing-package error of a kernel-free environment.
            raise ModuleNotFoundError(
                f"execution kernel import is blocked: {{fullname}}"
            )
        return None


sys.meta_path.insert(0, BlockExecutionKernel())
importlib.import_module("app.main")
print("APP_IMPORT_OK")
"""


def test_capability_modules_do_not_load_the_execution_kernel() -> None:
    completed = subprocess.run(
        [sys.executable, "-c", CAPABILITY_IMPORT_SCRIPT],
        capture_output=True,
        text=True,
        cwd=BACKEND_ROOT,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == ""


def test_backend_does_not_import_the_execution_kernel() -> None:
    """Only knowledge_runtime executes retrieval; Backend code must not import it."""
    offenders = [
        str(path.relative_to(BACKEND_ROOT))
        for source_dir in SCANNED_SOURCE_DIRS
        for path in sorted((BACKEND_ROOT / source_dir).rglob("*.py"))
        if EXECUTION_KERNEL_IMPORT.search(path.read_text(encoding="utf-8"))
    ]

    assert offenders == []


def _builds_storage_backend(source: str) -> bool:
    """Report whether source imports the factory or calls its constructors."""
    for node in ast.walk(ast.parse(source)):
        if _imports_storage_factory(node):
            return True
        if isinstance(node, ast.Name) and node.id.startswith("create_storage_backend"):
            return True
        if isinstance(node, ast.Attribute) and node.attr.startswith(
            "create_storage_backend"
        ):
            return True
    return False


def _imports_storage_factory(node: ast.AST) -> bool:
    if isinstance(node, ast.ImportFrom):
        if node.module == STORAGE_FACTORY_MODULE:
            return True
        return node.module == "knowledge_engine.storage" and any(
            alias.name == "factory" for alias in node.names
        )
    if isinstance(node, ast.Import):
        return any(alias.name == STORAGE_FACTORY_MODULE for alias in node.names)
    return False


def test_backend_does_not_build_storage_backends() -> None:
    """Only knowledge_runtime builds storage backends; the Backend must forward."""
    offenders = [
        str(path.relative_to(BACKEND_ROOT))
        for path in sorted((BACKEND_ROOT / "app").rglob("*.py"))
        if _builds_storage_backend(path.read_text(encoding="utf-8"))
    ]

    assert offenders == []


def test_backend_app_imports_without_the_execution_kernel() -> None:
    """The Backend must start on a machine that has no RAG execution packages."""
    completed = subprocess.run(
        [sys.executable, "-c", APP_IMPORT_SCRIPT],
        capture_output=True,
        text=True,
        cwd=BACKEND_ROOT,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.rstrip().endswith("APP_IMPORT_OK"), completed.stdout
