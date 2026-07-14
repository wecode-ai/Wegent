# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for legacy Office conversion helpers."""

from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from knowledge_engine.conversion import office_legacy
from knowledge_engine.conversion.office_legacy import (
    convert_legacy_office_to_openxml,
    resolve_soffice_path,
)


def test_convert_legacy_office_uses_isolated_libreoffice_profile() -> None:
    commands: list[list[str]] = []

    def fake_run(
        cmd,
        *,
        capture_output,
        timeout,
        check,
    ):
        commands.append(cmd)
        outdir = Path(cmd[cmd.index("--outdir") + 1])
        (outdir / "document.docx").write_bytes(b"converted")
        return CompletedProcess(cmd, 0, stdout=b"", stderr=b"")

    with (
        patch(
            "knowledge_engine.conversion.office_legacy.resolve_soffice_path",
            return_value="/usr/bin/soffice",
        ),
        patch(
            "knowledge_engine.conversion.office_legacy.subprocess.run",
            side_effect=fake_run,
        ),
    ):
        converted, target_ext = convert_legacy_office_to_openxml(b"doc bytes", "doc")

    assert converted == b"converted"
    assert target_ext == "docx"
    profile_args = [
        arg for arg in commands[0] if arg.startswith("-env:UserInstallation=")
    ]
    assert len(profile_args) == 1
    assert profile_args[0].startswith("-env:UserInstallation=file://")


def test_resolve_soffice_path_does_not_cache_negative_result(monkeypatch) -> None:
    calls = []

    def fake_run(cmd, *, capture_output, timeout, check):
        calls.append(cmd)
        if len(calls) == 1:
            raise FileNotFoundError
        return CompletedProcess(cmd, 0, stdout=b"LibreOffice", stderr=b"")

    monkeypatch.setattr(office_legacy, "_RESOLVED_SOFFICE_PATH", None)
    monkeypatch.setattr(office_legacy, "_SOFFICE_CANDIDATES", ("soffice",))
    monkeypatch.setattr(office_legacy.shutil, "which", lambda candidate: candidate)
    monkeypatch.setattr(office_legacy.subprocess, "run", fake_run)

    assert resolve_soffice_path() is None
    assert resolve_soffice_path() == "soffice"
    assert len(calls) == 2
