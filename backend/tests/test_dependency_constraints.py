# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import re
from pathlib import Path

from tests.services.rag.execution_kernel_dependencies import (
    EXECUTION_KERNEL_DISTRIBUTIONS,
)

EXPECTED_MCP_SPECIFIER = "==1.27.2"
PROJECT_ROOT = Path(__file__).resolve().parents[2]

DEPENDENCY_NAME = re.compile(r'^"([A-Za-z0-9._-]+)')


def _dependency_specifier(pyproject_path: Path, dependency_name: str) -> str:
    prefix = f'"{dependency_name}'

    for line in pyproject_path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped.strip('",')[len(dependency_name) :]

    raise AssertionError(f"{dependency_name} dependency not found in {pyproject_path}")


def _declared_dependency_names(pyproject_path: Path) -> set[str]:
    """Read the distribution names of every quoted requirement in the file."""
    names: set[str] = set()

    for line in pyproject_path.read_text().splitlines():
        match = DEPENDENCY_NAME.match(line.strip())
        if match:
            names.add(match.group(1))

    return names


def test_python_mcp_dependency_pin_matches_chat_runtimes():
    """Keep Python chat runtimes on one MCP SDK version to avoid API drift."""
    pyproject_paths = [
        PROJECT_ROOT / "backend" / "pyproject.toml",
        PROJECT_ROOT / "chat_shell" / "pyproject.toml",
    ]

    for pyproject_path in pyproject_paths:
        specifier = _dependency_specifier(pyproject_path, "mcp")

        assert specifier == EXPECTED_MCP_SPECIFIER, (
            f"{pyproject_path} must pin mcp{EXPECTED_MCP_SPECIFIER} so "
            "backend and chat_shell share the same MCP SDK API"
        )


def test_backend_declares_no_rag_execution_dependencies():
    """The Backend routes RAG but never executes it, in any dependency group."""
    declared = _declared_dependency_names(PROJECT_ROOT / "backend" / "pyproject.toml")

    leaked = sorted(declared.intersection(EXECUTION_KERNEL_DISTRIBUTIONS))

    assert leaked == [], (
        "backend/pyproject.toml must not declare RAG execution dependencies; "
        f"found {leaked}. They are owned by wegent-knowledge-engine and "
        "wegent-knowledge-runtime."
    )
