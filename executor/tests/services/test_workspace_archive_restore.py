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
    assert not (home_path / ".ssh/id_rsa").exists()
