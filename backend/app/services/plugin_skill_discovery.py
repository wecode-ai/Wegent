# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Discover plugin Skills from default and manifest-declared directories."""

import json
import re
from bisect import bisect_left
from pathlib import PurePosixPath, PureWindowsPath
from textwrap import dedent
from typing import Any, Iterable
from zipfile import ZipFile

from fastapi import HTTPException

from app.schemas.installed_plugin import PluginSkillComponent


def _declared_directories(value: Any) -> set[str]:
    paths = [value] if isinstance(value, str) else value
    if not isinstance(paths, list):
        raise HTTPException(400, "Plugin skills must be a path or an array of paths")
    directories: set[str] = set()
    for path in paths:
        if not isinstance(path, str) or not path.strip():
            raise HTTPException(400, "Plugin skill paths must be non-empty strings")
        path = path.strip()
        relative = PurePosixPath(path)
        if (
            relative.is_absolute()
            or PureWindowsPath(path).drive
            or PureWindowsPath(relative.as_posix()).drive
            or "\\" in path
            or ".." in relative.parts
            or "\x00" in path
        ):
            raise HTTPException(400, "Plugin skill paths must stay inside the plugin")
        directories.add(relative.as_posix())
    return directories


def _normalized_entries(entries: Iterable[str], root: str) -> dict[str, str]:
    originals: dict[str, str] = {}
    for name in entries:
        try:
            relative = PurePosixPath(name).relative_to(PurePosixPath(root))
        except ValueError:
            continue
        path = relative.as_posix() + ("/" if name.endswith("/") else "")
        if path in originals:
            raise HTTPException(400, "Duplicate normalized path in plugin ZIP")
        originals[path] = name
    return originals


def _directory_files(paths: list[str], directory: str) -> Iterable[str]:
    prefix = "" if directory == "." else f"{directory}/"
    index = bisect_left(paths, prefix)
    while index < len(paths) and paths[index].startswith(prefix):
        path = paths[index]
        if path == "SKILL.md" or path.endswith("/SKILL.md"):
            yield path
        index += 1


def discover_plugin_skill_files(
    entries: Iterable[str], root: str, manifest: dict[str, Any]
) -> list[str]:
    """Keep default Skills additive and root fallback limited to single-skill plugins."""
    originals = _normalized_entries(entries, root)
    paths = sorted(originals)
    path_set = set(paths)
    files = set(_directory_files(paths, "skills"))
    if "skills" in manifest:
        for directory in _declared_directories(manifest["skills"]):
            ancestors = [PurePosixPath(directory), *PurePosixPath(directory).parents]
            if any(str(ancestor) in path_set for ancestor in ancestors):
                raise HTTPException(400, "Plugin skill paths must identify directories")
            skill_file = str(PurePosixPath(directory) / "SKILL.md")
            if skill_file in path_set:
                files.add(skill_file)
            else:
                files.update(_directory_files(paths, directory))
    else:
        default_index = bisect_left(paths, "skills/")
        has_default_directory = default_index < len(paths) and paths[
            default_index
        ].startswith("skills/")
        if not has_default_directory and "SKILL.md" in path_set:
            files.add("SKILL.md")
    return [originals[path] for path in sorted(files)]


def _block_value(lines: list[str], style: str) -> str:
    value = dedent("\n".join(lines)).strip()
    if style == "|":
        return value
    paragraphs = re.split(r"\n\s*\n", value)
    return "\n".join(" ".join(paragraph.splitlines()) for paragraph in paragraphs)


def _inline_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def _read_skill_frontmatter(archive: ZipFile, path: str) -> dict[str, str]:
    try:
        with archive.open(path) as file:
            lines = file.read().decode("utf-8").splitlines()
    except Exception:
        return {}
    if not lines or lines[0].strip() != "---":
        return {}
    frontmatter: list[str] = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        frontmatter.append(line)
    metadata: dict[str, str] = {}
    index = 0
    while index < len(frontmatter):
        line = frontmatter[index]
        index += 1
        key, separator, value = line.partition(":")
        if (
            line[:1].isspace()
            or not separator
            or key.strip() not in {"name", "description"}
        ):
            continue
        value = value.strip()
        if value.startswith(("|", ">")):
            block: list[str] = []
            indent = len(line) - len(line.lstrip())
            while index < len(frontmatter):
                next_line = frontmatter[index]
                next_indent = len(next_line) - len(next_line.lstrip())
                if next_line.strip() and next_indent <= indent and ":" in next_line:
                    break
                block.append(next_line)
                index += 1
            value = _block_value(block, value[0])
        else:
            value = _inline_value(value)
        metadata[key.strip()] = value
    return metadata


def parse_plugin_skills(
    archive: ZipFile, root: str, manifest: dict[str, Any]
) -> list[PluginSkillComponent]:
    skills: list[PluginSkillComponent] = []
    for path in discover_plugin_skill_files(archive.namelist(), root, manifest):
        metadata = _read_skill_frontmatter(archive, path)
        directory = PurePosixPath(path).relative_to(PurePosixPath(root)).parent
        default_name = (
            manifest.get("name", "") if str(directory) == "." else directory.name
        )
        skills.append(
            PluginSkillComponent(
                name=metadata.get("name") or str(default_name),
                description=metadata.get("description", ""),
                path=str(directory),
            )
        )
    return skills
