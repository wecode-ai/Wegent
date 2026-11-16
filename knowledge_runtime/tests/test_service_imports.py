# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep storage administration and factory imports independent of model SDKs."""

import os
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


def test_runtime_entrypoint_does_not_bootstrap_storage_sdk_environment(
    tmp_path,
) -> None:
    script = """
import sys
from unittest.mock import patch
from knowledge_engine.storage.errors import MilvusRowTooLargeError
assert 'pymilvus' not in sys.modules
assert 'llama_index.core' not in sys.modules
with patch('dotenv.load_dotenv', side_effect=AssertionError('Storage SDK must not load env during app import')):
    import knowledge_runtime.main
assert 'pymilvus' not in sys.modules
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        env={
            key: value
            for key, value in os.environ.items()
            if key
            not in {
                "KNOWLEDGE_RUNTIME_INTERNAL_SERVICE_TOKEN",
                "INTERNAL_SERVICE_TOKEN",
            }
        },
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
