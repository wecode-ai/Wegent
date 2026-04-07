# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public RAG compatibility routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.rag import (
    RetrieveRequest,
    RetrieveResponse,
)
from app.services.rag.gateway_factory import get_query_gateway
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import RemoteRagGatewayError
from app.services.rag.runtime_resolver import RagRuntimeResolver

router = APIRouter()
runtime_resolver = RagRuntimeResolver()


@router.post("/retrieve", response_model=RetrieveResponse)
async def retrieve_documents(
    request: RetrieveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Retrieve relevant document chunks.

    Supports two retrieval modes:
    - **vector**: Pure vector similarity search (default)
    - **hybrid**: Hybrid search combining vector similarity and BM25 keyword matching

    For hybrid mode, you can specify weights for vector and keyword components.
    Default weights are 0.7 for vector and 0.3 for keyword (must sum to 1.0).

    Args:
        request: Retrieval request with retriever_ref and embedding_model_ref
        db: Database session
        current_user: Current user

    Returns:
        Retrieval response with matching chunks

    Raises:
        HTTPException: If retrieval fails

    Example:
        ```json
        {
            "query": "How to use RAG?",
            "knowledge_id": "kb_001",
            "retriever_ref": {
                "name": "my-es-retriever",
                "namespace": "default"
            },
            "embedding_model_ref": {
                "name": "bge-m3",
                "namespace": "default"
            },
            "top_k": 5,
            "score_threshold": 0.7,
            "retrieval_mode": "hybrid",
            "hybrid_weights": {
                "vector_weight": 0.7,
                "keyword_weight": 0.3
            }
        }
        ```
    """
    try:
        knowledge_base_id = int(request.knowledge_id)
        runtime_spec = runtime_resolver.build_public_query_runtime_spec(
            db=db,
            knowledge_base_id=knowledge_base_id,
            query=request.query,
            max_results=request.top_k,
            retriever_name=request.retriever_ref.name,
            retriever_namespace=request.retriever_ref.namespace,
            embedding_model_name=request.embedding_model_ref.model_name,
            embedding_model_namespace=request.embedding_model_ref.model_namespace,
            user_id=current_user.id,
            user_name=current_user.user_name,
            score_threshold=request.score_threshold,
            retrieval_mode=request.retrieval_mode.value,
            vector_weight=(
                request.hybrid_weights.vector_weight
                if request.hybrid_weights is not None
                else None
            ),
            keyword_weight=(
                request.hybrid_weights.keyword_weight
                if request.hybrid_weights is not None
                else None
            ),
            metadata_condition=request.metadata_condition,
        )

        gateway = get_query_gateway()
        try:
            result = await gateway.query(runtime_spec, db=db)
        except RemoteRagGatewayError:
            result = await LocalRagGateway().query(runtime_spec, db=db)

        return {"records": result.get("records", [])}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
