# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import io
import json
import re
import zipfile
from pathlib import PurePosixPath
from typing import Any, Dict, Iterable

from fastapi import HTTPException

from app.schemas.installed_plugin import (
    InstalledPluginComponents,
    PluginConnectorComponent,
    PluginInterface,
    PluginLocalAuthDefinition,
    PluginMCPComponent,
    PluginPathComponent,
    PluginSkillComponent,
    PluginUploadInfo,
)

MAX_PLUGIN_PACKAGE_SIZE_BYTES = 50 * 1024 * 1024
MAX_INLINE_INTERFACE_ASSET_BYTES = 512 * 1024
INTERFACE_ASSET_MEDIA_TYPES = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


CLAUDE_PLUGIN_MANIFEST_PATH = ".claude-plugin/plugin.json"
CODEX_PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json"
PLUGIN_MANIFEST_PATHS = (
    CODEX_PLUGIN_MANIFEST_PATH,
    CLAUDE_PLUGIN_MANIFEST_PATH,
)
CODEX_MANIFEST_FIELDS = {
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "skills",
    "mcpServers",
}
# Claude Code supports displayName only from 2.1.143; Wegent still supports 2.1.140.
CLAUDE_MANIFEST_FIELDS = CODEX_MANIFEST_FIELDS | {
    "commands",
    "agents",
    "hooks",
    "outputStyles",
    "lspServers",
    "experimental",
    "dependencies",
    "userConfig",
    "channels",
    "themes",
    "monitors",
}


