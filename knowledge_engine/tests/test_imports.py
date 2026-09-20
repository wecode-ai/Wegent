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
    paths: list[Path] = []
    for target in targets:
        path = root / target
        paths.extend(sorted(path.rglob("*.py")) if path.is_dir() else [path])
    return "\n".join(path.read_text(encoding="utf-8") for path in paths)


def _project_text(name: str) -> str:
    """One file of the knowledge engine project, read as text."""
    return (Path(__file__).resolve().parents[1] / name).read_text(encoding="utf-8")


def test_the_legacy_milvus_adapter_keeps_the_llamaindex_wrapper() -> None:
    """The legacy adapter was built on that wrapper and still writes through it.

    The declared floor is the one worth pinning: the restored adapter passes
    the wrapper's upsert mode, which the stores before the 0.9 line do not
    take, so a lower floor could install a wrapper it cannot construct.
    """
    assert "llama-index-vector-stores-milvus>=0.9.0" in _project_text("pyproject.toml")
    assert "llama_index.vector_stores.milvus" in _storage_source("milvus_backend.py")


def test_the_milvus_v2_adapter_keeps_its_own_sdk_dependency() -> None:
    """The V2 adapter talks to PyMilvus directly and never restores the wrapper."""
    assert "pymilvus>=2.6.3,<2.6.4" in _project_text("pyproject.toml")
    assert "llama_index.vector_stores.milvus" not in _storage_source("milvus")


def test_the_two_milvus_adapters_share_one_pymilvus_version() -> None:
    """Both adapters are locked against the one PyMilvus version.

    This pins the lockfile's single SDK entry, which is what keeps the two
    adapters from drifting onto two PyMilvus versions. Proving that both load
    together against a running service belongs to the compatibility smoke.
    """
    # A package entry names itself on a line of its own, which is what tells it
    # apart from the dependency lists that mention PyMilvus by name too.
    assert _project_text("uv.lock").splitlines().count('name = "pymilvus"') == 1
