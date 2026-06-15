"""Tests for the local executor build script."""

from __future__ import annotations

import importlib.util
from pathlib import Path

WEWORK_MIN_EXECUTOR_VERSION = "1.8.5"


def load_build_local_module():
    script_path = Path(__file__).parents[2] / "scripts" / "build_local.py"
    spec = importlib.util.spec_from_file_location("build_local", script_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def is_version_at_least(version: str, minimum_version: str) -> bool:
    def parse(value: str) -> list[int]:
        return [
            int(part) for part in value.removeprefix("v").split("-", 1)[0].split(".")
        ]

    current = parse(version)
    minimum = parse(minimum_version)
    for index in range(max(len(current), len(minimum))):
        current_part = current[index] if index < len(current) else 0
        minimum_part = minimum[index] if index < len(minimum) else 0
        if current_part > minimum_part:
            return True
        if current_part < minimum_part:
            return False
    return True


def test_default_build_version_meets_wework_minimum():
    build_local = load_build_local_module()

    assert is_version_at_least(
        build_local.get_version_from_pyproject(),
        WEWORK_MIN_EXECUTOR_VERSION,
    )


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


def test_ensure_linux_openai_codex_sdk_skips_non_linux(monkeypatch):
    build_local = load_build_local_module()

    def fail_lookup(name):
        raise AssertionError("SDK lookup should be skipped")

    monkeypatch.setattr(build_local.importlib.util, "find_spec", fail_lookup)

    build_local.ensure_linux_openai_codex_sdk("Darwin")


def test_ensure_linux_openai_codex_sdk_installs_with_no_deps(monkeypatch):
    build_local = load_build_local_module()
    calls = []

    monkeypatch.setattr(build_local.importlib.util, "find_spec", lambda name: None)
    monkeypatch.setattr(build_local.shutil, "which", lambda name: "/usr/bin/uv")
    monkeypatch.setattr(
        build_local.subprocess,
        "run",
        lambda cmd, check: calls.append((cmd, check)),
    )

    build_local.ensure_linux_openai_codex_sdk("Linux")

    assert calls == [
        (
            [
                "/usr/bin/uv",
                "pip",
                "install",
                "--python",
                build_local.sys.executable,
                "--no-deps",
                "openai-codex==0.1.0b3",
            ],
            True,
        )
    ]


def test_append_codex_pyinstaller_options_collects_sdk_modules():
    build_local = load_build_local_module()
    cmd = ["python", "-m", "PyInstaller"]

    build_local.append_codex_pyinstaller_options(cmd)

    assert "--hidden-import=executor.agents.codex.codex_agent" in cmd
    assert "--hidden-import=openai_codex" in cmd
    assert "--hidden-import=openai_codex.generated.v2_all" in cmd
    assert "--collect-all=openai_codex" in cmd
