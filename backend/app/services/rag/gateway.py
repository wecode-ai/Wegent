from typing import Protocol

from sqlalchemy.orm import Session

from app.services.rag.runtime_specs import (
    DeleteRuntimeSpec,
    IndexRuntimeSpec,
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
