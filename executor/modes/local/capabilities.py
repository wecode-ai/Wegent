# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Global Claude Code capability synchronization for local executor mode."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tempfile
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from executor.platform_compat import get_permissions_manager
from executor.services.api_client import ApiClient, SkillDownloader

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


def default_global_plugins_dir() -> Path:
    """Return the Claude Code global Plugins directory."""
    return Path.home() / ".claude" / "plugins"


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
                "plugins": {},
                "mcps": {},
            },
        )
        data.setdefault("version", MANIFEST_VERSION)
        data.setdefault("revision", 0)
        data.setdefault("skills", {})
        data.setdefault("plugins", {})
        data.setdefault("mcps", {})
        return data

    def save(self, data: dict[str, Any]) -> None:
        data["version"] = MANIFEST_VERSION
        data.setdefault("revision", 0)
        data.setdefault("skills", {})
        data.setdefault("plugins", {})
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
        plugins_dir: Path | None = None,
    ):
        self.manifest = manifest or ManagedCapabilityManifest(
            path=manifest_path or default_manifest_path()
        )
        self.skills_dir = skills_dir or default_global_skills_dir()
        self.plugins_dir = plugins_dir or default_global_plugins_dir()
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
        plugins: dict[str, dict[str, Any]] | None = None,
        mcps: dict[str, dict[str, Any]],
    ) -> None:
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            manifest["skills"] = skills
            if plugins is not None:
                manifest["plugins"] = plugins
            manifest["mcps"] = mcps
            self.manifest.save(self.manifest.bump_revision(manifest))

    def merge_records(
        self,
        *,
        skills: dict[str, dict[str, Any]],
        plugins: dict[str, dict[str, Any]] | None = None,
        mcps: dict[str, dict[str, Any]],
    ) -> None:
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            manifest.setdefault("skills", {}).update(skills)
            if plugins is not None:
                manifest.setdefault("plugins", {}).update(plugins)
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

    def remove_stale_managed_plugins(self, desired_keys: set[str]) -> list[str]:
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            installed_plugins = self._load_installed_plugins()
            installed_map = installed_plugins.setdefault("plugins", {})
            removed = []
            changed = False
            for key, record in list((manifest.get("plugins") or {}).items()):
                managed = (
                    record.get("managed", True) if isinstance(record, dict) else False
                )
                if key in desired_keys or not managed:
                    continue
                if key in installed_map:
                    installed_map.pop(key, None)
                    removed.append(key)
                    changed = True
                manifest.setdefault("plugins", {}).pop(key, None)
                changed = True
            if changed:
                self._save_installed_plugins(installed_plugins)
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

    def _load_installed_plugins(self) -> dict[str, Any]:
        return _read_json_file(
            self.plugins_dir / "installed_plugins.json",
            {"version": 2, "plugins": {}},
        )

    def _save_installed_plugins(self, data: dict[str, Any]) -> None:
        data.setdefault("version", 2)
        data.setdefault("plugins", {})
        _atomic_write_json(self.plugins_dir / "installed_plugins.json", data)

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
        plugins_dir: Path | None = None,
        manifest: ManagedCapabilityManifest | None = None,
        full_report_interval_seconds: int = DEFAULT_FULL_REPORT_INTERVAL_SECONDS,
    ):
        self.skills_dir = skills_dir or default_global_skills_dir()
        self.plugins_dir = plugins_dir or default_global_plugins_dir()
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
        plugins = self._scan_plugins(manifest_data)
        mcps = self._scan_mcps(manifest_data)
        digest = _canonical_digest({"skills": skills, "plugins": plugins, "mcps": mcps})
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
                    "plugins": plugins,
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

    def _scan_plugins(self, manifest_data: dict[str, Any]) -> list[dict[str, Any]]:
        installed_plugins_path = self.plugins_dir / "installed_plugins.json"
        data = _read_json_file(installed_plugins_path, {"plugins": {}})
        plugins = data.get("plugins") or {}
        if not isinstance(plugins, dict):
            return []

        manifest_plugins = manifest_data.get("plugins") or {}
        results: list[dict[str, Any]] = []
        for plugin_key, installs in sorted(plugins.items()):
            if not isinstance(installs, list):
                continue
            plugin_name, marketplace = self._split_plugin_key(plugin_key)
            managed = manifest_plugins.get(plugin_key)
            for install in installs:
                if not isinstance(install, dict):
                    continue
                record = {
                    "name": plugin_name,
                    "marketplace": marketplace,
                    "scope": install.get("scope", "user"),
                    "version": install.get("version"),
                    "source": "wegent" if managed else "local_user",
                    "installed_at": install.get("installedAt"),
                    "last_updated": install.get("lastUpdated"),
                    "skills": self._scan_plugin_skills(
                        install.get("installPath"),
                        install.get("componentStates") or {},
                    ),
                }
                if managed:
                    record["installed_plugin_id"] = managed.get("installed_plugin_id")
                results.append(record)
        return results

    def _scan_plugin_skills(
        self, install_path: Any, component_states: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        if not install_path:
            return []
        root = Path(str(install_path)).expanduser()
        if not root.exists() or not root.is_dir():
            return []

        skills: list[dict[str, Any]] = []
        seen_paths: set[str] = set()
        for skill_file in sorted(root.rglob("SKILL.md")):
            if not skill_file.is_file():
                continue
            relative_parent = str(skill_file.parent.relative_to(root))
            if relative_parent == "." or relative_parent in seen_paths:
                continue
            metadata = self._read_skill_metadata(skill_file)
            skill_name = metadata.get("name") or skill_file.parent.name
            if (
                component_states
                and component_states.get(f"skill:{skill_name}") is False
            ):
                continue
            skills.append(
                {
                    "name": skill_name,
                    "description": metadata.get("description", ""),
                    "path": relative_parent,
                }
            )
            seen_paths.add(relative_parent)
        return skills

    def _read_skill_metadata(self, skill_file: Path) -> dict[str, str]:
        try:
            lines = skill_file.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            logger.debug("Failed to read plugin Skill metadata %s: %s", skill_file, exc)
            return {}
        if not lines or lines[0].strip() != "---":
            return {}
        metadata: dict[str, str] = {}
        for line in lines[1:]:
            if line.strip() == "---":
                break
            key, separator, value = line.partition(":")
            if not separator:
                continue
            normalized_key = key.strip()
            if normalized_key in {"name", "description"}:
                metadata[normalized_key] = value.strip().strip("\"'")
        return metadata

    def _split_plugin_key(self, plugin_key: str) -> tuple[str, str | None]:
        if "@" not in plugin_key:
            return plugin_key, None
        plugin_name, marketplace = plugin_key.split("@", 1)
        return plugin_name, marketplace or None

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
        plugins_dir: Path | None = None,
    ):
        self.auth_token = auth_token or os.getenv("WEGENT_AUTH_TOKEN", "")
        self.skills_dir = skills_dir or default_global_skills_dir()
        self.plugins_dir = plugins_dir or default_global_plugins_dir()
        self.store = store or GlobalCapabilityStore(
            skills_dir=self.skills_dir,
            plugins_dir=self.plugins_dir,
        )
        self.reporter = reporter

    async def handle_sync_capabilities(self, data: dict[str, Any]) -> dict[str, Any]:
        return self.apply_sync(data)

    def apply_sync(self, data: dict[str, Any]) -> dict[str, Any]:
        mode = data.get("mode") or "merge"
        if mode not in {"merge", "replace"}:
            return {"success": False, "errors": [{"error": "Invalid sync mode"}]}

        skills = data.get("skills") or []
        plugins = data.get("plugins") or []
        mcps = data.get("mcps") or []
        logger.info(
            "Received capability sync: mode=%s skills=%s plugins=%s mcps=%s skill_names=%s plugin_names=%s mcp_names=%s manifest=%s skills_dir=%s plugins_dir=%s",
            mode,
            len(skills),
            len(plugins),
            len(mcps),
            [item.get("name") for item in skills if isinstance(item, dict)],
            [item.get("name") for item in plugins if isinstance(item, dict)],
            [item.get("name") for item in mcps if isinstance(item, dict)],
            self.store.manifest.path,
            self.skills_dir,
            self.plugins_dir,
        )
        desired_skill_names = {
            item.get("name")
            for item in skills
            if isinstance(item, dict) and item.get("name")
        }
        desired_plugin_keys = {
            self._plugin_key(item.get("name"), self._plugin_marketplace(item))
            for item in plugins
            if isinstance(item, dict) and item.get("name")
        }
        removed_skills = (
            self.store.remove_stale_managed_skills(desired_skill_names)
            if mode == "replace"
            else []
        )
        removed_plugins = (
            self.store.remove_stale_managed_plugins(desired_plugin_keys)
            if mode == "replace"
            else []
        )
        skill_results, skill_records = self._sync_skills(skills)
        plugin_results, plugin_records = self._sync_plugins(plugins)
        mcp_results, mcp_records = self._sync_mcps(mcps)

        before_manifest = self.store.manifest.load()
        logger.info(
            "Persisting capability manifest: mode=%s old_skills=%s new_skills=%s old_plugins=%s new_plugins=%s old_mcps=%s new_mcps=%s",
            mode,
            sorted((before_manifest.get("skills") or {}).keys()),
            sorted(skill_records.keys()),
            sorted((before_manifest.get("plugins") or {}).keys()),
            sorted(plugin_records.keys()),
            sorted((before_manifest.get("mcps") or {}).keys()),
            sorted(mcp_records.keys()),
        )
        if mode == "replace":
            self.store.replace_records(
                skills=skill_records,
                plugins=plugin_records,
                mcps=mcp_records,
            )
        else:
            self.store.merge_records(
                skills=skill_records,
                plugins=plugin_records,
                mcps=mcp_records,
            )

        manifest = self.store.manifest.load()
        manifest["last_sync_at"] = utc_now_iso()
        self.store.manifest.save(self.store.manifest.bump_revision(manifest))
        if self.reporter:
            self.reporter.force_next_full_report()

        results = skill_results + plugin_results + mcp_results
        errors = [item for item in results if item.get("status") == "failed"]
        logger.info(
            "Capability sync applied: success=%s mode=%s installed_skills=%s installed_plugins=%s configured_mcps=%s removed_skills=%s removed_plugins=%s errors=%s",
            not errors,
            mode,
            sorted(skill_records.keys()),
            sorted(plugin_records.keys()),
            sorted(mcp_records.keys()),
            removed_skills,
            removed_plugins,
            errors,
        )
        return {
            "success": not errors,
            "mode": mode,
            "skills": skill_results,
            "plugins": plugin_results,
            "mcps": mcp_results,
            "errors": errors,
            "installed_skills": sorted(skill_records.keys()),
            "configured_plugins": sorted(plugin_records.keys()),
            "configured_mcps": sorted(mcp_records.keys()),
            "removed_skills": removed_skills,
            "removed_plugins": removed_plugins,
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

    def _sync_plugins(
        self, plugins: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
        results: list[dict[str, Any]] = []
        records: dict[str, dict[str, Any]] = {}
        if not plugins:
            logger.info("No plugins requested in capability sync")
            return results, records

        installed_plugins = self.store._load_installed_plugins()
        installed_map = installed_plugins.setdefault("plugins", {})
        self.plugins_dir.mkdir(parents=True, exist_ok=True)
        _set_owner_only(self.plugins_dir, is_directory=True)
        client = ApiClient(self.auth_token) if self.auth_token else None

        for item in plugins:
            if not isinstance(item, dict):
                logger.warning(
                    "Ignoring invalid Plugin entry in capability sync: %s", item
                )
                continue
            name = item.get("name")
            marketplace = self._plugin_marketplace(item)
            if not name:
                results.append(
                    {"name": None, "status": "failed", "error": "Invalid Plugin entry"}
                )
                continue
            key = self._plugin_key(name, marketplace)
            install_path = self._plugin_install_path(item, name, marketplace)
            expected_checksum = item.get("checksum")
            should_download = not install_path.exists()
            if (
                isinstance(expected_checksum, str)
                and expected_checksum
                and self._persisted_plugin_checksum(installed_map, key, item)
                != expected_checksum
            ):
                should_download = True
            if should_download and item.get("download_path"):
                if not client:
                    results.append(
                        {
                            "id": item.get("installed_plugin_id"),
                            "name": name,
                            "status": "failed",
                            "error": "No auth token available",
                        }
                    )
                    continue
                if not self._download_plugin_package(client, item, install_path):
                    results.append(
                        {
                            "id": item.get("installed_plugin_id"),
                            "name": name,
                            "status": "failed",
                            "error": "Failed to download Plugin package",
                        }
                    )
                    continue
            if not install_path.exists() or not install_path.is_dir():
                logger.warning(
                    "Plugin package not found in local cache: name=%s marketplace=%s path=%s",
                    name,
                    marketplace,
                    install_path,
                )
                results.append(
                    {
                        "id": item.get("installed_plugin_id"),
                        "name": name,
                        "status": "failed",
                        "error": "Plugin package not found in local cache",
                    }
                )
                continue

            scope = item.get("scope", "user")
            existing_installs = [
                install
                for install in installed_map.get(key, [])
                if isinstance(install, dict) and install.get("scope", "user") != scope
            ]
            existing_installs.append(
                {
                    "scope": scope,
                    "installPath": str(install_path),
                    "installedPluginId": item.get("installed_plugin_id"),
                    "checksum": item.get("checksum"),
                    "version": item.get("version"),
                    "componentStates": item.get("component_states") or {},
                    "installedAt": item.get("installed_at") or utc_now_iso(),
                    "lastUpdated": utc_now_iso(),
                }
            )
            installed_map[key] = existing_installs
            records[key] = self._plugin_record(item, key, marketplace, install_path)
            logger.info(
                "Configured global plugin: key=%s installed_plugin_id=%s path=%s",
                key,
                item.get("installed_plugin_id"),
                install_path,
            )
            results.append(
                {
                    "id": item.get("installed_plugin_id"),
                    "name": name,
                    "status": "synced",
                }
            )

        if records:
            self.store._save_installed_plugins(installed_plugins)
        return results, records

    def _download_plugin_package(
        self,
        client: ApiClient,
        item: dict[str, Any],
        install_path: Path,
    ) -> bool:
        download_path = item.get("download_path")
        if not isinstance(download_path, str) or not download_path:
            return False
        response = client.get(download_path, timeout=60)
        if not response:
            logger.warning(
                "Failed to download plugin package: name=%s installed_plugin_id=%s path=%s",
                item.get("name"),
                item.get("installed_plugin_id"),
                download_path,
            )
            return False

        content = response.content
        expected_checksum = item.get("checksum")
        if isinstance(expected_checksum, str) and expected_checksum:
            actual_checksum = "sha256:" + hashlib.sha256(content).hexdigest()
            if actual_checksum != expected_checksum:
                logger.warning(
                    "Plugin checksum mismatch: name=%s expected=%s actual=%s",
                    item.get("name"),
                    expected_checksum,
                    actual_checksum,
                )
                return False

        try:
            self._extract_plugin_zip(content, install_path)
            logger.info(
                "Downloaded plugin package: name=%s path=%s",
                item.get("name"),
                install_path,
            )
            return True
        except Exception as exc:
            logger.warning(
                "Failed to extract plugin package: name=%s path=%s error=%s",
                item.get("name"),
                install_path,
                exc,
            )
            return False

    def _extract_plugin_zip(self, content: bytes, install_path: Path) -> None:
        parent = install_path.parent
        parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            for member in archive.infolist():
                target = install_path / member.filename
                if not self.store._is_child(target, install_path):
                    raise ValueError(f"Unsafe path in plugin ZIP: {member.filename}")

            temp_path = parent / f".{install_path.name}.tmp-{os.getpid()}"
            staged_path = parent / f".{install_path.name}.staged-{os.getpid()}"
            if temp_path.exists():
                shutil.rmtree(temp_path)
            if staged_path.exists():
                shutil.rmtree(staged_path)
            temp_path.mkdir(parents=True)
            try:
                archive.extractall(temp_path)
                root = self._normalized_plugin_root(temp_path)
                if root != temp_path:
                    shutil.move(str(root), str(staged_path))
                else:
                    os.replace(temp_path, staged_path)
                if install_path.exists():
                    shutil.rmtree(install_path)
                os.replace(staged_path, install_path)
            finally:
                if temp_path.exists():
                    shutil.rmtree(temp_path, ignore_errors=True)
                if staged_path.exists():
                    shutil.rmtree(staged_path, ignore_errors=True)
        _set_owner_only(install_path, is_directory=True)

    def _normalized_plugin_root(self, path: Path) -> Path:
        if (path / ".claude-plugin" / "plugin.json").exists():
            return path
        children = [
            child
            for child in path.iterdir()
            if child.is_dir() and not self._is_macos_zip_metadata(child)
        ]
        if (
            len(children) == 1
            and (children[0] / ".claude-plugin" / "plugin.json").exists()
        ):
            return children[0]
        raise ValueError("Plugin package must include .claude-plugin/plugin.json")

    def _is_macos_zip_metadata(self, path: Path) -> bool:
        return path.name == "__MACOSX" or path.name.startswith("._")

    def _plugin_marketplace(self, item: dict[str, Any]) -> str | None:
        source = item.get("source") or {}
        return item.get("marketplace") or source.get("marketplace")

    def _plugin_key(self, name: str, marketplace: str | None) -> str:
        return f"{name}@{marketplace}" if marketplace else name

    def _plugin_install_path(
        self,
        item: dict[str, Any],
        name: str,
        marketplace: str | None,
    ) -> Path:
        raw_path = item.get("installPath") or item.get("install_path")
        if raw_path:
            return Path(str(raw_path)).expanduser()
        return (
            self.plugins_dir
            / "cache"
            / (marketplace or "local")
            / name
            / str(item.get("version") or "latest")
        )

    def _persisted_plugin_checksum(
        self,
        installed_map: dict[str, Any],
        key: str,
        item: dict[str, Any],
    ) -> str | None:
        installs = installed_map.get(key, [])
        if not isinstance(installs, list):
            return None

        installed_plugin_id = item.get("installed_plugin_id")
        scope = item.get("scope", "user")
        for install in installs:
            if not isinstance(install, dict):
                continue
            if (
                installed_plugin_id
                and install.get("installedPluginId") == installed_plugin_id
            ):
                checksum = install.get("checksum")
                return checksum if isinstance(checksum, str) else None

        for install in installs:
            if not isinstance(install, dict) or install.get("scope", "user") != scope:
                continue
            checksum = install.get("checksum")
            return checksum if isinstance(checksum, str) else None
        return None

    def _plugin_record(
        self,
        item: dict[str, Any],
        key: str,
        marketplace: str | None,
        install_path: Path,
    ) -> dict[str, Any]:
        return {
            "name": item.get("name"),
            "key": key,
            "installed_plugin_id": item.get("installed_plugin_id"),
            "display_name": item.get("display_name") or item.get("displayName"),
            "description": item.get("description", ""),
            "marketplace": marketplace,
            "version": item.get("version"),
            "source": item.get("source") or {},
            "checksum": item.get("checksum"),
            "component_states": item.get("component_states") or {},
            "components": item.get("components") or {},
            "install_path": str(install_path),
            "managed": True,
            "updated_at": utc_now_iso(),
        }

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
