# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capability-only Backend modules must not load the RAG execution kernel."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[3]

CAPABILITY_IMPORT_SCRIPT = """
import importlib
import sys

for module_name in (
    "app.api.endpoints.adapter.retrievers",
    "app.services.rag.runtime_resolver",
    "app.services.model_embedding_dimension",
):
    importlib.import_module(module_name)

prefixes = ("llama_index", "pymilvus", "qdrant_client", "elasticsearch")
loaded = [name for name in sys.modules if name.startswith(prefixes)]
print("|".join(loaded))
"""


def test_capability_modules_do_not_load_the_execution_kernel() -> None:
    completed = subprocess.run(
        [sys.executable, "-c", CAPABILITY_IMPORT_SCRIPT],
        capture_output=True,
        text=True,
        cwd=BACKEND_ROOT,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == ""
