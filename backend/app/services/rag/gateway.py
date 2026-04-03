from typing import Protocol

from sqlalchemy.orm import Session

from app.services.rag.runtime_specs import IndexRuntimeSpec, QueryRuntimeSpec


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
        knowledge_base_id: int,
        document_ref: str,
        *,
        db: Session,
        index_owner_user_id: int | None = None,
    ) -> dict: ...
