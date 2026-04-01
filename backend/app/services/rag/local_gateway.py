from sqlalchemy.orm import Session

from app.services.rag.local_data_plane.indexing import index_document_local
from app.services.rag.local_data_plane.retrieval import query_local
from app.services.rag.runtime_specs import IndexRuntimeSpec, QueryRuntimeSpec


class LocalRagGateway:
    def __init__(self) -> None:
        self._index_executor = index_document_local
        self._retrieval_executor = query_local

    async def index_document(
        self,
        spec: IndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        if db is None:
            return await self._index_executor(spec)
        return await self._index_executor(spec, db=db)

    async def query(
        self,
        spec: QueryRuntimeSpec,
        *,
        db: Session | None = None,
        user_subtask_id: int | None = None,
    ) -> dict:
        if db is None and user_subtask_id is None:
            return await self._retrieval_executor(spec)
        return await self._retrieval_executor(
            spec,
            db=db,
            user_subtask_id=user_subtask_id,
        )
