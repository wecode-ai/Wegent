# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Workspace naming for standalone Chats conversations."""

from __future__ import annotations

import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("standalone_chat_workspace")

CHAT_WORKSPACE_ENV = "WEGENT_EXECUTOR_CHATS_DIR"
DEFAULT_CHAT_SLUG = "new-chat"
MAX_CHAT_DIR_NAME_LENGTH = 20


def get_chats_root() -> Path:
    """Return the configured root for standalone Chats workspaces."""

    explicit_root = os.environ.get(CHAT_WORKSPACE_ENV)
    if explicit_root:
        return Path(explicit_root).expanduser()

    wecode_home = Path(os.environ.get("WECODE_HOME") or Path.home() / ".wecode")
    return wecode_home / "wegent-executor" / "workspace" / "chats"


def slugify_response(response_text: str) -> str:
    """Build a filesystem-safe slug from response words."""

    words = re.findall(r"[A-Za-z0-9]+", response_text or "")
    if not words:
        return DEFAULT_CHAT_SLUG

    return _trim_chat_dir_name("-".join(word.lower() for word in words))


def _trim_chat_dir_name(name: str, suffix: str = "") -> str:
    """Trim a chat directory name so the final name stays within the limit."""

    available_length = MAX_CHAT_DIR_NAME_LENGTH - len(suffix)
    if available_length <= 0:
        return DEFAULT_CHAT_SLUG[:MAX_CHAT_DIR_NAME_LENGTH]
    trimmed = name[:available_length].rstrip("-")
    if not trimmed:
        trimmed = DEFAULT_CHAT_SLUG[:available_length].rstrip("-")
    return f"{trimmed}{suffix}"


def unique_chat_workspace_path(root: Path, response_text: str) -> Path:
    """Return an unused dated workspace path for the response text."""

    date_dir = root / datetime.now().strftime("%Y-%m-%d")
    base_name = slugify_response(response_text)
    candidate = date_dir / base_name
    suffix = 1
    while candidate.exists():
        candidate = date_dir / _trim_chat_dir_name(base_name, suffix=f"-{suffix}")
        suffix += 1
    return candidate


def _copy_session_files(task_id: int, workspace_path: Path) -> None:
    """Copy Claude session ids into the shared executor session root."""

    session_dir = Path(config.WEGENT_EXECUTOR_HOME) / "sessions" / str(task_id)
    for session_file in workspace_path.glob(".claude_session_id*"):
        if not session_file.is_file():
            continue
        session_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(session_file, session_dir / session_file.name)


def is_initial_standalone_chat(task_data) -> bool:
    """Return true when this request should create a standalone chat workspace."""

    if not task_data:
        return False
    if getattr(task_data, "project_id", None):
        return False
    if getattr(task_data, "project_workspace_path", None):
        return False
    if getattr(task_data, "git_url", None):
        return False
    return bool(getattr(task_data, "task_id", None))


def finalize_standalone_chat_workspace(task_data, response_text: str) -> Optional[str]:
    """Move the initial temporary task workspace into the Chats workspace tree."""

    if not is_initial_standalone_chat(task_data):
        return None

    task_id = getattr(task_data, "task_id", None)
    source = Path(config.get_workspace_root()) / str(task_id)
    target = unique_chat_workspace_path(get_chats_root(), response_text)

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.exists():
            if source.resolve() == target.resolve():
                return str(target)
            shutil.move(str(source), str(target))
        else:
            target.mkdir(parents=True, exist_ok=False)
        _copy_session_files(int(task_id), target)
        logger.info(
            "Finalized standalone chat workspace for task %s: %s",
            task_id,
            target,
        )
        return str(target)
    except Exception as exc:
        logger.warning(
            "Failed to finalize standalone chat workspace for task %s: %s",
            task_id,
            exc,
            exc_info=True,
        )
        return None
