# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.remote_workspace import (
    RemoteWorkspaceArtifactSource,
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


@pytest.mark.parametrize(
    "root", ["relative/path", "/", "C:\\", "/workspace/../secret", "/workspace/\n"]
)
def test_artifact_source_requires_an_absolute_non_root_directory(root: str):
    with pytest.raises(ValidationError):
        RemoteWorkspaceArtifactSource(executor_name="executor-a", workspace_root=root)


@pytest.mark.parametrize(
    "root",
    ["/workspace/project", "C:\\Projects\\artifacts", "\\\\?\\C:\\Projects\\artifacts"],
)
def test_artifact_source_preserves_native_workspace_paths(root: str):
    source = RemoteWorkspaceArtifactSource(
        executor_name="executor-a", workspace_root=root
    )

    assert source.workspace_root == root