class PluginPackageParser:
    """Parse and normalize Codex and Claude Code plugin ZIP packages."""

    def parse_package(self, package_bytes: bytes) -> PluginUploadInfo:
        self._validate_package_size(package_bytes)

        try:
            with zipfile.ZipFile(self._bytes_reader(package_bytes)) as archive:
                self._validate_archive_paths(archive)
                root, manifest_relative_path = self._detect_plugin_root(archive)
                manifest = self._read_json(archive, f"{root}{manifest_relative_path}")
                components = self._parse_components(archive, root, manifest)
                interface = self._inline_interface_assets(
                    archive,
                    root,
                    self._parse_interface(manifest),
                )
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="Invalid plugin ZIP") from exc

        name = str(manifest.get("name") or "").strip()
        if not name:
            raise HTTPException(
                status_code=400,
                detail="Plugin manifest must include a non-empty name",
            )

        return PluginUploadInfo(
            name=name,
            displayName=self._display_name(manifest, name),
            description=self._description(manifest),
            version=str(manifest.get("version")) if manifest.get("version") else None,
            author=self._format_author(manifest.get("author")),
            manifest=manifest,
            components=components,
            interface=interface,
        )

    def resolve_interface_assets(
        self,
        package_bytes: bytes,
        interface_values: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Inline the exact interface asset paths selected by catalog metadata."""
        if len(package_bytes) > MAX_PLUGIN_PACKAGE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="Plugin package is too large")
        interface = PluginInterface.model_validate(interface_values)
        try:
            with zipfile.ZipFile(self._bytes_reader(package_bytes)) as archive:
                self._validate_archive_paths(archive)
                root, _ = self._detect_plugin_root(archive)
                resolved_interface = self._inline_interface_assets(
                    archive,
                    root,
                    interface,
                )
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="Invalid plugin ZIP") from exc
        resolved = dict(interface_values)
        if resolved_interface:
            for field in ("composerIcon", "logo", "logoDark"):
                value = getattr(resolved_interface, field)
                if value:
                    resolved[field] = value
        return resolved

    def normalize_and_parse(
        self, package_bytes: bytes
    ) -> tuple[PluginUploadInfo, bytes]:
        normalized = self.normalize_package(package_bytes)
        return self.parse_package(normalized), normalized

    def normalize_package(self, package_bytes: bytes) -> bytes:
        """Ensure the package contains compatible manifests for both runtimes."""
        self._validate_package_size(package_bytes)
        try:
            with zipfile.ZipFile(self._bytes_reader(package_bytes)) as archive:
                self._validate_archive_paths(archive)
                root, source_manifest_path = self._detect_plugin_root(archive)
                manifests = self._read_root_manifests(archive, root)
                self._validate_manifest_names(manifests)
                source_manifest = manifests[source_manifest_path]
                codex_manifest = manifests.get(CODEX_PLUGIN_MANIFEST_PATH)
                if codex_manifest is None:
                    codex_manifest = self._convert_manifest(
                        source_manifest,
                        CODEX_PLUGIN_MANIFEST_PATH,
                    )
                claude_source = manifests.get(CLAUDE_PLUGIN_MANIFEST_PATH)
                if claude_source is None:
                    claude_source = self._convert_manifest(
                        source_manifest,
                        CLAUDE_PLUGIN_MANIFEST_PATH,
                    )
                claude_manifest = self._convert_manifest(
                    claude_source,
                    CLAUDE_PLUGIN_MANIFEST_PATH,
                )
                return self._rewrite_manifests(
                    archive,
                    root,
                    codex_manifest,
                    claude_manifest,
                )
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="Invalid plugin ZIP") from exc

    @staticmethod
    def _validate_package_size(package_bytes: bytes) -> None:
        if len(package_bytes) > MAX_PLUGIN_PACKAGE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="Plugin package is too large")

    @staticmethod
    def _bytes_reader(package_bytes: bytes):
        return io.BytesIO(package_bytes)

    @staticmethod
    def _format_author(author: Any) -> str | None:
        if not author:
            return None
        if isinstance(author, str):
            return author
        if isinstance(author, dict):
            name = str(author.get("name") or "").strip()
            email = str(author.get("email") or "").strip()
            if name and email:
                return f"{name} <{email}>"
            return name or email or None
        return None

    def _validate_archive_paths(self, archive: zipfile.ZipFile) -> None:
        for member in archive.infolist():
            path = PurePosixPath(member.filename)
            if path.is_absolute() or ".." in path.parts:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsafe path in plugin ZIP: {member.filename}",
                )

    def _detect_plugin_root(self, archive: zipfile.ZipFile) -> tuple[str, str]:
        candidates = [
            (name, manifest_path)
            for name in archive.namelist()
            for manifest_path in PLUGIN_MANIFEST_PATHS
            if name.endswith(manifest_path)
        ]
        if not candidates:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Plugin must include .codex-plugin/plugin.json or "
                    ".claude-plugin/plugin.json"
                ),
            )
        manifest_path, manifest_relative_path = min(
            candidates,
            key=lambda candidate: (
                len(PurePosixPath(candidate[0][: -len(candidate[1])]).parts),
                0 if candidate[1] == CODEX_PLUGIN_MANIFEST_PATH else 1,
                len(candidate[0]),
            ),
        )
        return (
            manifest_path[: -len(manifest_relative_path)],
            manifest_relative_path,
        )

    def _read_json(self, archive: zipfile.ZipFile, path: str) -> Dict[str, Any]:
        try:
            with archive.open(path) as file:
                data = json.loads(file.read().decode("utf-8"))
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=f"Missing {path}") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=400, detail=f"Invalid JSON in {path}"
            ) from exc
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail=f"{path} must be a JSON object")
        return data

    def _read_root_manifests(
        self,
        archive: zipfile.ZipFile,
        root: str,
    ) -> dict[str, Dict[str, Any]]:
        names = set(archive.namelist())
        return {
            manifest_path: self._read_json(archive, f"{root}{manifest_path}")
            for manifest_path in PLUGIN_MANIFEST_PATHS
            if f"{root}{manifest_path}" in names
        }

    def _validate_manifest_names(
        self,
        manifests: dict[str, Dict[str, Any]],
    ) -> None:
        names = {
            manifest_path: str(manifest.get("name") or "").strip()
            for manifest_path, manifest in manifests.items()
        }
        for manifest_path, name in names.items():
            if not name:
                raise HTTPException(
                    status_code=400,
                    detail=f"{manifest_path} must include a non-empty name",
                )
        if len(set(names.values())) > 1:
            raise HTTPException(
                status_code=400,
                detail="Codex and Claude Code plugin manifest names must match",
            )

    @staticmethod
    def _convert_manifest(
        manifest: Dict[str, Any],
        target_manifest_path: str,
    ) -> Dict[str, Any]:
        fields = (
            CLAUDE_MANIFEST_FIELDS
            if target_manifest_path == CLAUDE_PLUGIN_MANIFEST_PATH
            else CODEX_MANIFEST_FIELDS
        )
        converted = {key: value for key, value in manifest.items() if key in fields}
        if target_manifest_path == CLAUDE_PLUGIN_MANIFEST_PATH:
            interface = manifest.get("interface")
            if isinstance(interface, dict):
                description = interface.get("shortDescription") or interface.get(
                    "longDescription"
                )
                if description and not converted.get("description"):
                    converted["description"] = description
        else:
            interface = {}
            if manifest.get("displayName"):
                interface["displayName"] = manifest["displayName"]
            if manifest.get("description"):
                interface["shortDescription"] = manifest["description"]
            if interface:
                converted["interface"] = interface
        return converted

    @staticmethod
    def _rewrite_manifests(
        archive: zipfile.ZipFile,
        root: str,
        codex_manifest: Dict[str, Any],
        claude_manifest: Dict[str, Any],
    ) -> bytes:
        manifests = {
            f"{root}{CODEX_PLUGIN_MANIFEST_PATH}": codex_manifest,
            f"{root}{CLAUDE_PLUGIN_MANIFEST_PATH}": claude_manifest,
        }
        written_manifests: set[str] = set()
        buffer = io.BytesIO()
        with zipfile.ZipFile(
            buffer,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
        ) as normalized:
            for member in archive.infolist():
                manifest = manifests.get(member.filename)
                if manifest is None:
                    normalized.writestr(member, archive.read(member))
                    continue
                normalized.writestr(
                    member,
                    PluginPackageParser._manifest_bytes(manifest),
                )
                written_manifests.add(member.filename)
            for path, manifest in manifests.items():
                if path in written_manifests:
                    continue
                info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                normalized.writestr(
                    info,
                    PluginPackageParser._manifest_bytes(manifest),
                )
        return buffer.getvalue()

    @staticmethod
    def _manifest_bytes(manifest: Dict[str, Any]) -> bytes:
        return json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")

    def _parse_components(
        self, archive: zipfile.ZipFile, root: str, manifest: Dict[str, Any]
    ) -> InstalledPluginComponents:
        names = [name for name in archive.namelist() if not name.endswith("/")]
        return InstalledPluginComponents(
            skills=self._parse_skills(archive, root, names),
            commands=self._parse_markdown_files(root, names, "commands"),
            agents=self._parse_markdown_files(root, names, "agents"),
            hooks=self._parse_json_file_components(root, names, "hooks"),
            mcps=self._parse_mcps(archive, root, manifest),
            connectors=self._parse_connectors(manifest),
            lsps=self._parse_json_file_components(root, names, ".lsp.json"),
            monitors=self._parse_json_file_components(root, names, "monitors"),
            bins=self._parse_bin_files(root, names),
            settings=self._read_optional_json(archive, f"{root}settings.json"),
        )

    def _display_name(self, manifest: Dict[str, Any], fallback: str) -> str:
        direct = str(manifest.get("displayName") or "").strip()
        if direct:
            return direct
        interface = manifest.get("interface")
        if isinstance(interface, dict):
            display_name = str(interface.get("displayName") or "").strip()
            if display_name:
                return display_name
        return fallback

    def _description(self, manifest: Dict[str, Any]) -> str:
        direct = str(manifest.get("description") or "").strip()
        if direct:
            return direct
        interface = manifest.get("interface")
        if isinstance(interface, dict):
            return str(
                interface.get("shortDescription")
                or interface.get("longDescription")
                or ""
            )
        return ""

    def _parse_interface(self, manifest: Dict[str, Any]) -> PluginInterface | None:
        raw = manifest.get("interface")
        if not isinstance(raw, dict):
            return None

        return PluginInterface(
            displayName=self._optional_string(raw.get("displayName")),
            shortDescription=self._optional_string(raw.get("shortDescription")),
            longDescription=self._optional_string(raw.get("longDescription")),
            developerName=self._optional_string(raw.get("developerName")),
            category=self._optional_string(raw.get("category")),
            capabilities=[
                str(item).strip()
                for item in raw.get("capabilities") or []
                if str(item).strip()
            ],
            websiteUrl=self._optional_string(
                raw.get("websiteUrl") or raw.get("websiteURL")
            ),
            privacyPolicyUrl=self._optional_string(
                raw.get("privacyPolicyUrl") or raw.get("privacyPolicyURL")
            ),
            termsOfServiceUrl=self._optional_string(
                raw.get("termsOfServiceUrl") or raw.get("termsOfServiceURL")
            ),
            defaultPrompt=self._default_prompts(raw.get("defaultPrompt")),
            brandColor=self._optional_string(raw.get("brandColor")),
            composerIcon=self._optional_string(raw.get("composerIcon")),
            logo=self._optional_string(raw.get("logo")),
            logoDark=self._optional_string(raw.get("logoDark")),
            screenshots=[
                str(item).strip()
                for item in raw.get("screenshots") or []
                if str(item).strip()
            ],
        )

    def _inline_interface_assets(
        self,
        archive: zipfile.ZipFile,
        root: str,
        interface: PluginInterface | None,
    ) -> PluginInterface | None:
        if interface is None:
            return None
        updates = {
            field: self._interface_asset_data_url(
                archive,
                root,
                getattr(interface, field),
            )
            for field in ("composerIcon", "logo", "logoDark")
        }
        return interface.model_copy(update=updates)

    def _interface_asset_data_url(
        self,
        archive: zipfile.ZipFile,
        root: str,
        value: str | None,
    ) -> str | None:
        if not value or re.match(r"^(?:data:|https?://|file://|/)", value, re.I):
            return value
        relative = PurePosixPath(value.removeprefix("./"))
        if relative.is_absolute() or ".." in relative.parts:
            return value
        media_type = INTERFACE_ASSET_MEDIA_TYPES.get(relative.suffix.lower())
        if media_type is None:
            return value
        member_name = f"{root}{relative.as_posix()}"
        try:
            member = archive.getinfo(member_name)
        except KeyError:
            return value
        if member.file_size > MAX_INLINE_INTERFACE_ASSET_BYTES:
            return value
        encoded = base64.b64encode(archive.read(member)).decode("ascii")
        return f"data:{media_type};base64,{encoded}"

    @staticmethod
    def _optional_string(value: Any) -> str | None:
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None

    def _default_prompts(self, value: Any) -> list[str] | None:
        if isinstance(value, str):
            prompt = value.strip()
            return [prompt] if prompt else None
        if isinstance(value, list):
            prompts = [
                str(item).strip()
                for item in value
                if isinstance(item, str) and item.strip()
            ]
            return prompts[:3] or None
        return None

    def _parse_skills(
        self, archive: zipfile.ZipFile, root: str, names: Iterable[str]
    ) -> list[PluginSkillComponent]:
        skills: list[PluginSkillComponent] = []
        prefix = f"{root}skills/"
        for name in sorted(names):
            if not name.startswith(prefix) or not name.endswith("/SKILL.md"):
                continue
            metadata = self._read_skill_frontmatter(archive, name)
            relative_parent = self._relative_path(root, str(PurePosixPath(name).parent))
            skill_name = metadata.get("name") or PurePosixPath(name).parent.name
            skills.append(
                PluginSkillComponent(
                    name=skill_name,
                    description=metadata.get("description", ""),
                    path=relative_parent,
                )
            )
        return skills

    def _relative_path(self, root: str, path: str) -> str:
        if not root:
            return path
        return str(PurePosixPath(path).relative_to(root.rstrip("/")))

    def _parse_markdown_files(
        self, root: str, names: Iterable[str], folder: str
    ) -> list[PluginPathComponent]:
        prefix = f"{root}{folder}/"
        return [
            PluginPathComponent(name=PurePosixPath(name).stem, path=name[len(root) :])
            for name in sorted(names)
            if name.startswith(prefix) and name.endswith(".md")
        ]

    def _parse_json_file_components(
        self, root: str, names: Iterable[str], marker: str
    ) -> list[PluginPathComponent]:
        if marker.startswith("."):
            path = f"{root}{marker}"
            return (
                [PluginPathComponent(name=marker, path=marker)] if path in names else []
            )
        prefix = f"{root}{marker}/"
        return [
            PluginPathComponent(name=PurePosixPath(name).stem, path=name[len(root) :])
            for name in sorted(names)
            if name.startswith(prefix) and name.endswith(".json")
        ]

    def _parse_bin_files(
        self, root: str, names: Iterable[str]
    ) -> list[PluginPathComponent]:
        prefix = f"{root}bin/"
        return [
            PluginPathComponent(name=PurePosixPath(name).name, path=name[len(root) :])
            for name in sorted(names)
            if name.startswith(prefix)
        ]

    def _parse_mcps(
        self, archive: zipfile.ZipFile, root: str, manifest: Dict[str, Any]
    ) -> list[PluginMCPComponent]:
        raw = manifest.get("mcpServers")
        if isinstance(raw, dict):
            data = {"mcpServers": raw}
        elif isinstance(raw, str) and raw.strip():
            data = self._read_optional_json(
                archive, self._join_root_path(root, raw.strip())
            )
        else:
            data = self._read_optional_json(archive, f"{root}.mcp.json")
        if not data:
            return []
        servers = data.get("mcpServers") if isinstance(data, dict) else None
        if not isinstance(servers, dict):
            return []
        return [
            PluginMCPComponent(
                name=str(name),
                server=server if isinstance(server, dict) else {},
            )
            for name, server in sorted(servers.items())
        ]

    def _parse_connectors(
        self, manifest: Dict[str, Any]
    ) -> list[PluginConnectorComponent]:
        raw_connectors = manifest.get("connectors")
        if not isinstance(raw_connectors, list):
            return []
        connectors: list[PluginConnectorComponent] = []
        seen: set[str] = set()
        for item in raw_connectors:
            if not isinstance(item, dict):
                continue
            slug = str(item.get("slug") or "").strip()
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,99}", slug) or slug in seen:
                continue
            auth_policy = str(item.get("authPolicy") or "optional")
            if auth_policy not in {"on_install", "on_use", "optional"}:
                continue
            local_auth = self._parse_local_auth(item.get("localAuth"))
            seen.add(slug)
            connectors.append(
                PluginConnectorComponent(
                    slug=slug,
                    authPolicy=auth_policy,
                    localAuth=local_auth,
                )
            )
        return connectors

    def _parse_local_auth(self, raw: Any) -> PluginLocalAuthDefinition | None:
        if not isinstance(raw, dict):
            return None
        kind = str(raw.get("kind") or "local_qr").strip()
        if kind != "local_qr":
            return None

        def command_list(value: Any) -> list[str]:
            if not isinstance(value, list):
                return []
            commands: list[str] = []
            for item in value:
                text = str(item or "").strip()
                if not text:
                    continue
                # Only allow relative plugin-root paths / simple CLI args.
                if (
                    text.startswith("/")
                    or text.startswith("~")
                    or ".." in PurePosixPath(text).parts
                    or re.search(r"^[A-Za-z]:[\\/]", text)
                ):
                    continue
                commands.append(text)
            return commands

        health = command_list(raw.get("health"))
        start = command_list(raw.get("start"))
        poll = command_list(raw.get("poll"))
        logout = command_list(raw.get("logout"))
        if not health or not start or not poll:
            return None
        poll_interval = raw.get("pollIntervalSeconds", 2)
        try:
            poll_interval_seconds = max(1, min(int(poll_interval), 30))
        except (TypeError, ValueError):
            poll_interval_seconds = 2
        ok_values = [
            str(item).strip()
            for item in (raw.get("okValues") or ["ok"])
            if str(item).strip()
        ] or ["ok"]
        return PluginLocalAuthDefinition(
            kind="local_qr",
            health=health,
            start=start,
            poll=poll,
            logout=logout,
            qrField=str(raw.get("qrField") or "qr_path").strip() or "qr_path",
            statusField=str(raw.get("statusField") or "status").strip() or "status",
            okValues=ok_values,
            pollIntervalSeconds=poll_interval_seconds,
        )

    def _join_root_path(self, root: str, path: str) -> str:
        normalized = path[2:] if path.startswith("./") else path
        return f"{root}{normalized}"

    def _read_optional_json(
        self, archive: zipfile.ZipFile, path: str
    ) -> Dict[str, Any] | None:
        try:
            return self._read_json(archive, path)
        except HTTPException as exc:
            if exc.status_code == 400 and str(exc.detail).startswith("Missing"):
                return None
            raise

    def _read_skill_frontmatter(
        self, archive: zipfile.ZipFile, path: str
    ) -> dict[str, str]:
        try:
            with archive.open(path) as file:
                lines = file.read().decode("utf-8").splitlines()
        except Exception:
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


plugin_package_parser = PluginPackageParser()
