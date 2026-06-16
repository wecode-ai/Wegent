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


@dataclass(frozen=True)
class _PatchStats:
    files: list[dict[str, Any]]
    additions: int
    deletions: int


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
            artifact = TurnFileChangeArtifactStore(
                workspace=self.workspace,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                executor_home=self.executor_home,
            ).persist(patch)
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

    @staticmethod
    def _atomic_write(path: Path, content: bytes) -> None:
        TurnFileChangeArtifactStore.atomic_write(path, content)

    def _acquire_lock(self) -> None:
        common_dir = _run_git(
            self.workspace,
            "rev-parse",
            "--git-common-dir",
        ).stdout.strip()
        common_path = Path(common_dir)
        if not common_path.is_absolute():
            common_path = self.workspace / common_path
        self._lock_path = common_path.resolve() / LOCK_FILE_NAME
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


class TurnFileChangeArtifactStore:
    """Persist and summarize patch artifacts without owning workspace locking."""

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

    def completion_fields_from_patch(self, patch: bytes) -> dict[str, Any]:
        """Persist a patch and return the response.completed file_changes field."""
        if not patch:
            logger.info(
                "Turn file change artifact skipped because patch is empty: task_id=%s subtask_id=%s workspace=%s",
                self.task_id,
                self.subtask_id,
                self.workspace,
            )
            return {}
        stats = self.summarize_patch(patch)
        if not stats.files:
            logger.info(
                "Turn file change artifact skipped because patch summary is empty: task_id=%s subtask_id=%s patch_bytes=%s workspace=%s",
                self.task_id,
                self.subtask_id,
                len(patch),
                self.workspace,
            )
            return {}
        artifact = self.persist(patch)
        logger.info(
            "Turn file change artifact persisted: task_id=%s subtask_id=%s artifact_id=%s file_count=%s additions=%s deletions=%s patch_bytes=%s workspace=%s",
            self.task_id,
            self.subtask_id,
            artifact.artifact_id,
            len(stats.files),
            stats.additions,
            stats.deletions,
            len(patch),
            self.workspace,
        )
        return {
            "file_changes": {
                "version": ARTIFACT_VERSION,
                "status": "active",
                "artifact_id": artifact.artifact_id,
                "device_id": self.device_id,
                "workspace_path": str(self.workspace),
                "file_count": len(stats.files),
                "additions": stats.additions,
                "deletions": stats.deletions,
                "files": stats.files,
                "reverted_at": None,
            }
        }

    def persist(self, patch: bytes) -> TurnFileArtifact:
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
        self.atomic_write(patch_path, gzip.compress(patch))
        self.atomic_write(
            metadata_path,
            json.dumps(metadata, ensure_ascii=True, sort_keys=True).encode("utf-8"),
        )
        return TurnFileArtifact(
            artifact_id=artifact_id,
            patch_path=patch_path,
            metadata_path=metadata_path,
            checksum=checksum,
        )

    def summarize_patch(self, patch: bytes) -> _PatchStats:
        changed_by_path = self._changed_paths_from_patch(patch)
        stat_by_path = self._numstat_by_path(patch)
        files: list[dict[str, Any]] = []
        for path, changed in changed_by_path.items():
            additions, deletions, binary = stat_by_path.get(path, (0, 0, False))
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
        files = sorted(files, key=lambda item: item["path"])
        return _PatchStats(
            files=files,
            additions=sum(item["additions"] for item in files),
            deletions=sum(item["deletions"] for item in files),
        )

    def _numstat_by_path(self, patch: bytes) -> dict[str, tuple[int, int, bool]]:
        with tempfile.NamedTemporaryFile(
            prefix="wegent-turn-numstat-",
            suffix=".patch",
            delete=False,
        ) as temp_file:
            temp_file.write(patch)
            temp_path = Path(temp_file.name)
        try:
            result = subprocess.run(
                ["git", "apply", "--numstat", "-z", str(temp_path)],
                cwd=self.workspace,
                check=False,
                capture_output=True,
            )
        finally:
            temp_path.unlink(missing_ok=True)
        if result.returncode != 0:
            logger.warning(
                "Failed to summarize turn patch numstat: task_id=%s subtask_id=%s stderr=%s",
                self.task_id,
                self.subtask_id,
                result.stderr.decode("utf-8", errors="replace"),
            )
            return {}
        tokens = result.stdout.split(b"\0")
        stats: dict[str, tuple[int, int, bool]] = {}
        for token in tokens:
            if not token:
                continue
            parts = token.split(b"\t")
            if len(parts) < 3:
                continue
            path = _decode_path(parts[-1])
            binary = parts[0] == b"-" or parts[1] == b"-"
            additions = 0 if binary else int(parts[0])
            deletions = 0 if binary else int(parts[1])
            stats[path] = (additions, deletions, binary)
        return stats

    def _changed_paths_from_patch(self, patch: bytes) -> dict[str, _ChangedPath]:
        changes: dict[str, _ChangedPath] = {}
        current_path: Optional[str] = None
        old_path: Optional[str] = None
        change_type = "modified"
        for raw_line in patch.splitlines():
            line = raw_line.decode("utf-8", errors="replace")
            if line.startswith("diff --git "):
                self._store_patch_change(changes, current_path, old_path, change_type)
                current_path, old_path = self._paths_from_diff_header(line)
                change_type = "modified"
                continue
            if current_path is None:
                continue
            if line.startswith("new file mode "):
                change_type = "created"
            elif line.startswith("deleted file mode "):
                change_type = "deleted"
            elif line.startswith("rename from "):
                old_path = line.removeprefix("rename from ").strip()
                change_type = "renamed"
            elif line.startswith("rename to "):
                current_path = line.removeprefix("rename to ").strip()
                change_type = "renamed"
        self._store_patch_change(changes, current_path, old_path, change_type)
        return changes

    @staticmethod
    def _paths_from_diff_header(line: str) -> tuple[Optional[str], Optional[str]]:
        parts = line.split(" ")
        if len(parts) < 4:
            return None, None
        old_path = TurnFileChangeArtifactStore._strip_diff_prefix(parts[2])
        new_path = TurnFileChangeArtifactStore._strip_diff_prefix(parts[3])
        return new_path, old_path

    @staticmethod
    def _strip_diff_prefix(path: str) -> str:
        if path.startswith("a/") or path.startswith("b/"):
            return path[2:]
        return path

    @staticmethod
    def _store_patch_change(
        changes: dict[str, _ChangedPath],
        current_path: Optional[str],
        old_path: Optional[str],
        change_type: str,
    ) -> None:
        if current_path is None:
            return
        changes[current_path] = _ChangedPath(
            path=current_path,
            old_path=old_path if change_type == "renamed" else None,
            change_type=change_type,
        )

    @staticmethod
    def atomic_write(path: Path, content: bytes) -> None:
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


