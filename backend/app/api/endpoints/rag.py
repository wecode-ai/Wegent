# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
RAG API routes.
Refactored to use Retriever CRD configuration instead of global config.
"""

import json
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.rag import (
    DocumentDeleteResponse,
    DocumentDetailResponse,
    DocumentListResponse,
    DocumentUploadResponse,
    RetrieveRequest,
    RetrieveResponse,
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SplitterConfig,
)
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.rag.document_service import DocumentService
from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.storage.factory import create_storage_backend

router = APIRouter()


def get_retriever_and_backend(
    retriever_name: str, retriever_namespace: str, user_id: int, db: Session
):
    """
    Get Retriever CRD and create storage backend.

    Args:
        retriever_name: Retriever name
        retriever_namespace: Retriever namespace
        user_id: User ID
        db: Database session

    Returns:
        Tuple of (Retriever CRD, storage backend)

    Raises:
        HTTPException: If retriever not found or access denied
    """
    # Get Retriever CRD
    retriever = retriever_kinds_service.get_retriever(
        db, user_id=user_id, name=retriever_name, namespace=retriever_namespace
    )

    # Create storage backend from Retriever config
    storage_backend = create_storage_backend(retriever)

    return retriever, storage_backend


@router.post("/documents/upload", response_model=DocumentUploadResponse)
async def upload_document(
    knowledge_id: str = Form(...),
    retriever_name: str = Form(...),
    retriever_namespace: str = Form(default="default"),
    file: UploadFile = File(...),
    embedding_model_name: str = Form(...),
    embedding_model_namespace: str = Form(default="default"),
    splitter_config: Optional[str] = Form(
        None,
        description="JSON string of splitter configuration. Example: "
        '{"type": "sentence", "chunk_size": 1024, "chunk_overlap": 200, "separator": "\\n\\n"}',
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Upload and index a document.

    Args:
        knowledge_id: Knowledge base ID
        retriever_name: Retriever name
        retriever_namespace: Retriever namespace (default: "default")
        file: Document file (MD/PDF/TXT/DOCX/code)
        embedding_model_name: Embedding model name
        embedding_model_namespace: Embedding model namespace (default: "default")
        splitter_config: Optional JSON string of splitter configuration.
                        If not provided, defaults to semantic splitter.
                        Examples:
                        - Semantic: {"type": "semantic", "buffer_size": 1, "breakpoint_percentile_threshold": 95}
                        - Sentence: {"type": "sentence", "chunk_size": 1024, "chunk_overlap": 200, "separator": "\\n\\n"}
        db: Database session
        current_user: Current user

    Returns:
        Document upload response

    Raises:
        HTTPException: If upload or indexing fails
    """
    try:
        # Parse splitter config if provided
        parsed_splitter_config: Optional[SplitterConfig] = None
        if splitter_config:
            try:
                config_dict = json.loads(splitter_config)
                config_type = config_dict.get("type", "semantic")

                if config_type == "semantic":
                    parsed_splitter_config = SemanticSplitterConfig(**config_dict)
                elif config_type == "sentence":
                    parsed_splitter_config = SentenceSplitterConfig(**config_dict)
                else:
                    raise ValueError(f"Unknown splitter type: {config_type}")
            except (json.JSONDecodeError, ValidationError) as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid splitter_config JSON: {str(e)}",
                ) from e

        # Get retriever and create backend
        _, storage_backend = get_retriever_and_backend(
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            user_id=current_user.id,
            db=db,
        )

        # Create document service
        doc_service = DocumentService(storage_backend=storage_backend)

        # Save to temp file
        with tempfile.NamedTemporaryFile(
            delete=False, suffix=Path(file.filename).suffix
        ) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        try:
            # Index document (pass user_id for per_user index strategy and splitter config)
            result = await doc_service.index_document(
                knowledge_id=knowledge_id,
                file_path=tmp_path,
                embedding_model_name=embedding_model_name,
                embedding_model_namespace=embedding_model_namespace,
                user_id=current_user.id,
                db=db,
                splitter_config=parsed_splitter_config,
            )
            return result
        finally:
            # Cleanup temp file
            Path(tmp_path).unlink(missing_ok=True)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
        # Get retriever and create backend
        _, storage_backend = get_retriever_and_backend(
            retriever_name=request.retriever_ref.name,
            retriever_namespace=request.retriever_ref.namespace,
            user_id=current_user.id,
            db=db,
        )

        # Create retrieval service
        retrieval_service = RetrievalService(storage_backend=storage_backend)

        # Prepare retrieval parameters (pass user_id for per_user index strategy)
        retrieval_params = {
            "query": request.query,
            "knowledge_id": request.knowledge_id,
            "embedding_model_name": request.embedding_model_ref.name,
            "embedding_model_namespace": request.embedding_model_ref.namespace,
            "user_id": current_user.id,
            "db": db,
            "top_k": request.top_k,
            "score_threshold": request.score_threshold,
            "retrieval_mode": request.retrieval_mode.value,
            "metadata_condition": request.metadata_condition,
        }

        # Add hybrid weights if in hybrid mode
        if request.retrieval_mode.value == "hybrid" and request.hybrid_weights:
            retrieval_params["vector_weight"] = request.hybrid_weights.vector_weight
            retrieval_params["keyword_weight"] = request.hybrid_weights.keyword_weight

        result = await retrieval_service.retrieve(**retrieval_params)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/documents/{doc_ref}", response_model=DocumentDeleteResponse)
