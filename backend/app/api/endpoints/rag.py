# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public RAG compatibility routes."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.bounded_executor import BoundedExecutorOverloaded
from app.core.payload_codec import run_payload_codec
from app.core.security import DetachedUser, get_detached_current_user
from app.schemas.rag import (
    RagChunkListResponse,
    RagChunkRecord,
    RetrieveRequest,
    RetrieveResponse,
)
from app.services.knowledge.web_db import run_knowledge_db_phase
from app.services.rag.gateway_factory import get_delete_gateway, get_query_gateway
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import (
    RemoteRagGatewayError,
    should_fallback_to_local,
)
from app.services.rag.runtime_resolver import RagRuntimeResolver

router = APIRouter()
runtime_resolver = RagRuntimeResolver()
INDEX_CHUNK_LIST_MAX_CHUNKS = 10000


def _map_public_admin_value_error(error: ValueError) -> HTTPException:
    detail = str(error)
    if "Physical index drop is only allowed" in detail:
        return HTTPException(status_code=409, detail=detail)
    return HTTPException(status_code=400, detail=detail)


def _build_public_query_spec(
    db: Session,
    request: RetrieveRequest,
    user_id: int,
    user_name: str,
):
    return runtime_resolver.build_public_query_runtime_spec(
        db=db,
        knowledge_base_id=int(request.knowledge_id),
        query=request.query,
        search_hints=request.search_hints,
        max_results=request.top_k,
        retriever_name=request.retriever_ref.name,
        retriever_namespace=request.retriever_ref.namespace,
        embedding_model_name=request.embedding_model_ref.model_name,
        embedding_model_namespace=request.embedding_model_ref.model_namespace,
        user_id=user_id,
        user_name=user_name,
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


def _build_public_list_spec(
    db: Session,
    knowledge_id: int,
    user_id: int,
    user_name: str,
):
    return runtime_resolver.build_public_list_chunks_runtime_spec(
        db=db,
        knowledge_base_id=knowledge_id,
        user_id=user_id,
        user_name=user_name,
        max_chunks=INDEX_CHUNK_LIST_MAX_CHUNKS,
        query="list_index_chunks",
    )


def _build_public_purge_spec(
    db: Session,
    knowledge_id: int,
    user_id: int,
    user_name: str,
):
    return runtime_resolver.build_public_purge_index_runtime_spec(
        db=db,
        knowledge_base_id=knowledge_id,
        user_id=user_id,
        user_name=user_name,
    )


def _build_public_drop_spec(
    db: Session,
    knowledge_id: int,
    user_id: int,
    user_name: str,
):
    return runtime_resolver.build_public_drop_index_runtime_spec(
        db=db,
        knowledge_base_id=knowledge_id,
        user_id=user_id,
        user_name=user_name,
    )


def _build_chunk_list_response(
    result: dict,
    page: int,
    page_size: int,
) -> RagChunkListResponse:
    chunks = result.get("chunks", [])
    start = (page - 1) * page_size
    page_items = chunks[start : start + page_size]
    return RagChunkListResponse(
        items=[
            RagChunkRecord(
                content=chunk.get("content", ""),
                title=chunk.get("title", "Unknown"),
                chunk_id=chunk.get("chunk_id"),
                doc_ref=chunk.get("doc_ref"),
                metadata=chunk.get("metadata"),
            )
            for chunk in page_items
        ],
        total=result.get("total", len(chunks)),
        page=page,
        page_size=page_size,
    )


@router.post("/retrieve", response_model=RetrieveResponse)
async def retrieve_documents(
    request: RetrieveRequest,
    current_user: DetachedUser = Depends(get_detached_current_user),
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
            "score_threshold": 0.5,
            "retrieval_mode": "hybrid",
            "hybrid_weights": {
                "vector_weight": 0.7,
                "keyword_weight": 0.3
            }
        }
        ```
    """
    try:
        runtime_spec = await run_knowledge_db_phase(
            _build_public_query_spec,
            request,
            current_user.id,
            current_user.user_name,
        )

        gateway = get_query_gateway()
        try:
            result = await gateway.query(runtime_spec)
        except RemoteRagGatewayError as exc:
            if not should_fallback_to_local(exc):
                raise
            result = await LocalRagGateway().query(runtime_spec)

        return {"records": result.get("records", [])}
    except HTTPException:
        raise
    except BoundedExecutorOverloaded:
        raise
    except RemoteRagGatewayError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/chunks", response_model=RagChunkListResponse)
async def list_index_chunks(
    knowledge_id: int = Query(..., description="Knowledge base ID"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=500, description="Page size"),
    current_user: DetachedUser = Depends(get_detached_current_user),
):
    """List indexed chunks stored for a knowledge base."""
    try:
        start = (page - 1) * page_size
        if start + page_size > INDEX_CHUNK_LIST_MAX_CHUNKS:
            raise ValueError(
                "Requested page exceeds the chunk scan limit of "
                f"{INDEX_CHUNK_LIST_MAX_CHUNKS}"
            )

        runtime_spec = await run_knowledge_db_phase(
            _build_public_list_spec,
            knowledge_id,
            current_user.id,
            current_user.user_name,
        )
        gateway = get_query_gateway()
        try:
            result = await gateway.list_chunks(runtime_spec)
        except RemoteRagGatewayError as exc:
            if not should_fallback_to_local(exc):
                raise
            result = await LocalRagGateway().list_chunks(runtime_spec)

        return await run_payload_codec(
            _build_chunk_list_response,
            result,
            page,
            page_size,
            payload_hint=result,
            force_offload=True,
        )
    except HTTPException:
        raise
    except BoundedExecutorOverloaded:
        raise
    except RemoteRagGatewayError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.delete("/index-contents")
async def purge_index_contents(
    knowledge_id: int = Query(..., description="Knowledge base ID"),
    current_user: DetachedUser = Depends(get_detached_current_user),
):
    """Delete all indexed chunks stored for a knowledge base while keeping documents."""
    try:
        runtime_spec = await run_knowledge_db_phase(
            _build_public_purge_spec,
            knowledge_id,
            current_user.id,
            current_user.user_name,
        )
        gateway = get_delete_gateway()
        try:
            return await gateway.purge_knowledge_index(runtime_spec)
        except RemoteRagGatewayError as exc:
            if not should_fallback_to_local(exc):
                raise
            return await LocalRagGateway().purge_knowledge_index(runtime_spec)
    except HTTPException:
        raise
    except BoundedExecutorOverloaded:
        raise
    except RemoteRagGatewayError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e)) from e
    except ValueError as e:
        raise _map_public_admin_value_error(e) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.delete("/index")
async def drop_index(
    knowledge_id: int = Query(..., description="Knowledge base ID"),
    current_user: DetachedUser = Depends(get_detached_current_user),
):
    """Physically drop the dedicated index/collection for a knowledge base."""
    try:
        runtime_spec = await run_knowledge_db_phase(
            _build_public_drop_spec,
            knowledge_id,
            current_user.id,
            current_user.user_name,
        )
        gateway = get_delete_gateway()
        try:
            return await gateway.drop_knowledge_index(runtime_spec)
        except RemoteRagGatewayError as exc:
            if not should_fallback_to_local(exc):
                raise
            return await LocalRagGateway().drop_knowledge_index(runtime_spec)
    except HTTPException:
        raise
    except BoundedExecutorOverloaded:
        raise
    except RemoteRagGatewayError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e)) from e
    except ValueError as e:
        raise _map_public_admin_value_error(e) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
