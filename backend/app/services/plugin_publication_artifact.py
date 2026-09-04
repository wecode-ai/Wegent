# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Canonical source-tree identity for plugin publication artifacts."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import unicodedata
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath

from fastapi import HTTPException

GENERATED_PUBLICATION_FILES = {
    ".wework-publication.json",
    "plugin-risk.json",
}
IGNORED_SOURCE_DIRECTORY_NAMES = {
    ".git",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
}
IGNORED_SOURCE_FILE_NAMES = {".DS_Store"}
SOURCE_TREE_HASH_PREFIX = b"wework-plugin-source-tree-v1\0"
RELEASE_IDEMPOTENCY_KEY_PATTERN = re.compile(r"wework-plugin-v1:[0-9a-f]{64}\Z")
PLUGIN_MANIFEST_PATHS = (
    (".codex-plugin", "plugin.json"),
    (".claude-plugin", "plugin.json"),
)


@dataclass(frozen=True)
class CanonicalPluginFile:
    path: str
    content: bytes
    mode: int


def canonical_release_envelope(envelope: dict) -> bytes:
    """Serialize the complete validated release request for durable binding."""
    return json.dumps(
        envelope,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def release_envelope_sha256(envelope: dict) -> str:
    """Hash every validated release-envelope field."""
    return hashlib.sha256(canonical_release_envelope(envelope)).hexdigest()


def expected_release_idempotency_key(envelope: dict) -> str:
    """Derive the key produced by the protected GitLab release client."""
    source = envelope["source"]
    artifact = envelope["artifact"]
    identity = "\0".join(
        [
            str(source["projectId"]),
            str(source["sourceCommitSha"]),
            str(artifact["sha256"]),
        ]
    ).encode("utf-8")
    return f"wework-plugin-v1:{hashlib.sha256(identity).hexdigest()}"


def validate_release_idempotency_key(key: str, envelope: dict) -> None:
    """Reject malformed or envelope-independent release keys."""
    validate_release_idempotency_key_format(key)
    expected = expected_release_idempotency_key(envelope)
    if not secrets.compare_digest(key, expected):
        raise HTTPException(
            status_code=422,
            detail="Idempotency-Key does not match the release artifact",
        )


def validate_release_idempotency_key_format(key: str) -> None:
    """Require the exact versioned key shape before database access."""
    if not RELEASE_IDEMPOTENCY_KEY_PATTERN.fullmatch(key):
        raise HTTPException(status_code=422, detail="Invalid Idempotency-Key format")


def canonical_plugin_files(package: bytes) -> dict[str, CanonicalPluginFile]:
    """Normalize ZIP root, paths, modes, and content for a stable tree hash."""
    return _canonical_plugin_files(package, exclude_generated=True)


def canonical_complete_plugin_files(package: bytes) -> dict[str, CanonicalPluginFile]:
    """Normalize every plugin file, including generated review metadata."""
    return _canonical_plugin_files(package, exclude_generated=False)


def _canonical_plugin_files(
    package: bytes, *, exclude_generated: bool
) -> dict[str, CanonicalPluginFile]:
    try:
        with zipfile.ZipFile(BytesIO(package)) as archive:
            members = [member for member in archive.infolist() if not member.is_dir()]
            raw_paths = [_safe_zip_parts(member.filename) for member in members]
            root_parts = _plugin_root_parts(raw_paths)
            files: dict[str, CanonicalPluginFile] = {}
            normalized_paths: set[bytes] = set()
            for member, parts in zip(members, raw_paths, strict=True):
                if parts[: len(root_parts)] != root_parts:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            "Release artifact contains a regular file outside the "
                            "plugin root"
                        ),
                    )
                relative_parts = parts[len(root_parts) :]
                relative = PurePosixPath(*relative_parts).as_posix()
                relative = unicodedata.normalize("NFC", relative)
                if not relative or (
                    exclude_generated and relative in GENERATED_PUBLICATION_FILES
                ):
                    continue
                if (
                    any(
                        part in IGNORED_SOURCE_DIRECTORY_NAMES
                        for part in relative_parts[:-1]
                    )
                    or relative_parts[-1] in IGNORED_SOURCE_FILE_NAMES
                ):
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            "Release artifact contains a non-source path that must "
                            f"be excluded: {relative}"
                        ),
                    )
                try:
                    path_bytes = relative.encode("utf-8")
                except UnicodeEncodeError as exc:
                    raise HTTPException(
                        status_code=422,
                        detail="Release artifact source paths must be valid UTF-8",
                    ) from exc
                if path_bytes in normalized_paths:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            "Release artifact contains source paths that collide "
                            "after NFC normalization"
                        ),
                    )
                normalized_paths.add(path_bytes)
                file_type = (member.external_attr >> 16) & 0o170000
                if file_type not in {0, 0o100000}:
                    raise HTTPException(
                        status_code=422,
                        detail="Release artifact contains a non-regular source file",
                    )
                raw_mode = (member.external_attr >> 16) & 0o777
                mode = 0o755 if raw_mode & 0o111 else 0o644
                files[relative] = CanonicalPluginFile(
                    path=relative,
                    content=archive.read(member),
                    mode=mode,
                )
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=422, detail="Invalid plugin ZIP") from exc
    return files


