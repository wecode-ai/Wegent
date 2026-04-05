# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends

from knowledge_runtime.security import verify_internal_service_token
from knowledge_runtime.services.handlers import runtime_handlers
from shared.models.knowledge_runtime_protocol import (
    RemoteDeleteDocumentIndexRequest,
    RemoteIndexRequest,
    RemoteQueryRequest,
    RemoteQueryResponse,
)

router = APIRouter(prefix="/internal/rag", tags=["internal-rag"])


@router.post("/index")
async def index_document(
    request: RemoteIndexRequest,
    _: None = Depends(verify_internal_service_token),
) -> dict:
    return await runtime_handlers.index_document(request)


@router.post("/query", response_model=RemoteQueryResponse)
async def query(
    request: RemoteQueryRequest,
    _: None = Depends(verify_internal_service_token),
) -> RemoteQueryResponse:
    return await runtime_handlers.query(request)


@router.post("/delete-document-index")
async def delete_document_index(
    request: RemoteDeleteDocumentIndexRequest,
    _: None = Depends(verify_internal_service_token),
) -> dict:
    return await runtime_handlers.delete_document_index(request)
