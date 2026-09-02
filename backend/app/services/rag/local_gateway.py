from sqlalchemy.orm import Session

from app.services.knowledge.web_db import run_knowledge_db_phase
from app.services.rag.local_data_plane.administration import test_connection_local
from app.services.rag.local_data_plane.indexing import (
    delete_document_index_local,
    drop_knowledge_index_local,
    index_document_local,
    purge_knowledge_index_local,
)
from app.services.rag.local_data_plane.retrieval import list_chunks_local
from app.services.rag.retrieval_service import PreparedRetrievalPlan, RetrievalService
from app.services.rag.runtime_specs import (
    ConnectionTestRuntimeSpec,
    DeleteRuntimeSpec,
    DropKnowledgeIndexRuntimeSpec,
    IndexRuntimeSpec,
    ListChunksRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
    QueryRuntimeSpec,
)


def _prepare_query_with_worker_session(
    db: Session,
    spec: QueryRuntimeSpec,
) -> PreparedRetrievalPlan:
    """Prepare local retrieval inputs in the bounded DB executor."""

    return RetrievalService().prepare_local_retrieval(spec, db)


class LocalRagGateway:
    def __init__(self) -> None:
        self._index_executor = index_document_local
        self._delete_executor = delete_document_index_local
        self._purge_executor = purge_knowledge_index_local
        self._drop_executor = drop_knowledge_index_local
        self._list_chunks_executor = list_chunks_local
        self._connection_test_executor = test_connection_local

    async def index_document(
        self,
        spec: IndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        return await self._index_executor(spec, db=db)

    async def query(
        self,
        spec: QueryRuntimeSpec,
    ) -> dict:
        plan = await run_knowledge_db_phase(
            _prepare_query_with_worker_session,
            spec,
        )
        return await RetrievalService().execute_prepared_local_retrieval(plan)

    async def delete_document_index(
        self,
        spec: DeleteRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        return await self._delete_executor(spec, db=db)

    async def purge_knowledge_index(
        self,
        spec: PurgeKnowledgeRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        return await self._purge_executor(spec, db=db)

    async def drop_knowledge_index(
        self,
        spec: DropKnowledgeIndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        return await self._drop_executor(spec, db=db)

    async def list_chunks(
        self,
        spec: ListChunksRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        return await self._list_chunks_executor(spec, db=db)

    async def test_connection(
        self,
        spec: ConnectionTestRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        return await self._connection_test_executor(spec, db=db)
