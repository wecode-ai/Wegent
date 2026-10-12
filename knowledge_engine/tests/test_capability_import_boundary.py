# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capability queries must not pull the execution kernel into the process."""

from __future__ import annotations

import subprocess
import sys

CAPABILITY_IMPORT_SCRIPT = """
import sys

from knowledge_engine.embedding.capabilities import (
    embedding_supports_image_input,
    normalize_additional_input_modalities,
)
from knowledge_engine.embedding.contract import is_positive_int
from knowledge_engine.storage.capabilities import (
    get_all_storage_retrieval_methods,
    get_supported_retrieval_methods,
    get_supported_storage_types,
)
from knowledge_engine.storage.factory import create_storage_backend_from_config

assert get_supported_storage_types() == ["elasticsearch", "qdrant", "milvus"]
assert get_supported_retrieval_methods("qdrant") == ["vector"]
assert get_all_storage_retrieval_methods()["milvus"] == [
    "vector",
    "keyword",
    "hybrid",
]
assert normalize_additional_input_modalities(["image"]) == ["image"]
assert embedding_supports_image_input(["image"]) is True
assert is_positive_int(3) is True
assert create_storage_backend_from_config is not None

prefixes = ("llama_index", "pymilvus", "qdrant_client", "elasticsearch")
loaded = [name for name in sys.modules if name.startswith(prefixes)]
print("|".join(loaded))
"""


def test_capability_imports_do_not_load_storage_backends() -> None:
    completed = subprocess.run(
        [sys.executable, "-c", CAPABILITY_IMPORT_SCRIPT],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == ""