class NativeTurnFileChangeTracker:
    """Persist a native agent-provided turn diff as a Wegent artifact."""

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
        self._patch: bytes = b""

    def record_diff(self, diff: str | bytes | None) -> None:
        """Record the latest cumulative native turn diff."""
        if diff is None:
            return
        self._patch = diff if isinstance(diff, bytes) else diff.encode("utf-8")

    async def finalize(self) -> dict[str, Any]:
        """Persist the latest native diff and return completion fields."""
        return TurnFileChangeArtifactStore(
            workspace=self.workspace,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            executor_home=self.executor_home,
            device_id=self.device_id,
        ).completion_fields_from_patch(self._patch)

    async def abort(self) -> None:
        """Discard the native diff."""
        self._patch = b""


class ClaudeToolFileChangeTracker:
    """Capture Claude built-in file-editing tool changes at tool boundaries."""

    EDIT_TOOL_MATCHER = "Write|Edit|MultiEdit|NotebookEdit"

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
        self._before_by_tool_use_id: dict[str, GitTreeSnapshot] = {}
        self._completed_tool_use_ids: set[str] = set()
        self._patches: list[bytes] = []
        self._active = _is_git_workspace(self.workspace)
        if not self._active:
            logger.info(
                "Claude tool file change tracker inactive because workspace is not Git: task_id=%s subtask_id=%s workspace=%s",
                self.task_id,
                self.subtask_id,
                self.workspace,
            )

    async def record_tool_use_start(
        self,
        tool_name: str,
        tool_use_id: str,
        tool_input: Any,
    ) -> None:
        """Capture a baseline from Claude response stream tool-use boundaries."""
        if tool_name not in {"Write", "Edit", "MultiEdit", "NotebookEdit"}:
            return
        input_data = {
            "tool_name": tool_name,
            "tool_use_id": tool_use_id,
            "tool_input": tool_input,
        }
        await self.pre_tool_use(input_data, tool_use_id, None)

    async def record_tool_result(
        self,
        tool_use_id: str,
        is_error: bool | None,
        tool_use_result: Any = None,
    ) -> None:
        """Capture a patch when Claude response stream reports a tool result."""
        if is_error:
            logger.info(
                "Claude edit patch skipped because tool result is error: task_id=%s subtask_id=%s tool_use_id=%s",
                self.task_id,
                self.subtask_id,
                tool_use_id,
            )
            self._before_by_tool_use_id.pop(tool_use_id, None)
            return
        input_data = {
            "tool_use_id": tool_use_id,
            "tool_use_result_type": (
                tool_use_result.get("type")
                if isinstance(tool_use_result, dict)
                else None
            ),
        }
        await self.post_tool_use(input_data, tool_use_id, None)

    async def pre_tool_use(
        self,
        input_data: dict[str, Any],
        tool_use_id: str | None,
        context: Any,
    ) -> dict[str, Any]:
        """Remember the Git tree immediately before a Claude edit tool runs."""
        del context
        raw_tool_use_id = tool_use_id
        tool_use_id = self._resolve_tool_use_id(input_data, tool_use_id)
        logger.info(
            "Claude file change PreToolUse hook invoked: task_id=%s subtask_id=%s tool=%s raw_tool_use_id=%s resolved_tool_use_id=%s active=%s input_keys=%s",
            self.task_id,
            self.subtask_id,
            input_data.get("tool_name"),
            raw_tool_use_id,
            tool_use_id,
            self._active,
            sorted(input_data.keys()),
        )
        if not self._active or not tool_use_id:
            return {}
        if tool_use_id in self._completed_tool_use_ids:
            logger.info(
                "Claude edit baseline skipped because tool already completed: task_id=%s subtask_id=%s tool_use_id=%s",
                self.task_id,
                self.subtask_id,
                tool_use_id,
            )
            return {}
        try:
            self._before_by_tool_use_id[tool_use_id] = self._capture_tree()
            logger.info(
                "Captured Claude edit baseline: task_id=%s subtask_id=%s tool_use_id=%s baselines=%s",
                self.task_id,
                self.subtask_id,
                tool_use_id,
                len(self._before_by_tool_use_id),
            )
        except Exception:
            logger.exception(
                "Failed to capture Claude edit baseline: task_id=%s subtask_id=%s tool_use_id=%s",
                self.task_id,
                self.subtask_id,
                tool_use_id,
            )
        return {}

    async def post_tool_use(
        self,
        input_data: dict[str, Any],
        tool_use_id: str | None,
        context: Any,
    ) -> dict[str, Any]:
        """Create a patch for one successful Claude edit tool call."""
        del context
        raw_tool_use_id = tool_use_id
        tool_use_id = self._resolve_tool_use_id(input_data, tool_use_id)
        logger.info(
            "Claude file change PostToolUse hook invoked: task_id=%s subtask_id=%s tool=%s raw_tool_use_id=%s resolved_tool_use_id=%s active=%s has_baseline=%s input_keys=%s",
            self.task_id,
            self.subtask_id,
            input_data.get("tool_name"),
            raw_tool_use_id,
            tool_use_id,
            self._active,
            bool(tool_use_id and tool_use_id in self._before_by_tool_use_id),
            sorted(input_data.keys()),
        )
        if not self._active or not tool_use_id:
            return {}
        if tool_use_id in self._completed_tool_use_ids:
            logger.info(
                "Claude edit patch skipped because tool was already captured: task_id=%s subtask_id=%s tool_use_id=%s",
                self.task_id,
                self.subtask_id,
                tool_use_id,
            )
            return {}
        before = self._before_by_tool_use_id.pop(tool_use_id, None)
        if before is None:
            logger.warning(
                "Claude edit patch skipped because baseline is missing: task_id=%s subtask_id=%s tool_use_id=%s",
                self.task_id,
                self.subtask_id,
                tool_use_id,
            )
            return {}
        try:
            after = self._capture_tree()
            patch = self._create_patch(before, after)
            if patch:
                self._patches.append(patch)
                self._completed_tool_use_ids.add(tool_use_id)
                logger.info(
                    "Captured Claude edit tool patch: task_id=%s subtask_id=%s tool_use_id=%s bytes=%s",
                    self.task_id,
                    self.subtask_id,
                    tool_use_id,
                    len(patch),
                )
            else:
                self._completed_tool_use_ids.add(tool_use_id)
                logger.info(
                    "Claude edit tool produced no file patch: task_id=%s subtask_id=%s tool_use_id=%s",
                    self.task_id,
                    self.subtask_id,
                    tool_use_id,
                )
        except Exception:
            logger.exception(
                "Failed to capture Claude edit patch: task_id=%s subtask_id=%s tool_use_id=%s",
                self.task_id,
                self.subtask_id,
                tool_use_id,
            )
        return {}

    @staticmethod
    def _resolve_tool_use_id(
        input_data: dict[str, Any],
        tool_use_id: str | None,
    ) -> str | None:
        if tool_use_id:
            return tool_use_id
        raw_tool_use_id = input_data.get("tool_use_id")
        return raw_tool_use_id if isinstance(raw_tool_use_id, str) else None

    async def finalize(self) -> dict[str, Any]:
        """Persist collected patches in reverse edit order for reliable rewind."""
        logger.info(
            "Finalizing Claude tool file changes: task_id=%s subtask_id=%s patch_count=%s pending_baselines=%s active=%s",
            self.task_id,
            self.subtask_id,
            len(self._patches),
            len(self._before_by_tool_use_id),
            self._active,
        )
        if not self._patches:
            logger.info(
                "No Claude tool file changes captured: task_id=%s subtask_id=%s workspace=%s",
                self.task_id,
                self.subtask_id,
                self.workspace,
            )
            return {}
        patch = b"\n".join(reversed(self._patches))
        return TurnFileChangeArtifactStore(
            workspace=self.workspace,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            executor_home=self.executor_home,
            device_id=self.device_id,
        ).completion_fields_from_patch(patch)

    async def abort(self) -> None:
        """Discard collected Claude edit patches."""
        self._before_by_tool_use_id.clear()
        self._completed_tool_use_ids.clear()
        self._patches.clear()

    def _capture_tree(self) -> GitTreeSnapshot:
        with tempfile.TemporaryDirectory(
            prefix="wegent-claude-tool-index-"
        ) as temp_dir:
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
            "--full-index",
            "--find-renames",
            before.tree_id,
            after.tree_id,
            text=False,
        ).stdout
