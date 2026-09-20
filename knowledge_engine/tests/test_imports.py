# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib
from pathlib import Path


def test_import_knowledge_engine_root_package() -> None:
    package = importlib.import_module("knowledge_engine")

    assert package.__version__ == "1.0.0"


def test_import_knowledge_engine_subpackages() -> None:
    module_names = [
        "knowledge_engine.embedding",
        "knowledge_engine.index",
        "knowledge_engine.query",
        "knowledge_engine.services",
        "knowledge_engine.splitter",
        "knowledge_engine.storage",
    ]

    for module_name in module_names:
        assert importlib.import_module(module_name) is not None


def _storage_source(*targets: str) -> str:
    """Every production source of one storage adapter, module or package."""
    root = Path(__file__).resolve().parents[1] / "knowledge_engine" / "storage"
    paths = []
    for target in targets:
        path = root / target
        paths.extend(sorted(path.rglob("*.py")) if path.is_dir() else [path])
    return "\n".join(path.read_text(encoding="utf-8") for path in paths)


def test_the_legacy_milvus_adapter_keeps_the_llamaindex_wrapper() -> None:
    """The legacy adapter was built on that wrapper and still writes through it."""
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")

    assert "llama-index-vector-stores-milvus>=0.9.0" in text
    assert "llama_index.vector_stores.milvus" in _storage_source("milvus_backend.py")


def test_the_milvus_v2_adapter_keeps_its_own_sdk_dependency() -> None:
    """The V2 adapter talks to PyMilvus directly and never restores the wrapper."""
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")

    assert "pymilvus>=2.6.3,<2.6.4" in text
    assert "llama_index.vector_stores.milvus" not in _storage_source("milvus")


def test_the_two_milvus_adapters_share_one_pymilvus_version() -> None:
    """Both adapters are built from the one SDK version the lock pins."""
    lock = (Path(__file__).resolve().parents[1] / "uv.lock").read_text(encoding="utf-8")

    assert lock.count('\nname = "pymilvus"\nversion = ') == 1
