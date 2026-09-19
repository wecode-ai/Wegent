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


def test_milvus_adapter_keeps_its_own_sdk_dependency() -> None:
    """The adapter talks to PyMilvus directly and never restores the wrapper."""
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")

    assert "llama-index-vector-stores-milvus" not in text
    assert "pymilvus>=2.6.3,<2.6.4" in text
