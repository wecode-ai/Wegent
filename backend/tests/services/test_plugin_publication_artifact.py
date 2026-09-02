# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import io
import json
import zipfile

import pytest
from fastapi import HTTPException

from app.services.plugin_publication_artifact import (
    SOURCE_TREE_HASH_PREFIX,
    canonical_complete_plugin_files,
    canonical_complete_tree_sha256,
    canonical_plugin_files,
    canonical_source_tree_sha256,
    read_plugin_root_member,
)


def _zip(entries: list[tuple[str, bytes, int]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for path, content, mode in entries:
            info = zipfile.ZipInfo(path)
            info.create_system = 3
            info.external_attr = mode << 16
            archive.writestr(info, content)
    return output.getvalue()


def _manifest() -> bytes:
    return json.dumps({"name": "canonical-test", "version": "1.0.0"}).encode()


def test_canonical_hash_uses_v1_framing_and_preserves_executable_mode() -> None:
    package = _zip(
        [
            ("wrapper/.codex-plugin/plugin.json", _manifest(), 0o644),
            ("wrapper/scripts/run.sh", b"#!/bin/sh\n", 0o755),
            ("wrapper/.wework-publication.json", b"{}", 0o644),
            ("wrapper/plugin-risk.json", b"{}", 0o644),
        ]
    )
    records = [
        (b".codex-plugin/plugin.json", 0o644, _manifest()),
        (b"scripts/run.sh", 0o755, b"#!/bin/sh\n"),
    ]
    expected = hashlib.sha256(SOURCE_TREE_HASH_PREFIX)
    for path, mode, content in sorted(records):
        expected.update(len(path).to_bytes(4, "big"))
        expected.update(path)
        expected.update(mode.to_bytes(2, "big"))
        expected.update(len(content).to_bytes(8, "big"))
        expected.update(content)

    files = canonical_plugin_files(package)

    assert files["scripts/run.sh"].mode == 0o755
    assert canonical_source_tree_sha256(package) == expected.hexdigest()
    assert set(canonical_complete_plugin_files(package)) == {
        ".codex-plugin/plugin.json",
        ".wework-publication.json",
        "plugin-risk.json",
        "scripts/run.sh",
    }
    assert canonical_complete_tree_sha256(package) != expected.hexdigest()


def test_canonical_hash_changes_when_executable_mode_changes() -> None:
    regular = _zip(
        [
            (".codex-plugin/plugin.json", _manifest(), 0o644),
            ("scripts/run.sh", b"#!/bin/sh\n", 0o644),
        ]
    )
    executable = _zip(
        [
            (".codex-plugin/plugin.json", _manifest(), 0o644),
            ("scripts/run.sh", b"#!/bin/sh\n", 0o755),
        ]
    )

    assert canonical_source_tree_sha256(regular) != canonical_source_tree_sha256(
        executable
    )


@pytest.mark.parametrize(
    "generated_path",
    [
        ".git/config",
        ".pytest_cache/state",
        "__pycache__/plugin.pyc",
        "node_modules/package/index.js",
        ".DS_Store",
    ],
)
def test_canonical_files_reject_ci_ignored_source_paths(generated_path: str) -> None:
    package = _zip(
        [
            (".codex-plugin/plugin.json", _manifest(), 0o644),
            (generated_path, b"generated", 0o644),
        ]
    )

    with pytest.raises(HTTPException) as exc_info:
        canonical_plugin_files(package)

    assert exc_info.value.status_code == 422
    assert str(exc_info.value.detail).endswith(generated_path)


def test_canonical_paths_reject_nfc_collisions() -> None:
    package = _zip(
        [
            (".codex-plugin/plugin.json", _manifest(), 0o644),
            ("caf\N{LATIN SMALL LETTER E WITH ACUTE}.txt", b"composed", 0o644),
            ("cafe\N{COMBINING ACUTE ACCENT}.txt", b"decomposed", 0o644),
        ]
    )

    with pytest.raises(HTTPException) as exc_info:
        canonical_source_tree_sha256(package)

    assert exc_info.value.status_code == 422
    assert "NFC normalization" in str(exc_info.value.detail)


def test_generated_metadata_must_be_at_the_detected_plugin_root() -> None:
    package = _zip(
        [
            ("wrapper/.codex-plugin/plugin.json", _manifest(), 0o644),
            ("outside/.wework-publication.json", b"{}", 0o644),
        ]
    )

    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        with pytest.raises(HTTPException) as exc_info:
            read_plugin_root_member(archive, ".wework-publication.json")

    assert exc_info.value.status_code == 422


def test_canonical_files_reject_regular_files_outside_plugin_root() -> None:
    package = _zip(
        [
            ("wrapper/.codex-plugin/plugin.json", _manifest(), 0o644),
            ("README.md", b"outside", 0o644),
        ]
    )

    with pytest.raises(HTTPException) as exc_info:
        canonical_plugin_files(package)

    assert exc_info.value.status_code == 422
    assert "outside the plugin root" in str(exc_info.value.detail)


def test_canonical_files_reject_multiple_plugin_roots() -> None:
    package = _zip(
        [
            ("one/.codex-plugin/plugin.json", _manifest(), 0o644),
            ("two/.codex-plugin/plugin.json", _manifest(), 0o644),
        ]
    )

    with pytest.raises(HTTPException) as exc_info:
        canonical_plugin_files(package)

    assert exc_info.value.status_code == 422
    assert "multiple plugin roots" in str(exc_info.value.detail)
