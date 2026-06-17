# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capture Git file changes made during one agent turn."""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import socket
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

ARTIFACT_VERSION = 1
LOCK_FILE_NAME = "wegent-turn-file-changes.lock"
logger = logging.getLogger(__name__)


class WorkspaceBusyError(RuntimeError):
    """Raised when another tracked turn owns the workspace lock."""


@dataclass(frozen=True)
class GitTreeSnapshot:
    """A Git tree representing the complete workspace state."""

    tree_id: str


@dataclass(frozen=True)
class TurnFileArtifact:
    """Paths and checksum for a persisted turn patch."""

    artifact_id: str
    patch_path: Path
    metadata_path: Path
    checksum: str


@dataclass(frozen=True)
class _ChangedPath:
    path: str
    change_type: str
    old_path: Optional[str] = None


def _run_git(
    workspace: Path,
    *args: str,
    env: Optional[dict[str, str]] = None,
    text: bool = True,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(workspace), *args],
        check=True,
        capture_output=True,
        env={**os.environ, **(env or {})},
        text=text,
    )


def _is_git_workspace(workspace: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(workspace), "rev-parse", "--is-inside-work-tree"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def _has_head(workspace: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(workspace), "rev-parse", "--verify", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _decode_path(value: bytes) -> str:
    return value.decode("utf-8", errors="surrogateescape")


class TurnFileChangeTracker:
    """Create a per-turn Git diff without mutating the repository index."""

    def __init__(
        self,
        workspace: Path,
        task_id: int,
        subtask_id: int,
        executor_home: Path,
        device_id: Optional[str] = None,
    ) -> None:
        self.workspace = workspace.resolve()
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.executor_home = executor_home.expanduser().resolve()
        self.device_id = device_id
        self._before: Optional[GitTreeSnapshot] = None
        self._lock_path: Optional[Path] = None
        self._active = False

    async def start(self) -> bool:
        """Capture the workspace state immediately before an agent turn."""
        if not _is_git_workspace(self.workspace):
            return False
        self._acquire_lock()
        try:
            self._before = self._capture_tree()
            self._active = True
            logger.info(
                "Captured turn file change baseline: task_id=%s subtask_id=%s workspace=%s tree=%s",
                self.task_id,
                self.subtask_id,
                self.workspace,
                self._before.tree_id,
            )
            return True
        except Exception:
            self._release_lock()
            raise

    async def finalize(self) -> dict[str, Any]:
        """Persist and summarize changes made since ``start``."""
        if not self._active or self._before is None:
            return {}
        try:
            after = self._capture_tree()
            patch = self._create_patch(self._before, after)
            if not patch:
                logger.info(
                    "No turn file changes detected: task_id=%s subtask_id=%s workspace=%s before=%s after=%s",
                    self.task_id,
                    self.subtask_id,
                    self.workspace,
                    self._before.tree_id,
                    after.tree_id,
                )
                return {}
            files = self._create_file_summary(self._before, after)
            artifact = self._persist_artifact(patch)
            logger.info(
                "Persisted turn file changes: task_id=%s subtask_id=%s workspace=%s artifact_id=%s files=%s additions=%s deletions=%s",
                self.task_id,
                self.subtask_id,
                self.workspace,
                artifact.artifact_id,
                len(files),
                sum(item["additions"] for item in files),
                sum(item["deletions"] for item in files),
            )
            return {
                "file_changes": {
                    "version": ARTIFACT_VERSION,
                    "status": "active",
                    "artifact_id": artifact.artifact_id,
                    "device_id": self.device_id,
                    "workspace_path": str(self.workspace),
                    "file_count": len(files),
                    "additions": sum(item["additions"] for item in files),
                    "deletions": sum(item["deletions"] for item in files),
                    "files": files,
                    "reverted_at": None,
                }
            }
        finally:
            self._active = False
            self._release_lock()

    async def abort(self) -> None:
        """Stop tracking and release the workspace lock."""
        self._active = False
        self._before = None
        self._release_lock()

    def _capture_tree(self) -> GitTreeSnapshot:
        with tempfile.TemporaryDirectory(prefix="wegent-turn-index-") as temp_dir:
            index_path = Path(temp_dir) / "index"
            env = {"GIT_INDEX_FILE": str(index_path)}
            if _has_head(self.workspace):
                _run_git(self.workspace, "read-tree", "HEAD", env=env)
            _run_git(self.workspace, "add", "--all", "--", ".", env=env)
            tree_id = _run_git(self.workspace, "write-tree", env=env).stdout.strip()
        return GitTreeSnapshot(tree_id=tree_id)

    def _create_patch(
        self,
        before: GitTreeSnapshot,
        after: GitTreeSnapshot,
    ) -> bytes:
        return _run_git(
            self.workspace,
            "diff",
            "--binary",
            "--find-renames",
            before.tree_id,
            after.tree_id,
            text=False,
        ).stdout

    def _create_file_summary(
        self,
        before: GitTreeSnapshot,
        after: GitTreeSnapshot,
    ) -> list[dict[str, Any]]:
        changed_paths = self._changed_paths(before, after)
        files = []
        for changed in changed_paths:
            additions, deletions, binary = self._line_stats(before, after, changed)
            files.append(
                {
                    "old_path": changed.old_path,
                    "path": changed.path,
                    "change_type": changed.change_type,
                    "additions": additions,
                    "deletions": deletions,
                    "binary": binary,
                }
            )
        return sorted(files, key=lambda item: item["path"])

    def _changed_paths(
        self,
        before: GitTreeSnapshot,
        after: GitTreeSnapshot,
    ) -> list[_ChangedPath]:
        output = _run_git(
            self.workspace,
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            before.tree_id,
            after.tree_id,
            text=False,
        ).stdout
        tokens = output.split(b"\0")
        changes: list[_ChangedPath] = []
        index = 0
        while index < len(tokens) and tokens[index]:
            status = _decode_path(tokens[index])
            index += 1
            old_or_current = _decode_path(tokens[index])
            index += 1
            code = status[0]
            if code == "R":
                new_path = _decode_path(tokens[index])
                index += 1
                changes.append(
                    _ChangedPath(
                        old_path=old_or_current,
                        path=new_path,
                        change_type="renamed",
                    )
                )
                continue
            change_type = {
                "A": "created",
                "D": "deleted",
            }.get(code, "modified")
            changes.append(_ChangedPath(path=old_or_current, change_type=change_type))
        return changes

    def _line_stats(
        self,
        before: GitTreeSnapshot,
        after: GitTreeSnapshot,
        changed: _ChangedPath,
    ) -> tuple[int, int, bool]:
        paths = [changed.path]
        if changed.old_path is not None:
            paths.insert(0, changed.old_path)
        output = _run_git(
            self.workspace,
            "diff",
            "--numstat",
            "--find-renames",
            before.tree_id,
            after.tree_id,
            "--",
            *paths,
            text=False,
        ).stdout
        additions = 0
        deletions = 0
        binary = False
        for line in output.splitlines():
            parts = line.split(b"\t", 2)
            if len(parts) < 2:
                continue
            if parts[0] == b"-" or parts[1] == b"-":
                binary = True
                continue
            additions += int(parts[0])
            deletions += int(parts[1])
        return additions, deletions, binary

    def _persist_artifact(self, patch: bytes) -> TurnFileArtifact:
        artifact_id = f"turn-file-changes/{self.task_id}/{self.subtask_id}"
        artifact_dir = self.executor_home / "artifacts" / artifact_id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        patch_path = artifact_dir / "changes.patch.gz"
        metadata_path = artifact_dir / "metadata.json"
        checksum = hashlib.sha256(patch).hexdigest()
        metadata = {
            "version": ARTIFACT_VERSION,
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "workspace_path": str(self.workspace),
            "checksum": checksum,
        }
        self._atomic_write(patch_path, gzip.compress(patch))
        self._atomic_write(
            metadata_path,
            json.dumps(metadata, ensure_ascii=True, sort_keys=True).encode("utf-8"),
        )
        return TurnFileArtifact(
            artifact_id=artifact_id,
            patch_path=patch_path,
            metadata_path=metadata_path,
            checksum=checksum,
        )

    @staticmethod
    def _atomic_write(path: Path, content: bytes) -> None:
        with tempfile.NamedTemporaryFile(
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
            temp_file.write(content)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        temp_path.replace(path)

    def _acquire_lock(self) -> None:
        git_dir = _run_git(
            self.workspace,
            "rev-parse",
            "--git-dir",
        ).stdout.strip()
        git_path = Path(git_dir)
        if not git_path.is_absolute():
            git_path = self.workspace / git_path
        self._lock_path = git_path.resolve() / LOCK_FILE_NAME
        lock_metadata = {
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
        }
        for attempt in range(2):
            try:
                lock_fd = os.open(
                    self._lock_path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                with os.fdopen(lock_fd, "w", encoding="utf-8") as lock_file:
                    json.dump(lock_metadata, lock_file)
                return
            except FileExistsError:
                if attempt == 0 and self._remove_stale_lock():
                    continue
                raise WorkspaceBusyError(
                    f"Workspace is busy with another tracked turn: {self.workspace}"
                )

    def _remove_stale_lock(self) -> bool:
        if self._lock_path is None:
            return False
        try:
            metadata = json.loads(self._lock_path.read_text(encoding="utf-8"))
            if metadata.get("hostname") != socket.gethostname():
                return False
            pid = int(metadata["pid"])
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return False
        if self._pid_exists(pid):
            return False
        try:
            self._lock_path.unlink()
            return True
        except FileNotFoundError:
            return True

    @staticmethod
    def _pid_exists(pid: int) -> bool:
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _release_lock(self) -> None:
        if self._lock_path is None:
            return
        try:
            self._lock_path.unlink()
        except FileNotFoundError:
            pass
        finally:
            self._lock_path = None
