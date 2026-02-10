# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

from executor.config import config
from executor.utils.workdir_resolver import (
    EXISTING_POLICY,
    MANAGED_POLICY,
    resolve_task_workdir_details,
)


def test_returns_empty_when_no_inputs(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "get_local_workdir_allowed_roots", lambda: [str(tmp_path)])
    monkeypatch.setattr(config, "get_workspace_root", lambda: str(tmp_path / "ws"))

    resolution = resolve_task_workdir_details({"task_id": 1}, bot_cwd=None)
    assert resolution.effective_cwd == ""
    assert resolution.policy == ""
    assert resolution.fell_back is False


def test_existing_policy_accepts_workdir_under_allowed_root(monkeypatch, tmp_path):
    allowed_root = tmp_path / "allowed"
    requested = allowed_root / "project"
    requested.mkdir(parents=True)

    monkeypatch.setattr(config, "get_local_workdir_allowed_roots", lambda: [str(allowed_root)])
    monkeypatch.setattr(config, "get_workspace_root", lambda: str(tmp_path / "ws"))

    resolution = resolve_task_workdir_details(
        {"task_id": 2, "workdir": str(requested), "workdir_policy": "existing"},
        bot_cwd=None,
    )
    assert resolution.policy == EXISTING_POLICY
    assert resolution.effective_cwd == os.path.realpath(os.path.abspath(str(requested)))
    assert resolution.fell_back is False


def test_rejects_workdir_outside_allowed_root_and_falls_back_to_bot_cwd(
    monkeypatch, tmp_path
):
    allowed_root = tmp_path / "allowed"
    outside_root = tmp_path / "outside"
    allowed_root.mkdir()
    outside_root.mkdir()

    bot_cwd = allowed_root / "bot"
    bot_cwd.mkdir()

    monkeypatch.setattr(config, "get_local_workdir_allowed_roots", lambda: [str(allowed_root)])
    monkeypatch.setattr(config, "get_workspace_root", lambda: str(tmp_path / "ws"))

    resolution = resolve_task_workdir_details(
        {"task_id": 3, "workdir": str(outside_root), "workdir_policy": "existing"},
        bot_cwd=str(bot_cwd),
    )
    assert resolution.policy == EXISTING_POLICY
    assert resolution.effective_cwd == os.path.realpath(os.path.abspath(str(bot_cwd)))
    assert resolution.fell_back is True
    assert resolution.reason


def test_rejects_symlink_escape_and_falls_back_to_managed(monkeypatch, tmp_path):
    allowed_root = tmp_path / "allowed"
    outside_root = tmp_path / "outside"
    allowed_root.mkdir()
    outside_root.mkdir()

    link_path = allowed_root / "link"
    os.symlink(str(outside_root), str(link_path))

    monkeypatch.setattr(config, "get_local_workdir_allowed_roots", lambda: [str(allowed_root)])
    monkeypatch.setattr(config, "get_workspace_root", lambda: str(tmp_path / "ws"))

    resolution = resolve_task_workdir_details(
        {"task_id": 4, "workdir": str(link_path), "workdir_policy": "existing"},
        bot_cwd=None,
    )
    assert resolution.policy == MANAGED_POLICY
    assert resolution.fell_back is True
    assert resolution.effective_cwd.endswith(os.path.join("ws", "4"))


def test_invalid_policy_falls_back_to_managed(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "get_local_workdir_allowed_roots", lambda: [str(tmp_path)])
    monkeypatch.setattr(config, "get_workspace_root", lambda: str(tmp_path / "ws"))

    resolution = resolve_task_workdir_details(
        {"task_id": 5, "workdir": str(tmp_path), "workdir_policy": "nope"},
        bot_cwd=None,
    )
    assert resolution.policy == MANAGED_POLICY
    assert resolution.fell_back is True
    assert resolution.reason

