# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

EXPECTED_MCP_SPECIFIER = "==1.27.2"
PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _dependency_specifier(pyproject_path: Path, dependency_name: str) -> str:
    prefix = f'"{dependency_name}'

    for line in pyproject_path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped.strip('",')[len(dependency_name) :]

    raise AssertionError(f"{dependency_name} dependency not found in {pyproject_path}")


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
