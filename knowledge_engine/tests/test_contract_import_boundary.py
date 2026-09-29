# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Import boundary tests for the reusable knowledge contracts.

The knowledge contracts must stay usable by a service that never loads Wegent
product ORM models, database sessions, or task workers. The boundary is checked
in a subprocess so the assertions describe a clean interpreter instead of the
already loaded pytest process.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from typing import Any

import pytest

# Wegent product ORM, database session, and task worker modules that the pure
# knowledge contracts must never drag in. Third-party ORM libraries pulled in by
# unrelated dependencies are not part of this boundary.
FORBIDDEN_MODULES = (
    "shared.models",
    "shared.models.db",
    "shared.db",
    "backend",
    "celery",
)

_BOUNDARY_SCRIPT = textwrap.dedent(f"""
    import json
    import sys

    import knowledge_engine.embedding.factory  # noqa: F401
    import knowledge_engine.query.executor  # noqa: F401
    import knowledge_engine.splitter.config  # noqa: F401
    import knowledge_engine.storage.factory  # noqa: F401

    from shared.knowledge_contracts import (
        RetrievalScope,
        RuntimeEmbeddingModelConfig,
        RuntimeRetrievalConfig,
        RuntimeRetrieverConfig,
        SearchHints,
        normalize_runtime_splitter_config,
    )

    forbidden = {FORBIDDEN_MODULES!r}
    loaded_forbidden = sorted(
        name
        for name in sys.modules
        if any(name == item or name.startswith(f"{{item}}.") for item in forbidden)
    )
    contract_modules = sorted(
        {{
            RetrievalScope.__module__,
            RuntimeRetrievalConfig.__module__,
            SearchHints.__module__,
            normalize_runtime_splitter_config.__module__,
        }}
    )

    retrieval_config = RuntimeRetrievalConfig(top_k=5, score_threshold=0.5)
    scope = RetrievalScope(document_ids=[2, 1, 2])
    hints = SearchHints(
        semantic_query="  deploy   pipeline  ",
        keywords=[" alpha ", "alpha", "  "],
    )
    splitter_config = normalize_runtime_splitter_config(None)
    retriever_config = RuntimeRetrieverConfig(name="opensource")
    embedding_config = RuntimeEmbeddingModelConfig(model_name="text-embedding-v1")

    print(json.dumps({{
        "loaded_forbidden": loaded_forbidden,
        "contract_modules": contract_modules,
        "retrieval_config": retrieval_config.model_dump(),
        "scope_document_ids": scope.document_ids,
        "hints_semantic_query": hints.semantic_query,
        "hints_keywords": hints.keywords,
        "splitter_strategy": splitter_config.chunk_strategy,
        "retriever_namespace": retriever_config.namespace,
        "embedding_namespace": embedding_config.model_namespace,
    }}))
    """)


def _run_boundary_script() -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, "-c", _BOUNDARY_SCRIPT],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


@pytest.fixture(scope="module")
def boundary_payload() -> dict[str, Any]:
    """Run the ORM-free boundary script once for all assertions."""
    return _run_boundary_script()


def test_contracts_import_without_wegent_product_orm(
    boundary_payload: dict[str, Any],
) -> None:
    assert boundary_payload["loaded_forbidden"] == []
    assert all(
        module_name.startswith("shared.knowledge_contracts.")
        for module_name in boundary_payload["contract_modules"]
    ), boundary_payload["contract_modules"]


def test_contracts_remain_usable_in_orm_free_process(
    boundary_payload: dict[str, Any],
) -> None:
    assert boundary_payload["retrieval_config"]["top_k"] == 5
    assert boundary_payload["retrieval_config"]["score_threshold"] == 0.5
    assert boundary_payload["retrieval_config"]["retrieval_mode"] == "vector"
    assert boundary_payload["scope_document_ids"] == [2, 1]
    assert boundary_payload["hints_semantic_query"] == "deploy pipeline"
    assert boundary_payload["hints_keywords"] == ["alpha"]
    assert boundary_payload["splitter_strategy"] == "flat"
    assert boundary_payload["retriever_namespace"] == "default"
    assert boundary_payload["embedding_namespace"] == "default"


def test_existing_callers_share_one_contract_definition() -> None:
    """Product callers and the pure contracts entry must expose the same types."""
    from shared import knowledge_contracts
    from shared.models import (
        RetrievalScope,
        RuntimeEmbeddingModelConfig,
        RuntimeRetrievalConfig,
        RuntimeRetrieverConfig,
        SearchHints,
        normalize_splitter_config,
    )

    assert RetrievalScope is knowledge_contracts.RetrievalScope
    assert RuntimeRetrieverConfig is knowledge_contracts.RuntimeRetrieverConfig
    assert (
        RuntimeEmbeddingModelConfig is knowledge_contracts.RuntimeEmbeddingModelConfig
    )
    assert RuntimeRetrievalConfig is knowledge_contracts.RuntimeRetrievalConfig
    assert SearchHints is knowledge_contracts.SearchHints
    assert normalize_splitter_config is knowledge_contracts.normalize_splitter_config


def test_remote_transport_carries_the_migrated_scope_contract() -> None:
    """The remote query protocol must reuse the migrated scope contract."""
    from pydantic import ValidationError

    from shared import knowledge_contracts
    from shared.models import RemoteQueryRequest

    request = RemoteQueryRequest.model_validate(
        {
            "knowledge_base_ids": [1],
            "user_id": 7,
            "query": "deploy pipeline",
            "scope": {"document_ids": [3, 5, 3]},
            "document_ids": [3, 5],
        }
    )

    assert type(request.scope) is knowledge_contracts.RetrievalScope
    assert request.scope is not None
    assert request.scope.document_ids == [3, 5]

    with pytest.raises(ValidationError):
        RemoteQueryRequest.model_validate(
            {
                "knowledge_base_ids": [1],
                "user_id": 7,
                "query": "deploy pipeline",
                "scope": {"document_ids": [3]},
                "document_ids": [5],
            }
        )
