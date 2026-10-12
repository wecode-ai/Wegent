# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Query planning is reusable without a product database or Runtime adapter."""

import json
import subprocess
import sys

import pytest

from shared.knowledge_module import plan_query


@pytest.mark.parametrize(
    "hints,source",
    [
        (None, "qa_pair_profile"),
        ({}, "fallback"),
        (
            {"keywords": ["release"], "semantic_query": "release checklist"},
            "explicit_hints",
        ),
    ],
)
def test_authorized_qa_metadata_never_overrides_explicit_hints(hints, source):
    plan = plan_query("微博 大广场模式 2025 有什么优势", hints, qa_pair_count=2)
    assert plan.hint_source == source
    if source == "qa_pair_profile":
        assert "大广场模式" in plan.phrases
    elif source == "explicit_hints":
        assert plan.dense_query == "release checklist"
        assert plan.keywords == ["release"]
    else:
        assert plan.keywords == []


def test_query_without_authorized_qa_metadata_uses_normalized_fallback():
    plan = plan_query("  release   checklist  ", qa_pair_count=0)
    assert plan.hint_source == "fallback"
    assert plan.dense_query == "release checklist"
    assert plan.sparse_query == "release checklist"


def test_second_service_can_plan_queries_without_product_orm():
    script = r"""
import importlib.abc
import json
import sys

class ProductImportGuard(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith(("shared.models", "shared.db", "knowledge_runtime", "knowledge_engine", "backend", "celery", "sqlalchemy")):
            raise AssertionError(fullname)
        return None

sys.meta_path.insert(0, ProductImportGuard())
from shared.knowledge_module import plan_query
qa = plan_query("微博 大广场模式 2025 有什么优势", qa_pair_count=2)
explicit = plan_query("question", {"keywords": ["approved"]}, qa_pair_count=2)
print(json.dumps([qa.hint_source, explicit.hint_source, explicit.keywords]))
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=True
    )
    assert json.loads(result.stdout) == [
        "qa_pair_profile",
        "explicit_hints",
        ["approved"],
    ]
