# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Fail tests that attempt to import the removed Backend execution paths."""

import importlib.abc
import sys

import pytest


class RemovedRagImportGuard(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith(
            (
                "app.services.rag.local_gateway",
                "app.services.rag.local_data_plane",
                "app.services.rag.retrieval_service",
                "app.services.rag.embedding",
            )
        ):
            raise AssertionError(f"Removed Backend RAG execution imported: {fullname}")
        return None


@pytest.fixture(autouse=True)
def reject_local_rag_imports():
    guard = RemovedRagImportGuard()
    sys.meta_path.insert(0, guard)
    try:
        yield
    finally:
        sys.meta_path.remove(guard)
