# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Global Claude Code capability synchronization for local executor mode."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from executor.platform_compat import get_permissions_manager
from executor.services.api_client import SkillDownloader
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest

logger = setup_logger("local_capabilities")

MANIFEST_VERSION = 1
DEFAULT_FULL_REPORT_INTERVAL_SECONDS = 300


def utc_now_iso() -> str:
    """Return a UTC timestamp suitable for persisted sync metadata."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def default_manifest_path() -> Path:
    """Return the Wegent managed global capability manifest path."""
    executor_home = os.environ.get(
        "WEGENT_EXECUTOR_HOME", os.path.expanduser("~/.wegent-executor")
    )
    return Path(executor_home).expanduser() / "capabilities.json"


def default_global_skills_dir() -> Path:
    """Return the Claude Code global Skills directory."""
    return Path.home() / ".claude" / "skills"


def is_project_task(task_data: ExecutionRequest) -> bool:
    """Return whether an execution request should use project-global capabilities."""
    project_id = getattr(task_data, "project_id", None)
    if project_id and int(project_id) > 0:
        return True

    workspace = getattr(task_data, "workspace", None)
    if isinstance(workspace, dict):
        metadata = workspace.get("metadata") or {}
        project = metadata.get("project") if isinstance(metadata, dict) else None
        if isinstance(project, dict) and project.get("project_id"):
            return True

    task_data_payload = getattr(task_data, "task_data", None)
    if isinstance(task_data_payload, dict) and task_data_payload.get("project_id"):
        return True

    return False


def _read_json_file(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default.copy()
    try:
        with path.open("r", encoding="utf-8") as file:
            value = json.load(file)
        return value if isinstance(value, dict) else default.copy()
    except Exception as exc:
        logger.warning("Failed to read JSON file %s: %s", path, exc)
        return default.copy()


def _canonical_digest(value: Any) -> str:
    payload = json.dumps(
        value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _set_owner_only(path: Path, *, is_directory: bool) -> None:
    try:
        get_permissions_manager().set_owner_only(str(path), is_directory=is_directory)
    except Exception as exc:
        logger.debug("Failed to set owner-only permissions for %s: %s", path, exc)


def _atomic_write_json(
    path: Path, data: dict[str, Any], *, backup: bool = True
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _set_owner_only(path.parent, is_directory=True)
    if backup and path.exists():
        backup_path = path.with_suffix(
            path.suffix + f".bak.{int(datetime.now().timestamp())}"
        )
        shutil.copy2(path, backup_path)
        _set_owner_only(backup_path, is_directory=False)

    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2, sort_keys=True)
            file.write("\n")
        _set_owner_only(temp_path, is_directory=False)
        os.replace(temp_path, path)
        _set_owner_only(path, is_directory=False)
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


@contextmanager
def _file_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = path.open("a+", encoding="utf-8")
    try:
        try:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        except ImportError:
            pass
        yield
    finally:
        try:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        except ImportError:
            pass
        lock_file.close()


class ManagedCapabilityManifest:
    """Read and write Wegent-managed global capability state."""

    def __init__(self, path: Path | None = None):
        self.path = path or default_manifest_path()

    def load(self) -> dict[str, Any]:
        data = _read_json_file(
            self.path,
            {
                "version": MANIFEST_VERSION,
                "revision": 0,
                "skills": {},
            },
        )
        data.setdefault("version", MANIFEST_VERSION)
        data.setdefault("revision", 0)
        data.setdefault("skills", {})
        data.pop("mcps", None)
        return data

    def save(self, data: dict[str, Any]) -> None:
        data["version"] = MANIFEST_VERSION
        data.setdefault("revision", 0)
        data.setdefault("skills", {})
        data.pop("mcps", None)
        _atomic_write_json(self.path, data)

    def bump_revision(self, data: dict[str, Any]) -> dict[str, Any]:
        data["revision"] = int(data.get("revision") or 0) + 1
        return data


class GlobalCapabilityStore:
    """Manage the Wegent global capability manifest."""

    def __init__(
        self,
        manifest: ManagedCapabilityManifest | None = None,
    ):
        self.manifest = manifest or ManagedCapabilityManifest()
        self._lock_path = self.manifest.path.with_suffix(".lock")

    def record_skill(self, skill: dict[str, Any]) -> None:
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            skills = manifest.setdefault("skills", {})
            skills[skill["name"]] = {
                "skill_id": skill.get("id"),
                "namespace": skill.get("namespace", "default"),
                "updated_at": utc_now_iso(),
            }
            self.manifest.save(self.manifest.bump_revision(manifest))


class GlobalCapabilityReporter:
    """Build sanitized global capability heartbeat reports."""

    def __init__(
        self,
        skills_dir: Path | None = None,
        manifest: ManagedCapabilityManifest | None = None,
        full_report_interval_seconds: int = DEFAULT_FULL_REPORT_INTERVAL_SECONDS,
    ):
        self.skills_dir = skills_dir or default_global_skills_dir()
        self.manifest = manifest or ManagedCapabilityManifest()
        self.full_report_interval_seconds = full_report_interval_seconds
        self._last_digest: str | None = None
        self._last_full_report_at = 0.0
        self._force_next_full = True

    def force_next_full_report(self) -> None:
        self._force_next_full = True

    def build_report(self, *, force_full: bool = False) -> dict[str, Any]:
        import time

        manifest_data = self.manifest.load()
        skills = self._scan_skills(manifest_data)
        digest = _canonical_digest({"skills": skills})
        now = time.time()
        should_full = (
            force_full
            or self._force_next_full
            or digest != self._last_digest
            or now - self._last_full_report_at >= self.full_report_interval_seconds
        )

        report = {
            "revision": manifest_data.get("revision", 0),
            "digest": digest,
            "full": should_full,
        }
        if should_full:
            report.update(
                {
                    "skills": skills,
                    "last_sync_at": manifest_data.get("last_sync_at"),
                }
            )
            self._last_full_report_at = now
            self._force_next_full = False
        self._last_digest = digest
        return report

    def _scan_skills(self, manifest_data: dict[str, Any]) -> list[dict[str, Any]]:
        manifest_skills = manifest_data.get("skills") or {}
        results: list[dict[str, Any]] = []
        if not self.skills_dir.exists():
            return results

        for child in sorted(self.skills_dir.iterdir(), key=lambda item: item.name):
            if not child.is_dir() or not (child / "SKILL.md").exists():
                continue
            managed = manifest_skills.get(child.name)
            if managed:
                results.append(
                    {
                        "name": child.name,
                        "skill_id": managed.get("skill_id"),
                        "namespace": managed.get("namespace", "default"),
                        "source": "wegent",
                    }
                )
            else:
                results.append({"name": child.name, "source": "local_user"})
        return results


class CapabilitySyncHandler:
    """Handle Backend device:sync_capabilities RPCs."""

    def __init__(
        self,
        auth_token: str,
        store: GlobalCapabilityStore | None = None,
        reporter: GlobalCapabilityReporter | None = None,
        skills_dir: Path | None = None,
    ):
        self.auth_token = auth_token
        self.store = store or GlobalCapabilityStore()
        self.reporter = reporter
        self.skills_dir = skills_dir or default_global_skills_dir()

    async def handle_sync_capabilities(self, data: dict[str, Any]) -> dict[str, Any]:
        mode = data.get("mode") or "merge"
        if mode not in {"merge", "replace"}:
            return {"success": False, "errors": [{"error": "Invalid sync mode"}]}
        if data.get("mcps"):
            return {
                "success": False,
                "skills": [],
                "errors": [{"error": "MCP capability sync is temporarily disabled"}],
            }

        skill_results = self._sync_skills(data.get("skills") or [])
        success = not any(item.get("status") == "failed" for item in skill_results)
        errors = [item for item in skill_results if item.get("status") == "failed"]

        manifest = self.store.manifest.load()
        manifest["last_sync_at"] = utc_now_iso()
        self.store.manifest.save(self.store.manifest.bump_revision(manifest))
        if self.reporter:
            self.reporter.force_next_full_report()

        return {
            "success": success,
            "mode": mode,
            "skills": skill_results,
            "errors": errors,
        }

    def _sync_skills(self, skills: list[dict[str, Any]]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        if not skills:
            return results
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        _set_owner_only(self.skills_dir, is_directory=True)

        downloader = SkillDownloader(
            auth_token=self.auth_token,
            team_namespace="default",
            skills_dir=str(self.skills_dir),
        )
        for skill in skills:
            name = skill.get("name")
            skill_id = skill.get("id")
            namespace = skill.get("namespace", "default")
            if not name or not skill_id:
                results.append(
                    {
                        "id": skill_id,
                        "name": name,
                        "status": "failed",
                        "error": "Invalid Skill entry",
                    }
                )
                continue
            before_digest = self._skill_digest(name)
            ok = downloader._download_single_skill(
                name,
                {
                    "skill_id": skill_id,
                    "namespace": namespace,
                    "is_public": skill.get("is_public", False),
                },
            )
            if ok:
                after_digest = self._skill_digest(name)
                self.store.record_skill(skill)
                status = (
                    "skipped"
                    if before_digest and before_digest == after_digest
                    else "synced"
                )
                results.append({"id": skill_id, "name": name, "status": status})
            else:
                results.append(
                    {
                        "id": skill_id,
                        "name": name,
                        "status": "failed",
                        "error": "Failed to download Skill package",
                    }
                )
        return results

    def _skill_digest(self, name: str) -> str | None:
        path = self.skills_dir / name
        if not path.exists():
            return None
        files: list[tuple[str, str]] = []
        for file_path in sorted(item for item in path.rglob("*") if item.is_file()):
            rel = str(file_path.relative_to(path))
            files.append((rel, hashlib.sha256(file_path.read_bytes()).hexdigest()))
        return _canonical_digest(files)
