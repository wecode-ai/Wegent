from sqlalchemy.orm import Session

from app.services.rag.local_data_plane.indexing import (
    delete_document_index_local,
    index_document_local,
)
from app.services.rag.local_data_plane.retrieval import query_local
from app.services.rag.runtime_specs import IndexRuntimeSpec, QueryRuntimeSpec


class LocalRagGateway:
    def __init__(self) -> None:
        self._index_executor = index_document_local
        self._delete_executor = delete_document_index_local
        self._retrieval_executor = query_local

    async def index_document(
        self,
        spec: IndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        if db is None:
            raise ValueError("db is required for LocalRagGateway.index_document")
        return await self._index_executor(spec, db=db)

    async def query(
        self,
        spec: QueryRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        if db is None:
            raise ValueError("db is required for LocalRagGateway.query")
        return await self._retrieval_executor(spec, db=db)

    async def delete_document_index(
        self,
        knowledge_base_id: int,
        document_ref: str,
        *,
        db: Session,
        index_owner_user_id: int | None = None,
    ) -> dict:
        return await self._delete_executor(
            knowledge_base_id=knowledge_base_id,
            document_ref=document_ref,
            db=db,
            index_owner_user_id=index_owner_user_id,
        )
