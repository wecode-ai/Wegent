from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.rag.local_data_plane.administration import test_connection_local
from app.services.rag.local_data_plane.indexing import (
    delete_document_index_local,
    drop_knowledge_index_local,
    index_document_local,
    purge_knowledge_index_local,
)
from app.services.rag.local_data_plane.retrieval import list_chunks_local, query_local
from app.services.rag.runtime_specs import (
    ConnectionTestRuntimeSpec,
    DeleteRuntimeSpec,
    DropKnowledgeIndexRuntimeSpec,
    IndexRuntimeSpec,
    ListChunksRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
    QueryRuntimeSpec,
)


class LocalDataPlaneDisabledError(RuntimeError):
    """A remote-configured operation reached the deprecated local data plane.

    Operations resolved to ``remote`` must execute in ``knowledge_runtime`` or
    fail. Reaching this gateway means the caller fell back to local storage,
    which would read or write a different data plane, so the call stops before
    any storage access instead of silently serving the wrong index.
    """

    def __init__(self, operation: str) -> None:
        super().__init__(
            f"Local data plane is disabled for '{operation}' because it is "
            "configured to run remote"
        )
        self.operation = operation


class LocalRagGateway:
    # The local data plane builds storage and embedding clients from the
    # resolved configuration, so the spec must carry it.
    requires_resolved_configs = True

    def __init__(self) -> None:
        self._index_executor = index_document_local
        self._delete_executor = delete_document_index_local
        self._purge_executor = purge_knowledge_index_local
        self._drop_executor = drop_knowledge_index_local
        self._retrieval_executor = query_local
        self._list_chunks_executor = list_chunks_local
        self._connection_test_executor = test_connection_local

    @staticmethod
    def _reject_remote_operation(operation: str) -> None:
        """Refuse an operation that this deployment configured to run remote."""

        if settings.get_rag_runtime_mode(operation) == "remote":
            raise LocalDataPlaneDisabledError(operation)

    async def index_document(
        self,
        spec: IndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        self._reject_remote_operation("index")
        return await self._index_executor(spec, db=db)

    async def query(
        self,
        spec: QueryRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        # Only standard retrieval runs remote; auto and direct injection keep
        # their existing local routing.
        if getattr(spec, "route_mode", "auto") == "rag_retrieval":
            self._reject_remote_operation("query")
        if db is None:
            raise ValueError("db is required for LocalRagGateway.query")
        return await self._retrieval_executor(spec, db=db)

    async def delete_document_index(
        self,
        spec: DeleteRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict:
        self._reject_remote_operation("delete")
        return await self._delete_executor(spec, db=db)

    async def purge_knowledge_index(
        self,
        spec: PurgeKnowledgeRuntimeSpec,
        *,
        db: Session,
    ) -> dict:
        return await self._purge_executor(spec, db=db)

    async def drop_knowledge_index(
        self,
        spec: DropKnowledgeIndexRuntimeSpec,
        *,
        db: Session,
    ) -> dict:
        return await self._drop_executor(spec, db=db)

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
