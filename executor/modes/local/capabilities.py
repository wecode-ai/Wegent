# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Global Claude Code capability synchronization for local executor mode."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
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
    return Path(executor_home).expanduser() / "capabilities" / "manifest.json"


def default_store_dir() -> Path:
    """Return the centralized Wegent capability package store directory."""
    return default_manifest_path().parent / "store"


def default_global_skills_dir() -> Path:
    """Return the Claude Code global Skills directory."""
    return Path.home() / ".claude" / "skills"


def default_global_plugins_dir() -> Path:
    """Return the Claude Code global Plugins directory."""
    return Path.home() / ".claude" / "plugins"


def default_codex_skills_dir() -> Path:
    """Return the Codex global Skills directory."""
    return Path.home() / ".codex" / "skills"


def default_codex_plugins_dir() -> Path:
    """Return the Codex global Plugins directory."""
    return Path.home() / ".codex" / "plugins"


def default_claude_mcp_config_path() -> Path:
    """Return the Claude Code user-scoped MCP config file."""
    return Path.home() / ".claude.json"


def default_codex_config_path() -> Path:
    """Return the Codex global config file."""
    return Path.home() / ".codex" / "config.toml"


def _peer_codex_capability_dir(source_dir: Path, directory_name: str) -> Path:
    root = (
        source_dir.parent.parent
        if source_dir.parent.name == ".claude"
        else source_dir.parent
    )
    return root / ".codex" / directory_name


def is_project_task(task_data: ExecutionRequest) -> bool:
    """Return whether an execution request should use project-global capabilities."""
    if getattr(task_data, "standalone_chat_workspace", False):
        return True

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


def get_project_capability_revision(task_data: ExecutionRequest) -> int | None:
    """Return current global capability revision for project tasks only."""
    if not is_project_task(task_data):
        return None

    try:
        revision = ManagedCapabilityManifest().load().get("revision")
        return int(revision) if revision is not None else 0
    except Exception as exc:
        logger.warning("Failed to read global capability revision: %s", exc)
        return None


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


def _atomic_write_text(path: Path, content: str, *, backup: bool = True) -> None:
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
            file.write(content)
        _set_owner_only(temp_path, is_directory=False)
        os.replace(temp_path, path)
        _set_owner_only(path, is_directory=False)
    finally:
        temp_path.unlink(missing_ok=True)


def _read_toml_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        try:
            import tomllib
        except ModuleNotFoundError:
            import tomli as tomllib  # type: ignore[no-redef]

        with path.open("rb") as file:
            value = tomllib.load(file)
        return value if isinstance(value, dict) else {}
    except Exception as exc:
        logger.warning("Failed to read TOML file %s: %s", path, exc)
        return {}


def _toml_key_segment(segment: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]+", segment):
        return segment
    return json.dumps(segment)


def _toml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(_toml_scalar(item) for item in value) + "]"
    return json.dumps(str(value))


def _toml_sort_key(item: tuple[str, Any]) -> tuple[int, str]:
    return (1 if isinstance(item[1], dict) else 0, item[0])


