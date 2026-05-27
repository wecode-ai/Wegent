"""Tests for the local executor build script."""

from __future__ import annotations

import importlib.util
from pathlib import Path


def load_build_local_module():
    script_path = Path(__file__).parents[2] / "scripts" / "build_local.py"
    spec = importlib.util.spec_from_file_location("build_local", script_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_append_claude_cli_binary_skips_lookup_when_disabled(monkeypatch):
    build_local = load_build_local_module()
    cmd = ["python", "-m", "PyInstaller"]

    def fail_lookup(target_platform):
        raise AssertionError("Claude binary lookup should be skipped")

    monkeypatch.setattr(build_local, "find_claude_agent_sdk_binary", fail_lookup)

    build_local.append_claude_cli_binary(
        cmd,
        effective_platform="Linux",
        bundle_claude_cli=False,
    )

    assert cmd == ["python", "-m", "PyInstaller"]


def test_append_claude_cli_binary_adds_binary_when_enabled(monkeypatch):
    build_local = load_build_local_module()
    cmd = ["python", "-m", "PyInstaller"]

    monkeypatch.setattr(
        build_local,
        "find_claude_agent_sdk_binary",
        lambda target_platform: ("/tmp/claude", "claude_agent_sdk/_bundled"),
    )

    build_local.append_claude_cli_binary(
        cmd,
        effective_platform="Linux",
        bundle_claude_cli=True,
    )

    assert "--add-binary=/tmp/claude:claude_agent_sdk/_bundled" in cmd
