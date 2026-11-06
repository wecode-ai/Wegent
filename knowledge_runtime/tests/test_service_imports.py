# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep storage administration and factory imports independent of model SDKs."""

import subprocess
import sys

import pytest


@pytest.mark.parametrize(
    "module",
    [
        "knowledge_runtime.services.admin_executor",
        "knowledge_engine.embedding.factory",
    ],
)
def test_service_import_does_not_load_model_sdk(module: str) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"import importlib, sys; importlib.import_module({module!r}); "
            "assert 'llama_index.core' not in sys.modules",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
