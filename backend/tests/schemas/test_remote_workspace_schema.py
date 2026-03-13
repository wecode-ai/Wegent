# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.remote_workspace import (
    RemoteWorkspaceStatusResponse,
    RemoteWorkspaceTreeEntry,
)


def test_remote_workspace_status_schema():
    payload = RemoteWorkspaceStatusResponse(
        connected=True,
        available=False,
        root_path="/workspace",
        reason="sandbox_not_running",
    )

    assert payload.connected is True
    assert payload.available is False
    assert payload.root_path == "/workspace"
    assert payload.reason == "sandbox_not_running"


def test_remote_workspace_tree_entry_schema():
    node = RemoteWorkspaceTreeEntry(
        name="src",
        path="/workspace/src",
        is_directory=True,
        size=0,
    )

    assert node.is_directory is True