def _dump_toml(data: dict[str, Any]) -> str:
    lines: list[str] = []

    def write_table(table: dict[str, Any], path: list[str]) -> None:
        scalar_items = [
            (key, value)
            for key, value in sorted(table.items(), key=_toml_sort_key)
            if not isinstance(value, dict)
        ]
        nested_items = [
            (key, value)
            for key, value in sorted(table.items(), key=_toml_sort_key)
            if isinstance(value, dict)
        ]
        if path:
            if lines and lines[-1] != "":
                lines.append("")
            lines.append("[" + ".".join(_toml_key_segment(part) for part in path) + "]")
        for key, value in scalar_items:
            if value is None:
                continue
            lines.append(f"{_toml_key_segment(key)} = {_toml_scalar(value)}")
        for key, value in nested_items:
            if value:
                write_table(value, [*path, key])

    write_table(data, [])
    return "\n".join(lines).rstrip() + "\n"


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
        codex_skills_dir: Path | None = None,
        codex_plugins_dir: Path | None = None,
        claude_mcp_config_path: Path | None = None,
        codex_config_path: Path | None = None,
        store_dir: Path | None = None,
    ):
        self.manifest = manifest or ManagedCapabilityManifest(
            path=manifest_path or default_manifest_path()
        )
        self.skills_dir = skills_dir or default_global_skills_dir()
        self.plugins_dir = plugins_dir or default_global_plugins_dir()
        self.codex_skills_dir = codex_skills_dir or (
            default_codex_skills_dir()
            if skills_dir is None
            else _peer_codex_capability_dir(self.skills_dir, "skills")
        )
        self.codex_plugins_dir = codex_plugins_dir or (
            default_codex_plugins_dir()
            if plugins_dir is None
            else _peer_codex_capability_dir(self.plugins_dir, "plugins")
        )
        self.claude_mcp_config_path = (
            claude_mcp_config_path or default_claude_mcp_config_path()
        )
        self.codex_config_path = codex_config_path or default_codex_config_path()
        self.store_dir = store_dir or default_store_dir()
        self.skill_store_dir = self.store_dir / "skills"
        self.plugin_store_dir = self.store_dir / "plugins"
        self._lock_path = self.manifest.path.with_suffix(".lock")

    def load(self) -> dict[str, Any]:
        return self.manifest.load()

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

    def sync_global_mcp_configs(
        self,
        *,
        mcps: dict[str, dict[str, Any]],
        remove_managed_names: set[str] | None = None,
    ) -> None:
        """Write synced MCP servers into Claude Code and Codex global configs."""
        remove_names = remove_managed_names or set()
        if not mcps and not remove_names:
            return
        self._sync_claude_mcp_config(mcps=mcps, remove_names=remove_names)
        self._sync_codex_mcp_config(mcps=mcps, remove_names=remove_names)

    def _sync_claude_mcp_config(
        self,
        *,
        mcps: dict[str, dict[str, Any]],
        remove_names: set[str],
    ) -> None:
        config = _read_json_file(self.claude_mcp_config_path, {})
        servers = config.get("mcpServers")
        if not isinstance(servers, dict):
            servers = {}

        for name in remove_names:
            servers.pop(name, None)
        for name, record in sorted(mcps.items()):
            server = record.get("server") if isinstance(record, dict) else None
            if not isinstance(server, dict):
                continue
            normalized = self._normalize_claude_mcp_server(server)
            if normalized:
                servers[name] = normalized

        if servers:
            config["mcpServers"] = servers
        else:
            config.pop("mcpServers", None)
        _atomic_write_json(self.claude_mcp_config_path, config)

    def _sync_codex_mcp_config(
        self,
        *,
        mcps: dict[str, dict[str, Any]],
        remove_names: set[str],
    ) -> None:
        config = _read_toml_file(self.codex_config_path)
        servers = config.get("mcp_servers")
        if not isinstance(servers, dict):
            servers = {}

        for name in remove_names:
            servers.pop(name, None)
        for name, record in sorted(mcps.items()):
            server = record.get("server") if isinstance(record, dict) else None
            if not isinstance(server, dict):
                continue
            normalized = self._normalize_codex_mcp_server(server)
            if normalized:
                servers[name] = normalized

        if servers:
            config["mcp_servers"] = servers
        else:
            config.pop("mcp_servers", None)
        _atomic_write_text(self.codex_config_path, _dump_toml(config))

    def _normalize_claude_mcp_server(self, server: dict[str, Any]) -> dict[str, Any]:
        config = dict(server)
        server_type = str(config.get("type") or "").strip()
        if server_type == "streamable-http":
            server_type = "http"
            config["type"] = "http"

        if server_type in {"http", "sse"}:
            url = config.get("url") or config.get("base_url")
            normalized: dict[str, Any] = {"type": server_type}
            if url:
                normalized["url"] = url
            headers = config.get("headers")
            if isinstance(headers, dict) and headers:
                normalized["headers"] = headers
            return normalized

        if server_type == "stdio" or config.get("command"):
            normalized = {"type": "stdio"}
            for key in ("command", "args", "env"):
                if config.get(key) is not None:
                    normalized[key] = config[key]
            return normalized

        return config

    def _normalize_codex_mcp_server(self, server: dict[str, Any]) -> dict[str, Any]:
        server_type = str(server.get("type") or "").strip()
        if server_type == "stdio" or server.get("command"):
            command = str(server.get("command") or "").strip()
            if not command:
                logger.warning("Skipping Codex stdio MCP without command")
                return {}
            normalized: dict[str, Any] = {"command": command}
            args = server.get("args")
            if isinstance(args, list):
                normalized["args"] = [str(arg) for arg in args]
            env = server.get("env")
            if isinstance(env, dict):
                normalized["env"] = {
                    str(key): str(value)
                    for key, value in sorted(env.items())
                    if value is not None
                }
            return normalized

        url = str(server.get("url") or server.get("base_url") or "").strip()
        if not url:
            logger.warning("Skipping Codex URL MCP without URL")
            return {}
        normalized = {"url": url}
        optional_fields = {
            "bearer_token_env_var": server.get("bearer_token_env_var")
            or server.get("bearerTokenEnvVar"),
            "oauth_client_id": server.get("oauth_client_id")
            or server.get("oauthClientId"),
            "oauth_resource": server.get("oauth_resource")
            or server.get("oauthResource"),
        }
        for key, value in optional_fields.items():
            if value:
                normalized[key] = str(value)
        return normalized

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
                removed_claude = self._remove_runtime_entry(
                    self.skills_dir / name,
                    self.skills_dir,
                )
                removed_codex = self._remove_runtime_entry(
                    self.codex_skills_dir / name,
                    self.codex_skills_dir,
                )
                if removed_claude or removed_codex:
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
            settings = self._load_claude_settings()
            enabled_plugins = settings.get("enabledPlugins")
            if not isinstance(enabled_plugins, dict):
                enabled_plugins = {}
                settings["enabledPlugins"] = enabled_plugins
            removed = []
            changed = False
            settings_changed = False
            for key, record in list((manifest.get("plugins") or {}).items()):
                managed = (
                    record.get("managed", True) if isinstance(record, dict) else False
                )
                if key in desired_keys or not managed:
                    continue
                runtime = record.get("runtime") if isinstance(record, dict) else {}
                if isinstance(runtime, dict):
                    self._remove_runtime_entry(
                        Path(str(runtime.get("claude_link", ""))).expanduser(),
                        self.plugins_dir,
                    )
                    self._remove_runtime_entry(
                        Path(str(runtime.get("codex_link", ""))).expanduser(),
                        self.codex_plugins_dir,
                    )
                if key in installed_map:
                    installed_map.pop(key, None)
                    removed.append(key)
                    changed = True
                if key in enabled_plugins:
                    enabled_plugins.pop(key, None)
                    settings_changed = True
                manifest.setdefault("plugins", {}).pop(key, None)
                changed = True
            if changed:
                self._save_installed_plugins(installed_plugins)
                self.manifest.save(self.manifest.bump_revision(manifest))
                self._sync_local_plugin_marketplace(manifest.get("plugins") or {})
            if settings_changed:
                self._save_claude_settings(settings)
            return removed

    def reconcile_managed_plugins(self) -> list[str]:
        """Restore Claude plugin install and enablement state from the manifest."""
        with _file_lock(self._lock_path):
            manifest = self.manifest.load()
            manifest_plugins = manifest.get("plugins") or {}
            if not isinstance(manifest_plugins, dict):
                return []

            installed_plugins = self._load_installed_plugins()
            installed_map = installed_plugins.setdefault("plugins", {})
            settings = self._load_claude_settings()
            enabled_plugins = settings.get("enabledPlugins")
            if not isinstance(enabled_plugins, dict):
                enabled_plugins = {}
                settings["enabledPlugins"] = enabled_plugins

            restored: list[str] = []
            installed_changed = False
            settings_changed = False
            for key, record in sorted(manifest_plugins.items()):
                if not isinstance(record, dict) or not record.get("managed", True):
                    continue
                store_path = Path(str(record.get("store_path") or "")).expanduser()
                runtime = record.get("runtime") or {}
                if not isinstance(runtime, dict):
                    runtime = {}
                claude_link_raw = runtime.get("claude_link") or record.get(
                    "install_path"
                )
                if not claude_link_raw:
                    continue
                claude_link = Path(str(claude_link_raw)).expanduser()
                if not store_path.is_dir():
                    continue

                if self._ensure_runtime_symlink(
                    claude_link, store_path, self.plugins_dir
                ):
                    restored.append(key)

                codex_link_raw = runtime.get("codex_link")
                if codex_link_raw:
                    codex_link = Path(str(codex_link_raw)).expanduser()
                    self._ensure_runtime_symlink(
                        codex_link,
                        store_path,
                        self.codex_plugins_dir,
                        optional=True,
                    )

                entry = self._plugin_install_entry(record, claude_link)
                entries = installed_map.get(key)
                if not isinstance(entries, list):
                    entries = []
                next_entries = [
                    install
                    for install in entries
                    if isinstance(install, dict)
                    and install.get("scope", "user") != entry["scope"]
                ]
                current = next(
                    (
                        install
                        for install in entries
                        if isinstance(install, dict)
                        and install.get("scope", "user") == entry["scope"]
                    ),
                    None,
                )
                if current:
                    entry["installedAt"] = current.get(
                        "installedAt", entry["installedAt"]
                    )
                    entry["lastUpdated"] = current.get(
                        "lastUpdated", entry["lastUpdated"]
                    )
                next_entries.append(entry)
                if entries != next_entries:
                    installed_map[key] = next_entries
                    installed_changed = True
                    if key not in restored:
                        restored.append(key)

                if enabled_plugins.get(key) is not True:
                    enabled_plugins[key] = True
                    settings_changed = True
                    if key not in restored:
                        restored.append(key)

            if installed_changed:
                self._save_installed_plugins(installed_plugins)
            if settings_changed:
                self._save_claude_settings(settings)
            self._sync_local_plugin_marketplace(manifest_plugins)
            return restored

    def _skill_record(self, skill: dict[str, Any]) -> dict[str, Any]:
        name = skill.get("name")
        store_path = skill.get("store_path")
        claude_link = skill.get("runtime_link") or skill.get("claude_link")
        codex_link = skill.get("codex_link")
        record = {
            "skill_id": skill.get("id") or skill.get("skill_id"),
            "namespace": skill.get("namespace", "default"),
            "managed": True,
            "updated_at": utc_now_iso(),
        }
        if store_path:
            record["store_path"] = str(store_path)
        runtime = {}
        if claude_link:
            runtime["claude_link"] = str(claude_link)
        if codex_link:
            runtime["codex_link"] = str(codex_link)
        if runtime:
            record["runtime"] = runtime
        if skill.get("installed_skill_id") is not None:
            record["installed_skill_id"] = skill.get("installed_skill_id")
        if name:
            record["name"] = name
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

    def _load_claude_settings(self) -> dict[str, Any]:
        return _read_json_file(self.plugins_dir.parent / "settings.json", {})

    def _save_claude_settings(self, data: dict[str, Any]) -> None:
        _atomic_write_json(self.plugins_dir.parent / "settings.json", data)

    def _load_known_marketplaces(self) -> dict[str, Any]:
        return _read_json_file(self.plugins_dir / "known_marketplaces.json", {})

    def _save_known_marketplaces(self, data: dict[str, Any]) -> None:
        _atomic_write_json(self.plugins_dir / "known_marketplaces.json", data)

    def _sync_local_plugin_marketplace(self, manifest_plugins: dict[str, Any]) -> None:
        plugins: list[dict[str, Any]] = []
        marketplace_dir = self.plugins_dir / "marketplaces" / "wegent"
        marketplace_plugins_dir = marketplace_dir / "plugins"
        for key, record in sorted(manifest_plugins.items()):
            if not isinstance(record, dict) or not record.get("managed", True):
                continue
            if record.get("marketplace") != "wegent":
                continue
            store_path = Path(str(record.get("store_path") or "")).expanduser()
            if not store_path.is_dir():
                continue
            plugin_name = record.get("name")
            if not plugin_name:
                continue
            source_name = self._safe_path_segment(key)
            source_path = marketplace_plugins_dir / source_name
            self._ensure_runtime_symlink(
                source_path,
                store_path,
                marketplace_plugins_dir,
                optional=True,
            )
            plugin_entry = {
                "name": plugin_name,
                "source": f"./plugins/{source_name}",
                "description": record.get("description") or "",
            }
            if record.get("version") is not None:
                plugin_entry["version"] = str(record.get("version"))
            plugins.append(plugin_entry)

        known_marketplaces = self._load_known_marketplaces()
        if not plugins:
            if known_marketplaces.pop("wegent", None) is not None:
                self._save_known_marketplaces(known_marketplaces)
            return

        marketplace_json = {
            "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
            "name": "wegent",
            "description": "Wegent managed local plugin marketplace",
            "owner": {"name": "Wegent"},
            "plugins": plugins,
        }
        _atomic_write_json(
            marketplace_dir / ".claude-plugin" / "marketplace.json",
            marketplace_json,
        )
        next_known = {
            "source": {"source": "local", "path": str(marketplace_dir)},
            "installLocation": str(marketplace_dir),
            "lastUpdated": utc_now_iso(),
        }
        if known_marketplaces.get("wegent") != next_known:
            known_marketplaces["wegent"] = next_known
            self._save_known_marketplaces(known_marketplaces)

    def _plugin_install_entry(
        self, record: dict[str, Any], install_path: Path
    ) -> dict[str, Any]:
        now = utc_now_iso()
        return {
            "scope": record.get("scope", "user"),
            "installPath": str(install_path),
            "installedPluginId": record.get("installed_plugin_id"),
            "checksum": record.get("checksum"),
            "version": record.get("version"),
            "componentStates": record.get("component_states") or {},
            "installedAt": record.get("installed_at") or now,
            "lastUpdated": now,
        }

    def _ensure_runtime_symlink(
        self,
        runtime_path: Path,
        target_path: Path,
        parent: Path,
        *,
        optional: bool = False,
    ) -> bool:
        if not self._is_runtime_child(runtime_path, parent):
            if not optional:
                raise FileExistsError(
                    f"Runtime path is outside managed parent: {runtime_path}"
                )
            logger.warning(
                "Runtime path is outside managed parent, skipping link: %s",
                runtime_path,
            )
            return False
        runtime_path.parent.mkdir(parents=True, exist_ok=True)
        if runtime_path.is_symlink():
            if runtime_path.resolve() == target_path.resolve():
                return False
            runtime_path.unlink()
        elif runtime_path.exists():
            if runtime_path.samefile(target_path):
                return False
            if optional:
                logger.warning(
                    "Runtime path is occupied by a local user item, skipping link: %s",
                    runtime_path,
                )
                return False
            raise FileExistsError(f"Runtime path is occupied: {runtime_path}")
        os.symlink(target_path, runtime_path, target_is_directory=True)
        return True

    def _safe_path_segment(self, value: Any) -> str:
        segment = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "").strip()).strip("-")
        return segment or "unknown"

    def _is_child(self, path: Path, parent: Path) -> bool:
        try:
            path.resolve().relative_to(parent.resolve())
            return True
        except ValueError:
            return False

    def _is_runtime_child(self, path: Path, parent: Path) -> bool:
        try:
            path.parent.resolve().relative_to(parent.resolve())
            return True
        except (OSError, ValueError):
            return False

    def _remove_runtime_entry(self, path: Path, parent: Path) -> bool:
        if not path or not (path.exists() or path.is_symlink()):
            return False
        if not self._is_runtime_child(path, parent):
            return False
        if path.is_symlink():
            path.unlink()
        else:
            shutil.rmtree(path)
        return True


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
                install_path = install.get("installPath")
                component_states = install.get("componentStates") or {}
                version = install.get("version")
                if managed:
                    install_path = self._managed_plugin_scan_path(
                        install_path,
                        managed,
                    )
                    component_states = (
                        component_states or managed.get("component_states") or {}
                    )
                    if version in {None, "unknown"}:
                        version = managed.get("version")
                record = {
                    "name": plugin_name,
                    "marketplace": marketplace,
                    "scope": install.get("scope", "user"),
                    "version": version,
                    "source": "wegent" if managed else "local_user",
                    "installed_at": install.get("installedAt"),
                    "last_updated": install.get("lastUpdated"),
                    "skills": self._scan_plugin_skills(
                        install_path,
                        component_states,
                    ),
                }
                if managed:
                    record["installed_plugin_id"] = managed.get("installed_plugin_id")
                results.append(record)
        return results

    def _managed_plugin_scan_path(
        self, install_path: Any, managed: dict[str, Any]
    ) -> Any:
        if install_path:
            runtime_path = Path(str(install_path)).expanduser()
            if runtime_path.is_dir():
                return install_path
        store_path = managed.get("store_path")
        if store_path:
            return store_path
        return install_path

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
        codex_skills_dir: Path | None = None,
        codex_plugins_dir: Path | None = None,
    ):
        self.auth_token = auth_token or os.getenv("WEGENT_AUTH_TOKEN", "")
        self.skills_dir = skills_dir or default_global_skills_dir()
        self.plugins_dir = plugins_dir or default_global_plugins_dir()
        self.store = store or GlobalCapabilityStore(
            skills_dir=self.skills_dir,
            plugins_dir=self.plugins_dir,
            codex_skills_dir=codex_skills_dir,
            codex_plugins_dir=codex_plugins_dir,
        )
        self.codex_skills_dir = codex_skills_dir or self.store.codex_skills_dir
        self.codex_plugins_dir = codex_plugins_dir or self.store.codex_plugins_dir
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
        old_managed_mcp_names = {
            name
            for name, record in (before_manifest.get("mcps") or {}).items()
            if isinstance(record, dict) and record.get("managed", True)
        }
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

        mcp_config_errors: list[dict[str, Any]] = []
        try:
            stale_mcp_names = (
                old_managed_mcp_names - set(mcp_records.keys())
                if mode == "replace"
                else set()
            )
            self.store.sync_global_mcp_configs(
                mcps=mcp_records,
                remove_managed_names=stale_mcp_names,
            )
        except Exception as exc:
            logger.exception("Failed to sync MCP global config files")
            mcp_config_errors.append(
                {
                    "name": "global-mcp-config",
                    "status": "failed",
                    "error": str(exc),
                }
            )

        manifest = self.store.manifest.load()
        manifest["last_sync_at"] = utc_now_iso()
        self.store.manifest.save(self.store.manifest.bump_revision(manifest))
        if plugin_records:
            self.store.reconcile_managed_plugins()
        if self.reporter:
            self.reporter.force_next_full_report()

        results = skill_results + plugin_results + mcp_results + mcp_config_errors
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
        self.codex_skills_dir.mkdir(parents=True, exist_ok=True)
        _set_owner_only(self.codex_skills_dir, is_directory=True)

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

            runtime_link = self.skills_dir / name
            manifest = self.store.manifest.load()
            managed_record = (manifest.get("skills") or {}).get(name)
            if self._is_runtime_path_occupied_by_local_user(
                runtime_link, managed_record
            ):
                results.append(
                    {
                        "id": skill_id,
                        "name": name,
                        "status": "failed",
                        "error": "Runtime Skill path is occupied by a local user item",
                    }
                )
                continue

            store_path = self._skill_store_path(name, skill_id, namespace)
            before_digest = self._skill_digest_at(store_path)
            if (
                isinstance(managed_record, dict)
                and self._runtime_skill_package_exists(runtime_link)
                and not store_path.exists()
            ):
                codex_link = self._codex_skill_link(name, runtime_link)
                record = dict(skill)
                record["id"] = skill_id
                record["store_path"] = runtime_link
                record["runtime_link"] = runtime_link
                record["codex_link"] = codex_link
                records[name] = self.store._skill_record(record)
                results.append({"id": skill_id, "name": name, "status": "skipped"})
                continue
            if store_path.is_dir():
                self._ensure_runtime_symlink(runtime_link, store_path)
                codex_link = self._ensure_codex_skill_link(name, store_path)
                record = dict(skill)
                record["id"] = skill_id
                record["store_path"] = store_path
                record["runtime_link"] = runtime_link
                record["codex_link"] = codex_link
                records[name] = self.store._skill_record(record)
                logger.info(
                    "Global skill already present in store: name=%s skill_id=%s namespace=%s",
                    name,
                    skill_id,
                    namespace,
                )
                results.append({"id": skill_id, "name": name, "status": "skipped"})
                continue

            ok = self._download_skill_to_store(
                name,
                store_path,
                {
                    "skill_id": skill_id,
                    "namespace": namespace,
                    "is_public": skill.get("is_public", False),
                },
            )
            if ok:
                self._ensure_runtime_symlink(runtime_link, store_path)
                codex_link = self._ensure_codex_skill_link(name, store_path)
                after_digest = self._skill_digest_at(store_path)
                record = dict(skill)
                record["id"] = skill_id
                record["store_path"] = store_path
                record["runtime_link"] = runtime_link
                record["codex_link"] = codex_link
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

    def _skill_store_path(self, name: str, skill_id: Any, namespace: str) -> Path:
        return self.store.skill_store_dir / "-".join(
            [
                self._safe_path_segment(skill_id),
                self._safe_path_segment(namespace),
                self._safe_path_segment(name),
            ]
        )

    def _runtime_skill_package_exists(self, runtime_link: Path) -> bool:
        return (
            runtime_link.exists()
            and runtime_link.is_dir()
            and (runtime_link / "SKILL.md").exists()
        )

    def _codex_skill_link(self, name: str, target_path: Path) -> Path | None:
        runtime_path = self.codex_skills_dir / name
        if self._ensure_optional_runtime_symlink(runtime_path, target_path):
            return runtime_path
        return None

    def _ensure_codex_skill_link(self, name: str, store_path: Path) -> Path | None:
        return self._codex_skill_link(name, store_path)

    def _download_skill_to_store(
        self, name: str, store_path: Path, skill_ref: dict[str, Any]
    ) -> bool:
        temp_parent = self.store.skill_store_dir / f".tmp-{os.getpid()}-{name}"
        if temp_parent.exists():
            shutil.rmtree(temp_parent)
        temp_parent.mkdir(parents=True, exist_ok=True)
        try:
            downloader = SkillDownloader(
                auth_token=self.auth_token,
                team_namespace="default",
                skills_dir=str(temp_parent),
            )
            ok = downloader._download_single_skill(name, skill_ref)
            extracted_path = temp_parent / name
            if not ok or not extracted_path.is_dir():
                return False
            staged_path = store_path.parent / f".{store_path.name}.staged-{os.getpid()}"
            if staged_path.exists():
                shutil.rmtree(staged_path)
            store_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(extracted_path), str(staged_path))
            if store_path.exists() or store_path.is_symlink():
                if store_path.is_symlink():
                    store_path.unlink()
                else:
                    shutil.rmtree(store_path)
            os.replace(staged_path, store_path)
            _set_owner_only(store_path, is_directory=True)
            return True
        finally:
            if temp_parent.exists():
                shutil.rmtree(temp_parent, ignore_errors=True)

    def _skill_digest_at(self, path: Path) -> str | None:
        if not path.is_dir():
            return None
        return self._directory_digest(path)

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
        self.codex_plugins_dir.mkdir(parents=True, exist_ok=True)
        _set_owner_only(self.codex_plugins_dir, is_directory=True)
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
            runtime_link = self._plugin_runtime_path(item, name, marketplace)
            store_path = self._plugin_store_path(item, name, marketplace)
            expected_checksum = item.get("checksum")
            should_download = not store_path.exists()
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
                if not self._download_plugin_package(client, item, store_path):
                    results.append(
                        {
                            "id": item.get("installed_plugin_id"),
                            "name": name,
                            "status": "failed",
                            "error": "Failed to download Plugin package",
                        }
                    )
                    continue
            if not store_path.exists() and runtime_link.exists():
                store_path = runtime_link
            if not store_path.exists() or not store_path.is_dir():
                logger.warning(
                    "Plugin package not found in local cache: name=%s marketplace=%s path=%s",
                    name,
                    marketplace,
                    store_path,
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
            if store_path != runtime_link:
                self._ensure_runtime_symlink(runtime_link, store_path)
            codex_link = self._ensure_codex_plugin_link(key, store_path)

            scope = item.get("scope", "user")
            existing_installs = [
                install
                for install in installed_map.get(key, [])
                if isinstance(install, dict) and install.get("scope", "user") != scope
            ]
            existing_installs.append(
                {
                    "scope": scope,
                    "installPath": str(runtime_link),
                    "installedPluginId": item.get("installed_plugin_id"),
                    "checksum": item.get("checksum"),
                    "version": item.get("version"),
                    "componentStates": item.get("component_states") or {},
                    "installedAt": item.get("installed_at") or utc_now_iso(),
                    "lastUpdated": utc_now_iso(),
                }
            )
            installed_map[key] = existing_installs
            records[key] = self._plugin_record(
                item, key, marketplace, store_path, runtime_link, codex_link
            )
            logger.info(
                "Configured global plugin: key=%s installed_plugin_id=%s path=%s",
                key,
                item.get("installed_plugin_id"),
                runtime_link,
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
        candidates: list[Path] = []
        for plugin_json in path.rglob("plugin.json"):
            if plugin_json.parent.name != ".claude-plugin":
                continue
            candidate = plugin_json.parent.parent
            relative_parts = candidate.relative_to(path).parts
            if any(
                part == "__MACOSX" or part.startswith("._") for part in relative_parts
            ):
                continue
            candidates.append(candidate)
        if candidates:
            return sorted(
                candidates,
                key=lambda candidate: (
                    len(candidate.relative_to(path).parts),
                    str(candidate),
                ),
            )[0]
        raise ValueError("Plugin package must include .claude-plugin/plugin.json")

    def _is_macos_zip_metadata(self, path: Path) -> bool:
        return path.name == "__MACOSX" or path.name.startswith("._")

    def _plugin_marketplace(self, item: dict[str, Any]) -> str | None:
        source = item.get("source") or {}
        marketplace = item.get("marketplace") or source.get("marketplace")
        if marketplace:
            return marketplace
        if source.get("type") == "upload":
            return "wegent"
        return None

    def _plugin_key(self, name: str, marketplace: str | None) -> str:
        return f"{name}@{marketplace}" if marketplace else name

    def _plugin_runtime_path(
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
            / (marketplace or "default")
            / name
            / str(item.get("version") or "latest")
        )

    def _plugin_store_path(
        self,
        item: dict[str, Any],
        name: str,
        marketplace: str | None,
    ) -> Path:
        return self.store.plugin_store_dir / "-".join(
            [
                self._safe_path_segment(item.get("installed_plugin_id") or "unknown"),
                self._safe_path_segment(marketplace or "default"),
                self._safe_path_segment(name),
                self._safe_path_segment(item.get("version") or "latest"),
            ]
        )

    def _ensure_codex_plugin_link(self, key: str, store_path: Path) -> Path | None:
        runtime_path = self.codex_plugins_dir / self._safe_path_segment(key)
        if self._ensure_optional_runtime_symlink(runtime_path, store_path):
            return runtime_path
        return None

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
        store_path: Path,
        runtime_link: Path,
        codex_link: Path | None,
    ) -> dict[str, Any]:
        runtime = {"claude_link": str(runtime_link)}
        if codex_link:
            runtime["codex_link"] = str(codex_link)
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
            "store_path": str(store_path),
            "runtime": runtime,
            "install_path": str(runtime_link),
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

    def _is_runtime_path_occupied_by_local_user(
        self, runtime_path: Path, managed_record: Any
    ) -> bool:
        if not runtime_path.exists() and not runtime_path.is_symlink():
            return False
        return not (
            isinstance(managed_record, dict) and managed_record.get("managed", True)
        )

    def _ensure_runtime_symlink(self, runtime_path: Path, target_path: Path) -> None:
        runtime_path.parent.mkdir(parents=True, exist_ok=True)
        if runtime_path.is_symlink():
            if runtime_path.resolve() == target_path.resolve():
                return
            runtime_path.unlink()
        elif runtime_path.exists():
            if runtime_path.samefile(target_path):
                return
            raise FileExistsError(f"Runtime path is occupied: {runtime_path}")
        os.symlink(target_path, runtime_path, target_is_directory=True)

    def _ensure_optional_runtime_symlink(
        self, runtime_path: Path, target_path: Path
    ) -> bool:
        try:
            self._ensure_runtime_symlink(runtime_path, target_path)
            return True
        except FileExistsError:
            logger.warning(
                "Runtime path is occupied by a local user item, skipping link: %s",
                runtime_path,
            )
            return False

    def _safe_path_segment(self, value: Any) -> str:
        segment = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "").strip()).strip("-")
        return segment or "unknown"

    def _skill_digest(self, name: str) -> str | None:
        path = self.skills_dir / name
        if not path.exists():
            return None
        return self._directory_digest(path)

    def _directory_digest(self, path: Path) -> str:
        files: list[tuple[str, str]] = []
        for file_path in sorted(item for item in path.rglob("*") if item.is_file()):
            rel = str(file_path.relative_to(path))
            files.append((rel, hashlib.sha256(file_path.read_bytes()).hexdigest()))
        return _canonical_digest(files)
