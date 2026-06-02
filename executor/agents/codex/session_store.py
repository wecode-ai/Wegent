#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
from pathlib import Path
from typing import Optional

from executor.config import config

from shared.logger import setup_logger

logger = setup_logger("codex_session_store")


class CodeXSessionStore:
    """Persist Codex thread IDs by task and bot."""

    def __init__(self, root: Optional[Path] = None):
        self.root = root or Path(config.WEGENT_EXECUTOR_HOME).expanduser() / "codex"
        self.root.mkdir(parents=True, exist_ok=True)

    def load(
        self, task_id: int, bot_id: Optional[int], new_session: bool
    ) -> Optional[str]:
        path = self._path(task_id, bot_id)
        if new_session:
            self.delete(task_id, bot_id)
            return None
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.warning("Failed to read Codex session file %s: %s", path, exc)
            return None
        thread_id = data.get("thread_id")
        return str(thread_id) if thread_id else None

    def save(self, task_id: int, bot_id: Optional[int], thread_id: str) -> None:
        path = self._path(task_id, bot_id)
        payload = {"task_id": task_id, "bot_id": bot_id, "thread_id": thread_id}
        try:
            path.write_text(json.dumps(payload), encoding="utf-8")
        except OSError as exc:
            logger.warning("Failed to save Codex session file %s: %s", path, exc)

    def delete(self, task_id: int, bot_id: Optional[int]) -> None:
        path = self._path(task_id, bot_id)
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Failed to delete Codex session file %s: %s", path, exc)

    def _path(self, task_id: int, bot_id: Optional[int]) -> Path:
        bot_segment = str(bot_id) if bot_id is not None else "default"
        return self.root / f"task-{task_id}-bot-{bot_segment}.json"
