# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import re
from pathlib import Path

from tests.services.rag.execution_kernel_dependencies import (
    EXECUTION_KERNEL_DISTRIBUTION,
    EXECUTION_KERNEL_DISTRIBUTIONS,
)

EXPECTED_MCP_SPECIFIER = "==1.27.2"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_PYPROJECT = PROJECT_ROOT / "backend" / "pyproject.toml"
BACKEND_LOCKFILE = PROJECT_ROOT / "backend" / "uv.lock"
KNOWLEDGE_ENGINE_PYPROJECT = PROJECT_ROOT / "knowledge_engine" / "pyproject.toml"
KNOWLEDGE_RUNTIME_PYPROJECT = PROJECT_ROOT / "knowledge_runtime" / "pyproject.toml"

DEPENDENCY_NAME = re.compile(r'^"([A-Za-z0-9._-]+)')
LOCKED_DISTRIBUTION_NAME = re.compile(r'^name = "([A-Za-z0-9._-]+)"')
RETRIEVAL_EXTRA = "retrieval"


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


def _declared_names_in_block(pyproject_path: Path, block_header: str) -> set[str]:
    """Read the requirement names inside one ``<block_header>`` list.

    A plain and an extra install are different promises: ``dependencies = [``
    decides what every consumer installs, while ``retrieval = [`` decides what
    only the callers that opt in install.
    """
    names: set[str] = set()
    inside_block = False

    for line in pyproject_path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(block_header):
            inside_block = True
            continue
        if not inside_block:
            continue
        if stripped.startswith("]"):
            break
        match = DEPENDENCY_NAME.match(stripped)
        if match:
            names.add(match.group(1))

    return names


def _locked_distribution_names(lockfile_path: Path) -> set[str]:
    """Read the names of the locked package entries.

    Only ``[[package]]`` names start at column zero; the requirement lists of
    each package are indented, so they cannot leak into this set.
    """
    names: set[str] = set()

    for line in lockfile_path.read_text().splitlines():
        match = LOCKED_DISTRIBUTION_NAME.match(line)
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
    declared = _declared_dependency_names(BACKEND_PYPROJECT)

    leaked = sorted(declared.intersection(EXECUTION_KERNEL_DISTRIBUTIONS))

    assert leaked == [], (
        "backend/pyproject.toml must not declare RAG execution dependencies; "
        f"found {leaked}. They are owned by wegent-knowledge-engine and "
        "wegent-knowledge-runtime."
    )


def test_backend_lockfile_contains_no_rag_execution_dependencies():
    """The Backend must not resolve them through the kernel or any other path."""
    locked = _locked_distribution_names(BACKEND_LOCKFILE)

    leaked = sorted(locked.intersection(EXECUTION_KERNEL_DISTRIBUTIONS))

    assert leaked == [], (
        "backend/uv.lock must not lock RAG execution dependencies; "
        f"found {leaked}. The kernel's retrieval extra is installed by "
        "wegent-knowledge-runtime only."
    )


def test_execution_kernel_keeps_rag_execution_dependencies_optional():
    """A plain kernel install must stay light, or the Backend lock cannot."""
    base = _declared_names_in_block(KNOWLEDGE_ENGINE_PYPROJECT, "dependencies = [")

    leaked = sorted(base.intersection(EXECUTION_KERNEL_DISTRIBUTIONS))

    assert leaked == [], (
        "knowledge_engine/pyproject.toml must keep the RAG execution "
        f"dependencies in the {RETRIEVAL_EXTRA!r} extra; found {leaked} in the "
        "base dependencies, which every consumer installs."
    )

    extra = _declared_names_in_block(
        KNOWLEDGE_ENGINE_PYPROJECT, f"{RETRIEVAL_EXTRA} = ["
    )

    assert extra, (
        f"knowledge_engine/pyproject.toml must declare the {RETRIEVAL_EXTRA!r} "
        "extra that wegent-knowledge-runtime depends on."
    )
    assert extra <= set(EXECUTION_KERNEL_DISTRIBUTIONS), (
        f"the {RETRIEVAL_EXTRA!r} extra holds distributions this guard does not "
        f"know: {sorted(extra - set(EXECUTION_KERNEL_DISTRIBUTIONS))}"
    )


def test_only_knowledge_runtime_declares_the_retrieval_extra():
    """The runtime executes retrieval; the Backend only routes it.

    A mismatch here is silent: the Backend keeps working while the runtime
    loses the vector stores and embeddings it indexes with.
    """
    runtime_specifier = _dependency_specifier(
        KNOWLEDGE_RUNTIME_PYPROJECT, EXECUTION_KERNEL_DISTRIBUTION
    )
    assert runtime_specifier == f"[{RETRIEVAL_EXTRA}]", (
        "knowledge_runtime/pyproject.toml must depend on "
        "wegent-knowledge-engine[retrieval], or indexing and querying would "
        "lose the dependencies the kernel now treats as optional."
    )

    backend_specifier = _dependency_specifier(
        BACKEND_PYPROJECT, EXECUTION_KERNEL_DISTRIBUTION
    )
    assert backend_specifier == "", (
        "backend/pyproject.toml must depend on the plain kernel; the "
        "retrieval extra belongs to wegent-knowledge-runtime."
    )
