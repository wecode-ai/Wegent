// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Default local device commands ported verbatim from
//! `app/services/device/command_registry.py::DEFAULT_LOCAL_DEVICE_COMMANDS`.
//!
//! The `command` text is embedded byte-for-byte: the device receives it in the
//! `device:execute_command` payload, so quoting and embedded scripts must match
//! the source exactly.

use super::DeviceCommandSpec;

pub(super) fn lookup(key: &str) -> Option<DeviceCommandSpec> {
    match key {
        "ls_skills" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import json
import os
import re
from pathlib import Path

FRONTMATTER_PATTERN = re.compile(r"^---\n(.*?)\n---", re.S)
SKILL_SOURCES = (
    (Path.home() / ".agents" / "skills", "agents", "**/SKILL.md", "skill"),
    (Path.home() / ".claude" / "skills", "claude", "**/SKILL.md", "skill"),
    (Path.home() / ".codex" / "skills", "codex", "**/SKILL.md", "skill"),
    (
        Path.home() / ".claude" / "plugins" / "cache",
        "claude-plugin",
        "**/skills/**/SKILL.md",
        "plugin",
    ),
    (
        Path.home() / ".codex" / "plugins" / "cache",
        "codex-plugin",
        "**/skills/**/SKILL.md",
        "plugin",
    ),
)


def read_frontmatter(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    match = FRONTMATTER_PATTERN.match(text)
    return match.group(1) if match else ""


def read_json_file(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def line_indent(line):
    return len(line) - len(line.lstrip(" "))


def clean_scalar(value):
    return value.strip().strip(chr(34)).strip(chr(39)).strip()


def fold_block_lines(lines, style):
    text = "\n".join(line.strip() for line in lines).strip()
    if style.startswith(">"):
        text = re.sub(r"\s*\n\s*", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def collect_block_scalar(lines, start_index, base_indent, style):
    block_lines = []
    for line in lines[start_index + 1 :]:
        if not line.strip():
            block_lines.append("")
            continue
        if line_indent(line) <= base_indent:
            break
        block_lines.append(line)
    return fold_block_lines(block_lines, style)


def frontmatter_field(frontmatter, field_name):
    lines = frontmatter.splitlines()
    pattern = re.compile(rf"^(\s*){re.escape(field_name)}\s*:\s*(.*?)\s*$")
    for index, line in enumerate(lines):
        match = pattern.match(line)
        if not match:
            continue
        value = match.group(2).strip()
        if value.startswith(("|", ">")):
            return collect_block_scalar(lines, index, len(match.group(1)), value)
        return clean_scalar(value)
    return None


def nested_metadata_field(frontmatter, field_name):
    in_metadata = False
    lines = frontmatter.splitlines()
    pattern = re.compile(rf"^(\s+){re.escape(field_name)}\s*:\s*(.*?)\s*$")
    for index, line in enumerate(lines):
        if re.match(r"^metadata\s*:\s*$", line):
            in_metadata = True
            continue
        if in_metadata and line and not line.startswith((" ", "\t")):
            in_metadata = False
        if not in_metadata:
            continue
        match = pattern.match(line)
        if match:
            value = match.group(2).strip()
            if value.startswith(("|", ">")):
                return collect_block_scalar(lines, index, len(match.group(1)), value)
            return clean_scalar(value)
    return None


def plugin_info(skill_file):
    parts = skill_file.parts
    try:
        cache_index = parts.index("cache")
        skills_index = parts.index("skills", cache_index + 1)
    except ValueError:
        return None, None
    if skills_index <= cache_index + 2:
        return None, None
    marketplace = parts[cache_index + 1]
    plugin_name = parts[cache_index + 2]
    return plugin_name, f"{plugin_name}@{marketplace}"


def is_managed(record):
    return isinstance(record, dict) and record.get("managed", True) is not False


def skill_origin(name, plugin_key, manifest):
    if plugin_key:
        return "wegent" if is_managed(manifest.get("plugins", {}).get(plugin_key)) else "local"
    return "wegent" if is_managed(manifest.get("skills", {}).get(name)) else "local"


def truncate(text, max_len=300):
    if not text or len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "…"


def real_directory_key(path):
    try:
        return str(path.resolve())
    except OSError:
        return str(path)


def matches_skill_pattern(skill_file, root, pattern):
    if pattern == "**/SKILL.md":
        return True
    try:
        relative_parts = skill_file.relative_to(root).parts
    except ValueError:
        relative_parts = skill_file.parts
    if pattern == "**/skills/**/SKILL.md":
        return "skills" in relative_parts[:-1]
    return skill_file.match(pattern)


def same_directory(left, right):
    try:
        return left.resolve() == right.resolve()
    except OSError:
        return False


def is_shared_legacy_skill_root(root, source):
    if source not in {"claude", "codex"} or not root.is_symlink():
        return False
    return same_directory(root, Path.home() / ".agents" / "skills")


def iter_skill_files(root, pattern):
    visited = set()
    for current, dirnames, filenames in os.walk(root, followlinks=True):
        current_path = Path(current)
        current_key = real_directory_key(current_path)
        if current_key in visited:
            dirnames[:] = []
            continue
        visited.add(current_key)

        next_dirs = []
        for dirname in sorted(dirnames):
            child = current_path / dirname
            child_key = real_directory_key(child)
            if child_key not in visited:
                next_dirs.append(dirname)
        dirnames[:] = next_dirs

        for filename in sorted(filenames):
            if filename != "SKILL.md":
                continue
            skill_file = current_path / filename
            if matches_skill_pattern(skill_file, root, pattern):
                yield skill_file


def skill_metadata(skill_file, source, source_kind, manifest):
    stat = skill_file.stat()
    frontmatter = read_frontmatter(skill_file)
    name = frontmatter_field(frontmatter, "name") or skill_file.parent.name
    plugin_name, plugin_key = (
        plugin_info(skill_file) if source_kind == "plugin" else (None, None)
    )
    metadata = {
        "name": name,
        "description": truncate(frontmatter_field(frontmatter, "description") or ""),
        "short_description": nested_metadata_field(frontmatter, "short-description")
        or frontmatter_field(frontmatter, "short-description"),
        "path": str(skill_file),
        "source": source,
        "origin": skill_origin(name, plugin_key, manifest),
        "mtime": stat.st_mtime,
    }
    if plugin_name:
        metadata["plugin_name"] = plugin_name
    return metadata


manifest = read_json_file(Path.home() / ".wegent-executor" / "capabilities.json")
skills = []
seen_paths = set()
seen_names = set()
for root, source, pattern, source_kind in SKILL_SOURCES:
    if not root.is_dir():
        continue
    if is_shared_legacy_skill_root(root, source):
        continue
    skill_files = (
        iter_skill_files(root, pattern)
        if source_kind == "skill"
        else sorted(root.glob(pattern))
    )
    for skill_file in skill_files:
        key = str(skill_file)
        if key in seen_paths:
            continue
        try:
            metadata = skill_metadata(skill_file, source, source_kind, manifest)
            name = metadata.get("name", "")
            if name in seen_names:
                continue
            skills.append(metadata)
            seen_paths.add(key)
            seen_names.add(name)
        except OSError:
            continue

print(json.dumps(skills, ensure_ascii=False))'"#,
            post_processor: Some("json"),
        }),
        "setup_shared_skills" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import json
import shutil
import sys
from pathlib import Path


def finish(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def fail(message, code=64):
    print(message, file=sys.stderr)
    finish({"success": False, "status": "failed", "error": message}, code)


def same_path(left, right):
    try:
        return left.resolve(strict=False) == right.resolve(strict=False)
    except OSError:
        return False


def unique_target(path, source_name):
    if not path.exists() and not path.is_symlink():
        return path

    base_name = f"{path.name}-{source_name}"
    candidate = path.with_name(base_name)
    if not candidate.exists() and not candidate.is_symlink():
        return candidate

    for index in range(2, 1000):
        candidate = path.with_name(f"{base_name}-{index}")
        if not candidate.exists() and not candidate.is_symlink():
            return candidate
    fail(f"could not find a free target name for {path.name}")


def migrate_entries(source_dir, source_name, shared_dir):
    if source_dir.is_symlink():
        if same_path(source_dir, shared_dir):
            return []
        fail(f"{source_dir} is already a symlink to another location")

    if not source_dir.exists():
        return []
    if not source_dir.is_dir():
        fail(f"{source_dir} exists but is not a directory")

    moved = []
    for entry in sorted(source_dir.iterdir(), key=lambda item: item.name.lower()):
        target = unique_target(shared_dir / entry.name, source_name)
        shutil.move(str(entry), str(target))
        moved.append(
            {
                "source": source_name,
                "from": str(entry),
                "to": str(target),
                "renamed": target.name != entry.name,
            }
        )

    try:
        source_dir.rmdir()
    except OSError as exc:
        fail(f"failed to remove migrated directory {source_dir}: {exc}", code=74)
    return moved


def ensure_link(path, shared_dir):
    if path.is_symlink():
        if same_path(path, shared_dir):
            return {
                "path": str(path),
                "target": str(shared_dir),
                "status": "already_configured",
            }
        fail(f"{path} is already a symlink to another location")

    if path.exists():
        fail(f"{path} still exists after migration")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(shared_dir, target_is_directory=True)
    return {"path": str(path), "target": str(shared_dir), "status": "created"}


home = Path.home().resolve()
shared_dir = home / ".agents" / "skills"
legacy_dirs = (
    (home / ".codex" / "skills", "codex"),
    (home / ".claude" / "skills", "claude"),
)

if shared_dir.exists() and not shared_dir.is_dir():
    fail(f"{shared_dir} exists but is not a directory")

shared_created = not shared_dir.exists()
shared_dir.mkdir(parents=True, exist_ok=True)

moved = []
for legacy_dir, source_name in legacy_dirs:
    moved.extend(migrate_entries(legacy_dir, source_name, shared_dir))

links = [ensure_link(legacy_dir, shared_dir) for legacy_dir, _ in legacy_dirs]

finish(
    {
        "success": True,
        "status": "configured",
        "shared_path": str(shared_dir),
        "shared_created": shared_created,
        "legacy_paths": [str(path) for path, _ in legacy_dirs],
        "moved_count": len(moved),
        "moved": moved,
        "links": links,
    }
)'"#,
            post_processor: Some("json"),
        }),
        _ => None,
    }
}
