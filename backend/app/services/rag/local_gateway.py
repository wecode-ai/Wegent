from sqlalchemy.orm import Session

from app.services.rag.local_data_plane.administration import test_connection_local
from app.services.rag.local_data_plane.indexing import (
    delete_document_index_local,
    index_document_local,
)
from app.services.rag.local_data_plane.retrieval import list_chunks_local, query_local
from app.services.rag.runtime_specs import (
    ConnectionTestRuntimeSpec,
    DeleteRuntimeSpec,
    IndexRuntimeSpec,
    ListChunksRuntimeSpec,
    QueryRuntimeSpec,
)


class LocalRagGateway:
    def __init__(self) -> None:
        self._index_executor = index_document_local
        self._delete_executor = delete_document_index_local
        self._retrieval_executor = query_local
        self._list_chunks_executor = list_chunks_local
        self._connection_test_executor = test_connection_local

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
        spec: DeleteRuntimeSpec,
        *,
        db: Session,
    ) -> dict:
        return await self._delete_executor(spec, db=db)

    async def list_chunks(
        self,
        spec: ListChunksRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        if db is None:
            raise ValueError("db is required for LocalRagGateway.list_chunks")
        return await self._list_chunks_executor(spec, db=db)

    async def test_connection(
        self,
        spec: ConnectionTestRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        return await self._connection_test_executor(spec, db=db)
