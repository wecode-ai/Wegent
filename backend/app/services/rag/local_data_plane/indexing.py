# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.rag.document_service import DocumentService
from app.services.rag.runtime_specs import IndexRuntimeSpec
from app.services.rag.storage.factory import create_storage_backend


async def index_document_local(
    spec: IndexRuntimeSpec,
    *,
    db: Session | None = None,
) -> dict:
    if db is None:
        raise ValueError("db is required for local indexing execution")

    retriever = retriever_kinds_service.get_retriever(
        db=db,
        user_id=spec.index_owner_user_id,
        name=spec.retriever_name,
        namespace=spec.retriever_namespace,
    )
    storage_backend = create_storage_backend(retriever)
    service = DocumentService(storage_backend=storage_backend)

    splitter_config = spec.splitter_config
    if splitter_config:
        from app.services.knowledge.indexing import parse_splitter_config

        splitter_config = parse_splitter_config(splitter_config)

    file_path = (
        spec.source.file_path if spec.source.source_type == "file_path" else None
    )
    attachment_id = (
        spec.source.attachment_id if spec.source.source_type == "attachment" else None
    )
    return await service.index_document(
        knowledge_id=str(spec.knowledge_base_id),
        embedding_model_name=spec.embedding_model_name,
        embedding_model_namespace=spec.embedding_model_namespace,
        user_id=spec.index_owner_user_id,
        db=db,
        file_path=file_path,
        attachment_id=attachment_id,
        splitter_config=splitter_config,
        document_id=spec.document_id,
        user_name=spec.user_name,
    )