def canonical_source_tree_sha256(package: bytes) -> str:
    """Hash sorted path, normalized mode, byte length, and exact content."""
    return canonical_source_tree_sha256_from_files(canonical_plugin_files(package))


def canonical_complete_tree_sha256(package: bytes) -> str:
    """Hash every regular plugin file for exact Git commit comparison."""
    return canonical_source_tree_sha256_from_files(
        canonical_complete_plugin_files(package)
    )


def canonical_source_tree_sha256_from_files(
    files: dict[str, CanonicalPluginFile],
) -> str:
    """Hash a previously validated canonical file inventory."""
    digest = hashlib.sha256(SOURCE_TREE_HASH_PREFIX)
    records = sorted(
        files.items(),
        key=lambda item: item[0].encode("utf-8"),
    )
    for path, item in records:
        path_bytes = path.encode("utf-8")
        digest.update(len(path_bytes).to_bytes(4, "big"))
        digest.update(path_bytes)
        digest.update(item.mode.to_bytes(2, "big"))
        digest.update(len(item.content).to_bytes(8, "big"))
        digest.update(item.content)
    return digest.hexdigest()


def read_plugin_root_member(archive: zipfile.ZipFile, filename: str) -> bytes:
    """Read exactly one generated file from the detected plugin root."""
    members = [member for member in archive.infolist() if not member.is_dir()]
    paths = [_safe_zip_parts(member.filename) for member in members]
    root_parts = _plugin_root_parts(paths)
    expected_parts = (*root_parts, filename)
    matches = [
        member
        for member, parts in zip(members, paths, strict=True)
        if parts == expected_parts
    ]
    if len(matches) != 1:
        raise HTTPException(
            status_code=422,
            detail=f"Release artifact must contain exactly one root {filename}",
        )
    return archive.read(matches[0])


def _safe_zip_parts(filename: str) -> tuple[str, ...]:
    """Return path parts without letting path helpers erase unsafe segments."""
    if filename.startswith(("/", "\\")) or "\\" in filename or "\0" in filename:
        raise HTTPException(
            status_code=422,
            detail="Release artifact contains an unsafe source path",
        )
    parts = tuple(filename.split("/"))
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(
            status_code=422,
            detail="Release artifact contains an unsafe source path",
        )
    return parts


def _plugin_root_parts(paths: list[tuple[str, ...]]) -> tuple[str, ...]:
    """Resolve the same manifest-relative plugin root used for materialization."""
    candidates: list[tuple[int, int, tuple[str, ...]]] = []
    for parts in paths:
        for preference, manifest_parts in enumerate(PLUGIN_MANIFEST_PATHS):
            if len(parts) < len(manifest_parts):
                continue
            if parts[-len(manifest_parts) :] == manifest_parts:
                root = parts[: -len(manifest_parts)]
                candidates.append((len(root), preference, root))
    if not candidates:
        raise HTTPException(
            status_code=422,
            detail=(
                "Plugin must include .codex-plugin/plugin.json or "
                ".claude-plugin/plugin.json"
            ),
        )
    roots = {candidate[2] for candidate in candidates}
    if len(roots) != 1:
        raise HTTPException(
            status_code=422,
            detail="Release artifact contains multiple plugin roots",
        )
    return min(candidates)[2]
