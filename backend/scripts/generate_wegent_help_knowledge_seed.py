#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Generate the built-in Wegent Help system knowledge seed."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

DEFAULT_SEED_ID = "wegent-help"
DEFAULT_KB_NAME = "Wegent Help"
DEFAULT_KB_DISPLAY_NAME = "Wegent 帮助文档"
DEFAULT_NAMESPACE = "system"


def _strip_frontmatter(content: str) -> str:
    if not content.startswith("---\n"):
        return content

    end = content.find("\n---\n", 4)
    if end == -1:
        return content

    return content[end + len("\n---\n") :]


def _extract_title(content: str, fallback: str) -> str:
    body = _strip_frontmatter(content)
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            if title:
                return title
    return fallback


def _iter_markdown_docs(docs_root: Path) -> list[Path]:
    zh_root = docs_root / "zh"
    en_root = docs_root / "en"
    if not zh_root.is_dir() or not en_root.is_dir():
        raise ValueError("docs_root must contain docs/zh and docs/en directories")

    docs = [
        path
        for root in (en_root, zh_root)
        for path in root.rglob("*.md")
        if path.is_file()
    ]
    return sorted(docs, key=lambda path: path.relative_to(docs_root).as_posix())


def _build_document_entry(docs_root: Path, path: Path, content: str) -> dict[str, Any]:
    relative = path.relative_to(docs_root)
    relative_posix = relative.as_posix()
    language = relative.parts[0]
    category = "/".join(relative.parts[1:-1])

    return {
        "source_path": f"docs/{relative_posix}",
        "seed_path": f"docs/{relative_posix}",
        "language": language,
        "title": _extract_title(content, path.stem),
        "category": category,
        "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
    }


def _validate_output_dir(*, docs_root: Path, output_dir: Path) -> None:
    if output_dir == Path(output_dir.anchor):
        raise ValueError("Refusing to use filesystem root as output_dir")
    if (
        output_dir == docs_root
        or docs_root in output_dir.parents
        or output_dir in docs_root.parents
    ):
        raise ValueError("output_dir must not overlap docs_root")


def generate_seed(*, docs_root: Path, output_dir: Path) -> Path:
    """Generate a deterministic system knowledge seed from Markdown docs."""
    docs_root = docs_root.resolve()
    output_dir = output_dir.resolve()
    _validate_output_dir(docs_root=docs_root, output_dir=output_dir)

    if output_dir.exists():
        shutil.rmtree(output_dir)

    (output_dir / "docs").mkdir(parents=True, exist_ok=True)

    documents: list[dict[str, Any]] = []
    for source_path in _iter_markdown_docs(docs_root):
        content = source_path.read_text(encoding="utf-8")
        entry = _build_document_entry(docs_root, source_path, content)
        target_path = output_dir / entry["seed_path"]
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(content, encoding="utf-8")
        documents.append(entry)

    manifest = {
        "seed_id": DEFAULT_SEED_ID,
        "knowledge_base": {
            "name": DEFAULT_KB_NAME,
            "display_name": DEFAULT_KB_DISPLAY_NAME,
            "namespace": DEFAULT_NAMESPACE,
            "description": "Built-in Wegent user and developer documentation.",
        },
        "documents": documents,
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs-root", type=Path, default=_default_repo_root() / "docs")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "init_data"
        / "system_knowledge"
        / DEFAULT_SEED_ID,
    )
    args = parser.parse_args()

    manifest_path = generate_seed(docs_root=args.docs_root, output_dir=args.output_dir)
    print(f"Generated Wegent Help system knowledge seed: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
