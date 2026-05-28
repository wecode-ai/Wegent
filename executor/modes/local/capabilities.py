# SPDX-FileCopyrightText: 2026 Weibo, Inc.
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
    return bool(
        isinstance(task_data_payload, dict) and task_data_payload.get("project_id")
    )


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
                "mcps": {},
            },
        )
        data.setdefault("version", MANIFEST_VERSION)
        data.setdefault("revision", 0)
        data.setdefault("skills", {})
        data.setdefault("mcps", {})
        return data

    def save(self, data: dict[str, Any]) -> None:
        data["version"] = MANIFEST_VERSION
        data.setdefault("revision", 0)
        data.setdefault("skills", {})
        data.setdefault("mcps", {})
        _atomic_write_json(self.path, data)

    def bump_revision(self, data: dict[str, Any]) -> dict[str, Any]:
        data["revision"] = int(data.get("revision") or 0) + 1
        return data


class GlobalCapabilityStore:
    """Manage the Wegent global capability manifest."""

    def __init__(
        self,
        *,
        manifest: ManagedCapabilityManifest | None = None,
        manifest_path: Path | None = None,
        skills_dir: Path | None = None,
    ):
        self.manifest = manifest or ManagedCapabilityManifest(
            path=manifest_path or default_manifest_path()
        )
        self.skills_dir = skills_dir or default_global_skills_dir()
        self._lock_path = self.manifest.path.with_suffix(".lock")

    def record_skill(self, skill: dict[str, Any]) -> None:
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            skills = manifest.setdefault("skills", {})
            skills[skill["name"]] = self._skill_record(skill)
            self.manifest.save(self.manifest.bump_revision(manifest))

    def replace_records(
        self,
        *,
        skills: dict[str, dict[str, Any]],
        mcps: dict[str, dict[str, Any]],
    ) -> None:
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            manifest["skills"] = skills
            manifest["mcps"] = mcps
            self.manifest.save(self.manifest.bump_revision(manifest))

    def merge_records(
        self,
        *,
        skills: dict[str, dict[str, Any]],
        mcps: dict[str, dict[str, Any]],
    ) -> None:
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            manifest.setdefault("skills", {}).update(skills)
            manifest.setdefault("mcps", {}).update(mcps)
            self.manifest.save(self.manifest.bump_revision(manifest))

    def remove_stale_managed_skills(self, desired_names: set[str]) -> list[str]:
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            removed = []
            for name, record in list(manifest.get("skills", {}).items()):
                managed = (
                    record.get("managed", True) if isinstance(record, dict) else False
                )
                if name in desired_names or not managed:
                    continue
                skill_path = self.skills_dir / name
                if skill_path.exists() and self._is_child(skill_path, self.skills_dir):
                    shutil.rmtree(skill_path)
                    removed.append(name)
                manifest["skills"].pop(name, None)
            if removed:
                self.manifest.save(self.manifest.bump_revision(manifest))
            return removed

    def _skill_record(self, skill: dict[str, Any]) -> dict[str, Any]:
        record = {
            "skill_id": skill.get("id") or skill.get("skill_id"),
            "namespace": skill.get("namespace", "default"),
            "updated_at": utc_now_iso(),
        }
        if skill.get("installed_skill_id") is not None:
            record["installed_skill_id"] = skill.get("installed_skill_id")
        return record

    def _is_child(self, path: Path, parent: Path) -> bool:
        try:
            path.resolve().relative_to(parent.resolve())
            return True
        except ValueError:
            return False


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
        mcps = self._scan_mcps(manifest_data)
        digest = _canonical_digest({"skills": skills, "mcps": mcps})
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
                    "mcps": mcps,
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

    def _scan_mcps(self, manifest_data: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            {
                "name": name,
                "installed_mcp_id": record.get("installed_mcp_id"),
                "server": record.get("server") or {},
                "source": "wegent",
            }
            for name, record in sorted((manifest_data.get("mcps") or {}).items())
            if isinstance(record, dict)
        ]


