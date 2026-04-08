# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib


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
