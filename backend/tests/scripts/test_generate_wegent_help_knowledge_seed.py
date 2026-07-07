# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.generate_wegent_help_knowledge_seed import generate_seed

pytestmark = pytest.mark.unit


def test_generate_seed_writes_stable_manifest_and_docs(tmp_path: Path) -> None:
    docs_root = tmp_path / "docs"
    zh_doc = docs_root / "zh" / "user-guide" / "quick-start.md"
    en_doc = docs_root / "en" / "developer-guide" / "setup.md"
    zh_doc.parent.mkdir(parents=True)
    en_doc.parent.mkdir(parents=True)
    zh_content = "---\nsidebar_position: 1\n---\n\n# 快速开始\n\n内容\n"
    en_content = "# Setup\n\nInstall Wegent.\n"
    zh_doc.write_text(zh_content, encoding="utf-8")
    en_doc.write_text(en_content, encoding="utf-8")

    output_dir = tmp_path / "seed"

    result = generate_seed(docs_root=docs_root, output_dir=output_dir)

    manifest_path = output_dir / "manifest.json"
    assert result == manifest_path
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["knowledge_base"]["name"] == "Wegent Help"
    assert [doc["source_path"] for doc in manifest["documents"]] == [
        "docs/en/developer-guide/setup.md",
        "docs/zh/user-guide/quick-start.md",
    ]
    assert manifest["documents"][0]["language"] == "en"
    assert manifest["documents"][0]["title"] == "Setup"
    assert manifest["documents"][1]["language"] == "zh"
    assert manifest["documents"][1]["title"] == "快速开始"
    assert (
        manifest["documents"][1]["content_sha256"]
        == hashlib.sha256(zh_content.encode("utf-8")).hexdigest()
    )
    assert (output_dir / "docs" / "zh" / "user-guide" / "quick-start.md").read_text(
        encoding="utf-8"
    ) == zh_content
    assert (output_dir / "docs" / "en" / "developer-guide" / "setup.md").read_text(
        encoding="utf-8"
    ) == en_content


def test_generate_seed_rejects_missing_language_roots(tmp_path: Path) -> None:
    docs_root = tmp_path / "docs"
    docs_root.mkdir()

    with pytest.raises(ValueError, match="docs/zh and docs/en"):
        generate_seed(docs_root=docs_root, output_dir=tmp_path / "seed")


def test_generate_seed_rejects_output_dir_that_contains_docs_root(
    tmp_path: Path,
) -> None:
    docs_root = tmp_path / "docs"
    (docs_root / "en").mkdir(parents=True)
    (docs_root / "zh").mkdir()

    with pytest.raises(ValueError, match="overlap docs_root"):
        generate_seed(docs_root=docs_root, output_dir=tmp_path)

    assert docs_root.exists()


def test_generate_seed_rejects_output_dir_inside_docs_root(tmp_path: Path) -> None:
    docs_root = tmp_path / "docs"
    (docs_root / "en").mkdir(parents=True)
    (docs_root / "zh").mkdir()

    with pytest.raises(ValueError, match="overlap docs_root"):
        generate_seed(docs_root=docs_root, output_dir=docs_root / "seed")