class CapabilitySyncHandler:
    """Handle Backend device:sync_capabilities RPCs."""

    def __init__(
        self,
        auth_token: str | None = None,
        store: GlobalCapabilityStore | None = None,
        reporter: GlobalCapabilityReporter | None = None,
        skills_dir: Path | None = None,
    ):
        self.auth_token = auth_token or os.getenv("WEGENT_AUTH_TOKEN", "")
        self.skills_dir = skills_dir or default_global_skills_dir()
        self.store = store or GlobalCapabilityStore(skills_dir=self.skills_dir)
        self.reporter = reporter

    async def handle_sync_capabilities(self, data: dict[str, Any]) -> dict[str, Any]:
        return self.apply_sync(data)

    def apply_sync(self, data: dict[str, Any]) -> dict[str, Any]:
        mode = data.get("mode") or "merge"
        if mode not in {"merge", "replace"}:
            return {"success": False, "errors": [{"error": "Invalid sync mode"}]}

        skills = data.get("skills") or []
        mcps = data.get("mcps") or []
        logger.info(
            "Received capability sync: mode=%s skills=%s mcps=%s skill_names=%s mcp_names=%s manifest=%s skills_dir=%s",
            mode,
            len(skills),
            len(mcps),
            [item.get("name") for item in skills if isinstance(item, dict)],
            [item.get("name") for item in mcps if isinstance(item, dict)],
            self.store.manifest.path,
            self.skills_dir,
        )
        desired_skill_names = {
            item.get("name")
            for item in skills
            if isinstance(item, dict) and item.get("name")
        }
        removed = (
            self.store.remove_stale_managed_skills(desired_skill_names)
            if mode == "replace"
            else []
        )
        skill_results, skill_records = self._sync_skills(skills)
        mcp_results, mcp_records = self._sync_mcps(mcps)

        before_manifest = self.store.manifest.load()
        logger.info(
            "Persisting capability manifest: mode=%s old_skills=%s new_skills=%s old_mcps=%s new_mcps=%s",
            mode,
            sorted((before_manifest.get("skills") or {}).keys()),
            sorted(skill_records.keys()),
            sorted((before_manifest.get("mcps") or {}).keys()),
            sorted(mcp_records.keys()),
        )
        if mode == "replace":
            self.store.replace_records(skills=skill_records, mcps=mcp_records)
        else:
            self.store.merge_records(skills=skill_records, mcps=mcp_records)

        manifest = self.store.manifest.load()
        manifest["last_sync_at"] = utc_now_iso()
        self.store.manifest.save(self.store.manifest.bump_revision(manifest))
        if self.reporter:
            self.reporter.force_next_full_report()

        results = skill_results + mcp_results
        errors = [item for item in results if item.get("status") == "failed"]
        logger.info(
            "Capability sync applied: success=%s mode=%s installed_skills=%s configured_mcps=%s removed_skills=%s errors=%s",
            not errors,
            mode,
            sorted(skill_records.keys()),
            sorted(mcp_records.keys()),
            removed,
            errors,
        )
        return {
            "success": not errors,
            "mode": mode,
            "skills": skill_results,
            "mcps": mcp_results,
            "errors": errors,
            "installed_skills": sorted(skill_records.keys()),
            "configured_mcps": sorted(mcp_records.keys()),
            "removed_skills": removed,
        }

    def _sync_skills(
        self, skills: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
        results: list[dict[str, Any]] = []
        records: dict[str, dict[str, Any]] = {}
        if not skills:
            logger.info("No skills requested in capability sync")
            return results, records
        if not self.auth_token:
            logger.warning(
                "Cannot sync skills because no auth token is available: skill_names=%s",
                [item.get("name") for item in skills if isinstance(item, dict)],
            )
            return [
                {
                    "id": item.get("id") or item.get("skill_id"),
                    "name": item.get("name"),
                    "status": "failed",
                    "error": "No auth token available",
                }
                for item in skills
                if isinstance(item, dict)
            ], records

        self.skills_dir.mkdir(parents=True, exist_ok=True)
        _set_owner_only(self.skills_dir, is_directory=True)
        downloader = SkillDownloader(
            auth_token=self.auth_token,
            team_namespace="default",
            skills_dir=str(self.skills_dir),
        )

        for skill in skills:
            name = skill.get("name")
            skill_id = skill.get("id") or skill.get("skill_id")
            namespace = skill.get("namespace", "default")
            if not name or not skill_id:
                logger.warning("Invalid Skill entry in capability sync: %s", skill)
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
            if (self.skills_dir / name).is_dir():
                record = dict(skill)
                record["id"] = skill_id
                records[name] = self.store._skill_record(record)
                logger.info(
                    "Global skill already present: name=%s skill_id=%s namespace=%s",
                    name,
                    skill_id,
                    namespace,
                )
                results.append({"id": skill_id, "name": name, "status": "skipped"})
                continue
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
                record = dict(skill)
                record["id"] = skill_id
                records[name] = self.store._skill_record(record)
                status = (
                    "skipped"
                    if before_digest and before_digest == after_digest
                    else "synced"
                )
                logger.info(
                    "Installed global skill: name=%s skill_id=%s namespace=%s status=%s",
                    name,
                    skill_id,
                    namespace,
                    status,
                )
                results.append({"id": skill_id, "name": name, "status": status})
            else:
                logger.warning(
                    "Failed to install global skill: name=%s skill_id=%s namespace=%s",
                    name,
                    skill_id,
                    namespace,
                )
                results.append(
                    {
                        "id": skill_id,
                        "name": name,
                        "status": "failed",
                        "error": "Failed to download Skill package",
                    }
                )
        return results, records

    def _sync_mcps(
        self, mcps: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
        results: list[dict[str, Any]] = []
        records: dict[str, dict[str, Any]] = {}
        for item in mcps:
            if not isinstance(item, dict):
                logger.warning(
                    "Ignoring invalid MCP entry in capability sync: %s", item
                )
                continue
            name = item.get("name")
            if not name:
                results.append(
                    {"name": None, "status": "failed", "error": "Invalid MCP entry"}
                )
                continue
            server = item.get("server") or {}
            records[name] = {
                "name": name,
                "installed_mcp_id": item.get("installed_mcp_id"),
                "display_name": item.get("display_name") or item.get("displayName"),
                "description": item.get("description", ""),
                "source": item.get("source") or {},
                "server": server,
                "managed": True,
                "updated_at": utc_now_iso(),
            }
            logger.info(
                "Configured global MCP: name=%s installed_mcp_id=%s server=%s",
                name,
                item.get("installed_mcp_id"),
                self._server_summary(server),
            )
            results.append(
                {
                    "id": item.get("installed_mcp_id"),
                    "name": name,
                    "status": "synced",
                }
            )
        return results, records

    def _server_summary(self, server: dict[str, Any]) -> dict[str, Any]:
        return {
            key: server.get(key)
            for key in ("type", "url", "command")
            if server.get(key) is not None
        }

    def _skill_digest(self, name: str) -> str | None:
        path = self.skills_dir / name
        if not path.exists():
            return None
        files: list[tuple[str, str]] = []
        for file_path in sorted(item for item in path.rglob("*") if item.is_file()):
            rel = str(file_path.relative_to(path))
            files.append((rel, hashlib.sha256(file_path.read_bytes()).hexdigest()))
        return _canonical_digest(files)
