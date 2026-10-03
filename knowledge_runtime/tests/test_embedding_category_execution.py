# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""A current capability mismatch stops execution before model construction."""

from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.config_resolver import ConfigResolutionError
from knowledge_runtime.services.index_executor import IndexExecutor
from knowledge_runtime.services.query_executor import QueryExecutor
from shared.models import (
    PresignedUrlContentRef,
    RemoteAuthorizedRetrievalResources,
    RemoteIndexRequest,
    RemoteQueryRequest,
    RemoteRetrievalResourceRef,
)
from shared.models.db import Kind


@pytest.mark.parametrize("operation", ["query", "index"])
@pytest.mark.parametrize("explicit_selection", [False, True])
@pytest.mark.asyncio
async def test_category_mismatch_never_constructs_or_executes_model(
    shared_model_db: Session, operation: str, explicit_selection: bool
) -> None:
    """Real config resolution rejects LLM before reaching engine factories."""
    authorized = RemoteAuthorizedRetrievalResources(
        knowledge_base_id=1,
        index_owner_user_id=42,
        retriever=RemoteRetrievalResourceRef(
            kind="Retriever", name="test-retriever", namespace="default"
        ),
        embedding_model=RemoteRetrievalResourceRef(
            kind="Model", name="shared-embedding", namespace="search-team"
        ),
        explicit_selection=explicit_selection,
    )
    model = shared_model_db.get(Kind, 3)
    model.json = {"spec": {**model.json["spec"], "modelType": "llm"}}
    shared_model_db.commit()
    loader = RuntimeConfigLoader(session_factory=lambda: shared_model_db)
    if operation == "query":
        executor = QueryExecutor(config_loader=loader)
        request = RemoteQueryRequest(
            knowledge_base_ids=[1],
            user_id=42,
            query="release checklist",
            authorized_resources=[authorized],
        )
        execution_entry = "KnowledgeQueryExecutor"
    else:
        executor = IndexExecutor(config_loader=loader)
        request = RemoteIndexRequest(
            knowledge_base_id=1,
            user_id=42,
            document_id=100,
            content_ref=PresignedUrlContentRef(
                kind="presigned_url", url="https://example.com/document.pdf"
            ),
            authorized_resources=authorized,
        )
        execution_entry = "DocumentService"

    module = f"knowledge_runtime.services.{operation}_executor"
    with (
        patch(f"{module}.create_embedding_model_from_runtime_config") as model_factory,
        patch(
            f"{module}.create_storage_backend_from_runtime_config"
        ) as storage_factory,
        patch(f"{module}.{execution_entry}") as engine,
        pytest.raises(ConfigResolutionError) as exc_info,
    ):
        await executor.execute(request)

    assert exc_info.value.code == "config_invalid"
    model_factory.assert_not_called()
    storage_factory.assert_not_called()
    engine.assert_not_called()