async def delete_document(
    doc_ref: str,
    knowledge_id: str = Query(...),
    retriever_name: str = Query(...),
    retriever_namespace: str = Query(default="default"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Delete a document.

    Args:
        doc_ref: Document reference ID
        knowledge_id: Knowledge base ID
        retriever_name: Retriever name
        retriever_namespace: Retriever namespace (default: "default")
        db: Database session
        current_user: Current user

    Returns:
        Deletion result

    Raises:
        HTTPException: If deletion fails
    """
    try:
        # Get retriever and create backend
        _, storage_backend = get_retriever_and_backend(
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            user_id=current_user.id,
            db=db,
        )

        # Create document service
        doc_service = DocumentService(storage_backend=storage_backend)

        result = await doc_service.delete_document(
            knowledge_id=knowledge_id, doc_ref=doc_ref, user_id=current_user.id
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/documents", response_model=DocumentListResponse)
async def list_documents(
    knowledge_id: str = Query(...),
    retriever_name: str = Query(...),
    retriever_namespace: str = Query(default="default"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List documents in knowledge base with pagination.

    Args:
        knowledge_id: Knowledge base ID
        retriever_name: Retriever name
        retriever_namespace: Retriever namespace (default: "default")
        page: Page number (1-indexed)
        page_size: Number of documents per page
        db: Database session
        current_user: Current user

    Returns:
        Document list

    Raises:
        HTTPException: If listing fails
    """
    try:
        # Get retriever and create backend
        _, storage_backend = get_retriever_and_backend(
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            user_id=current_user.id,
            db=db,
        )

        # Create document service
        doc_service = DocumentService(storage_backend=storage_backend)

        result = await doc_service.list_documents(
            knowledge_id=knowledge_id,
            page=page,
            page_size=page_size,
            user_id=current_user.id,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/test-connection")
async def test_retriever_connection(
    retriever_name: str = Query(...),
    retriever_namespace: str = Query(default="default"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Test connection to retriever storage backend.

    Args:
        retriever_name: Retriever name
        retriever_namespace: Retriever namespace (default: "default")
        db: Database session
        current_user: Current user

    Returns:
        Connection test result

    Raises:
        HTTPException: If test fails
    """
    try:
        # Get retriever and create backend
        _, storage_backend = get_retriever_and_backend(
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            user_id=current_user.id,
            db=db,
        )

        # Test connection
        success = storage_backend.test_connection()

        return {
            "success": success,
            "message": "Connection successful" if success else "Connection failed",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
