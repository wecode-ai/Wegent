# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import zipfile
from pathlib import PurePosixPath
from typing import Any, Dict, Iterable

from fastapi import HTTPException

from app.schemas.installed_plugin import (
    InstalledPluginComponents,
    PluginMCPComponent,
    PluginPathComponent,
    PluginSkillComponent,
    PluginUploadInfo,
)

MAX_PLUGIN_PACKAGE_SIZE_BYTES = 50 * 1024 * 1024


class ClaudePluginParser:
    """Parse and validate Claude Code plugin ZIP packages."""

    def parse_package(self, package_bytes: bytes) -> PluginUploadInfo:
        if len(package_bytes) > MAX_PLUGIN_PACKAGE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="Plugin package is too large")

        try:
            with zipfile.ZipFile(self._bytes_reader(package_bytes)) as archive:
                self._validate_archive_paths(archive)
                root = self._detect_plugin_root(archive)
                manifest = self._read_json(archive, f"{root}.claude-plugin/plugin.json")
                components = self._parse_components(archive, root)
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
            displayName=str(manifest.get("displayName") or name),
            description=str(manifest.get("description") or ""),
            version=str(manifest.get("version")) if manifest.get("version") else None,
            author=self._format_author(manifest.get("author")),
            manifest=manifest,
            components=components,
        )

    @staticmethod
    def _bytes_reader(package_bytes: bytes):
        import io

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

    def _detect_plugin_root(self, archive: zipfile.ZipFile) -> str:
        candidates = [
            name
            for name in archive.namelist()
            if name.endswith(".claude-plugin/plugin.json")
        ]
        if not candidates:
            raise HTTPException(
                status_code=400,
                detail="Claude Code plugin must include .claude-plugin/plugin.json",
            )
        manifest_path = sorted(candidates, key=len)[0]
        return manifest_path[: -len(".claude-plugin/plugin.json")]

    def _read_json(self, archive: zipfile.ZipFile, path: str) -> Dict[str, Any]:
        try:
            with archive.open(path) as file:
                data = json.loads(file.read().decode("utf-8"))
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=f"Missing {path}") from exc
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=400, detail=f"Invalid JSON in {path}"
            ) from exc
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail=f"{path} must be a JSON object")
        return data

    def _parse_components(
        self, archive: zipfile.ZipFile, root: str
    ) -> InstalledPluginComponents:
        names = [name for name in archive.namelist() if not name.endswith("/")]
        return InstalledPluginComponents(
            skills=self._parse_skills(archive, root, names),
            commands=self._parse_markdown_files(root, names, "commands"),
            agents=self._parse_markdown_files(root, names, "agents"),
            hooks=self._parse_json_file_components(root, names, "hooks"),
            mcps=self._parse_mcps(archive, root),
            lsps=self._parse_json_file_components(root, names, ".lsp.json"),
            monitors=self._parse_json_file_components(root, names, "monitors"),
            bins=self._parse_bin_files(root, names),
            settings=self._read_optional_json(archive, f"{root}settings.json"),
        )

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
        self, archive: zipfile.ZipFile, root: str
    ) -> list[PluginMCPComponent]:
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


claude_plugin_parser = ClaudePluginParser()
