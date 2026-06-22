# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import tarfile

from executor.services.workspace_archive_restore import restore_archive_content


def _archive_bytes() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        workspace_data = b"workspace file"
        workspace_info = tarfile.TarInfo("workspace/src/main.py")
        workspace_info.size = len(workspace_data)
        archive.addfile(workspace_info, io.BytesIO(workspace_data))

        home_data = b"claude state"
        home_info = tarfile.TarInfo("home/.claude/state.json")
        home_info.size = len(home_data)
        archive.addfile(home_info, io.BytesIO(home_data))

        excluded_home_data = b"secret"
        excluded_home_info = tarfile.TarInfo("home/.ssh/id_rsa")
        excluded_home_info.size = len(excluded_home_data)
        archive.addfile(excluded_home_info, io.BytesIO(excluded_home_data))

        codex_data = b"codex session"
        codex_info = tarfile.TarInfo("home/.codex/sessions/session.jsonl")
        codex_info.size = len(codex_data)
        archive.addfile(codex_info, io.BytesIO(codex_data))
    return buffer.getvalue()


def test_restore_archive_content_splits_workspace_and_allowlisted_home(tmp_path):
    workspace_path = tmp_path / "workspace"
    home_path = tmp_path / "home"

    result = restore_archive_content(
        archive_content=_archive_bytes(),
        workspace_path=workspace_path,
        home_path=home_path,
    )

    assert result.restored is True
    assert result.session_restored is True
    assert (workspace_path / "src/main.py").read_text() == "workspace file"
    assert (home_path / ".claude/state.json").read_text() == "claude state"
    assert (home_path / ".codex/sessions/session.jsonl").read_text() == "codex session"
    assert not (home_path / ".ssh/id_rsa").exists()


def test_restore_archive_content_fallback_skips_unsafe_member_types(
    tmp_path,
    monkeypatch,
):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        file_data = b"safe"
        file_info = tarfile.TarInfo("workspace/safe.txt")
        file_info.size = len(file_data)
        archive.addfile(file_info, io.BytesIO(file_data))

        link_info = tarfile.TarInfo("workspace/link")
        link_info.type = tarfile.SYMTYPE
        link_info.linkname = "/tmp/unsafe-target"
        archive.addfile(link_info)

    def raise_old_python_type_error(*args, **kwargs):
        if "filter" in kwargs:
            raise TypeError("extractall() got an unexpected keyword argument 'filter'")
        raise AssertionError("unsafe extractall fallback should not run")

    monkeypatch.setattr(tarfile.TarFile, "extractall", raise_old_python_type_error)

    workspace_path = tmp_path / "workspace"
    result = restore_archive_content(
        archive_content=buffer.getvalue(),
        workspace_path=workspace_path,
        home_path=tmp_path / "home",
    )

    assert result.restored is True
    assert (workspace_path / "safe.txt").read_text() == "safe"
    assert not (workspace_path / "link").exists()
