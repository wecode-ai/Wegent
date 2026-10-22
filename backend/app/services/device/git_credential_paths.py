# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Path resolution shared by device-side credential writers and CLI readers."""

import shlex

# Executed on the device, never against the backend's HOME.
GIT_CREDENTIAL_PATHS_SCRIPT = r"""
import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated
""".strip()


def managed_git_cli_command(command: str) -> str:
    """Resolve credentials on every invocation, including after a live sync."""

    script = (
        GIT_CREDENTIAL_PATHS_SCRIPT
        + r"""

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
"""
    )
    return " ".join(
        shlex.quote(part) for part in ["python3", "-c", script, *shlex.split(command)]
    )
