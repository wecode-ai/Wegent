from typing import Protocol

from sqlalchemy.orm import Session

from app.services.rag.runtime_specs import (
    ConnectionTestRuntimeSpec,
    DeleteRuntimeSpec,
    IndexRuntimeSpec,
    ListChunksRuntimeSpec,
    QueryRuntimeSpec,
)


class RagGateway(Protocol):
    async def index_document(
        self,
        spec: IndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict: ...

    async def query(
        self,
        spec: QueryRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict: ...

    async def delete_document_index(
        self,
        spec: DeleteRuntimeSpec,
        *,
        db: Session,
    ) -> dict: ...

    async def list_chunks(
        self,
        spec: ListChunksRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict: ...

    async def test_connection(
        self,
        spec: ConnectionTestRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict: ...
