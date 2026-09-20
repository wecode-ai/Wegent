# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deleting a knowledge base must not leave its index behind in storage.

``per_dataset`` gives every knowledge base its own collection, so deleting the
knowledge base must drop that collection. Clearing its rows is not the same
thing: the empty collection stays in Milvus and the product promised the
knowledge base leaves no residue.

Shared strategies (``per_user`` / ``fixed`` / ``rolling``) keep one collection
for several knowledge bases, so deleting one knowledge base may only clear its
own rows and must keep the collection for the others.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, DocumentStatus, KnowledgeDocument
from app.models.user import User
from app.services.rag.runtime_resolver import RagRuntimeResolver

KNOWLEDGE_BASE_URL = "/api/knowledge-bases"
DOCUMENT_URL = "/api/knowledge-documents"


class RecordingMilvus:
    """In-memory stand-in for a Milvus deployment.

    Collections hold ``(knowledge base, document)`` rows. Rows are what
    ``delete_document`` and ``delete_knowledge`` remove; a collection only goes
    away through ``drop_knowledge_index``.
    """

    def __init__(self, *, collection_name: Callable[[str], str]) -> None:
        self._collection_name = collection_name
        self.collections: dict[str, set[tuple[str, str]]] = {}

    def index_rows(self, *, knowledge_id: str, doc_ref: str) -> None:
        collection = self._collection_name(knowledge_id)
        self.collections.setdefault(collection, set()).add((knowledge_id, doc_ref))

    def existing_collections(self) -> list[str]:
        return sorted(self.collections)

    def rows_of(self, knowledge_id: str) -> set[tuple[str, str]]:
        collection = self._collection_name(knowledge_id)
        return {
            row
            for row in self.collections.get(collection, set())
            if row[0] == knowledge_id
        }

    # -- storage surface used by the local data plane ----------------------

    def delete_document(
        self, knowledge_id: str, doc_ref: str, **kwargs: Any
    ) -> dict[str, Any]:
        rows = self.rows_of(knowledge_id)
        removed = len(rows & {(knowledge_id, doc_ref)})
        self.collections[self._collection_name(knowledge_id)] = self.collections.get(
            self._collection_name(knowledge_id), set()
        ) - {(knowledge_id, doc_ref)}
        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "deleted_chunks": removed,
            "status": "deleted",
        }

    def delete_knowledge(self, knowledge_id: str, **kwargs: Any) -> dict[str, Any]:
        removed = 0
        for collection, rows in self.collections.items():
            removed += len([row for row in rows if row[0] == knowledge_id])
            self.collections[collection] = {
                row for row in rows if row[0] != knowledge_id
            }
        return {
            "knowledge_id": knowledge_id,
            "deleted_chunks": removed,
            "deleted_parent_nodes": 0,
            "status": "deleted",
        }

    def drop_knowledge_index(self, knowledge_id: str, **kwargs: Any) -> dict[str, Any]:
        collection = self._collection_name(knowledge_id)
        self.collections.pop(collection, None)
        return {
            "knowledge_id": knowledge_id,
            "collection_name": collection,
            "dropped_parent_collection": False,
            "status": "dropped",
        }


class RemoteRuntimeHttpClient:
    """Stands in for knowledge_runtime's HTTP API.

    The remote protocol is reference mode: the gateway sends only the knowledge
    base id and its owner, so the runtime resolves the retriever from the
    database itself. This client repeats that resolution, which is what makes
    the runtime fail once the knowledge base record is gone.
    """

    def __init__(self, *, db: Session, storage: RecordingMilvus) -> None:
        self._db = db
        self._storage = storage

    async def __aenter__(self) -> "RemoteRuntimeHttpClient":
        return self

    async def __aexit__(self, *exc_info: Any) -> bool:
        return False

    async def post(
        self, url: str, *, json: dict[str, Any], headers: Any = None
    ) -> httpx.Response:
        path = str(url)
        resolver = RagRuntimeResolver()
        try:
            if path.endswith("/internal/rag/delete-document-index"):
                return httpx.Response(
                    200,
                    json=self._storage.delete_document(
                        str(json["knowledge_base_id"]), json["document_ref"]
                    ),
                )
            if path.endswith("/internal/rag/drop-knowledge-index"):
                spec = resolver.build_public_drop_index_runtime_spec(
                    db=self._db,
                    knowledge_base_id=json["knowledge_base_id"],
                    user_id=json["user_id"],
                    user_name=None,
                )
                return httpx.Response(
                    200,
                    json=self._storage.drop_knowledge_index(
                        str(spec.knowledge_base_id)
                    ),
                )
            if path.endswith("/internal/rag/purge-knowledge-index"):
                spec = resolver.build_public_purge_index_runtime_spec(
                    db=self._db,
                    knowledge_base_id=json["knowledge_base_id"],
                    user_id=json["user_id"],
                    user_name=None,
                )
                return httpx.Response(
                    200,
                    json=self._storage.delete_knowledge(str(spec.knowledge_base_id)),
                )
        except Exception as exc:
            # The runtime answers a failed resolution with an error body, so the
            # gateway raises and the caller has to cope with a skipped cleanup.
            return httpx.Response(
                400,
                json={"code": "config_not_found", "message": str(exc)},
            )

        raise AssertionError(f"unexpected runtime call: {path}")


def _patch_remote_runtime(db: Session, storage: RecordingMilvus):
    namespace = SimpleNamespace(
        AsyncClient=lambda **kwargs: RemoteRuntimeHttpClient(db=db, storage=storage),
        RequestError=httpx.RequestError,
        Response=httpx.Response,
    )
    return patch("app.services.rag.remote_gateway.httpx", namespace)


def _create_knowledge_base(db: Session, user: User, *, retriever_name: str) -> Kind:
    name = f"kb-{user.id}-default-{retriever_name}"
    knowledge_base = Kind(
        user_id=user.id,
        kind="KnowledgeBase",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "name": f"Milvus cleanup {retriever_name}",
                "retrievalConfig": {
                    "retriever_name": retriever_name,
                    "retriever_namespace": "default",
                },
            },
        },
        is_active=True,
    )
    db.add(knowledge_base)
    db.commit()
    db.refresh(knowledge_base)
    return knowledge_base


def _create_retriever(db: Session, user: User, *, name: str, index_mode: str) -> Kind:
    retriever = Kind(
        user_id=user.id,
        kind="Retriever",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Retriever",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "storageConfig": {
                    "type": "milvus",
                    "url": "http://milvus:19530",
                    "indexStrategy": {"mode": index_mode, "prefix": "wegent"},
                }
            },
        },
        is_active=True,
    )
    db.add(retriever)
    db.commit()
    db.refresh(retriever)
    return retriever


def _create_indexed_document(
    db: Session, user: User, *, knowledge_base: Kind
) -> KnowledgeDocument:
    document = KnowledgeDocument(
        kind_id=knowledge_base.id,
        attachment_id=0,
        name="release-checklist",
        file_extension="md",
        file_size=128,
        status=DocumentStatus.ENABLED,
        user_id=user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


@pytest.fixture
def auth_headers(test_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_token}"}


def _patch_storage(storage: RecordingMilvus):
    return patch(
        "app.services.rag.local_data_plane.indexing."
        "create_storage_backend_from_runtime_config",
        return_value=storage,
    )


def test_deleting_knowledge_base_drops_its_per_dataset_collection(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", "local")
    retriever_name = "milvus-per-dataset"
    _create_retriever(test_db, test_user, name=retriever_name, index_mode="per_dataset")
    knowledge_base = _create_knowledge_base(
        test_db, test_user, retriever_name=retriever_name
    )
    document = _create_indexed_document(
        test_db, test_user, knowledge_base=knowledge_base
    )
    storage = RecordingMilvus(
        collection_name=lambda knowledge_id: f"wegent_kb_{knowledge_id}"
    )
    storage.index_rows(knowledge_id=str(knowledge_base.id), doc_ref=str(document.id))

    with _patch_storage(storage):
        deleted_document = test_client.delete(
            f"{DOCUMENT_URL}/{document.id}", headers=auth_headers
        )
        assert deleted_document.status_code == 204
        assert storage.rows_of(str(knowledge_base.id)) == set()
        assert storage.existing_collections() == [f"wegent_kb_{knowledge_base.id}"]

        deleted_knowledge_base = test_client.delete(
            f"{KNOWLEDGE_BASE_URL}/{knowledge_base.id}", headers=auth_headers
        )
        assert deleted_knowledge_base.status_code == 204

    assert storage.existing_collections() == []


def test_deleting_knowledge_base_keeps_collection_shared_with_other_bases(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", "local")
    retriever_name = "milvus-per-user"
    _create_retriever(test_db, test_user, name=retriever_name, index_mode="per_user")
    knowledge_base = _create_knowledge_base(
        test_db, test_user, retriever_name=retriever_name
    )
    document = _create_indexed_document(
        test_db, test_user, knowledge_base=knowledge_base
    )
    other_knowledge_base = _create_knowledge_base(
        test_db, test_user, retriever_name=retriever_name
    )
    storage = RecordingMilvus(collection_name=lambda knowledge_id: "wegent_user_1")
    storage.index_rows(knowledge_id=str(knowledge_base.id), doc_ref=str(document.id))
    storage.index_rows(knowledge_id=str(other_knowledge_base.id), doc_ref="999")

    with _patch_storage(storage):
        assert (
            test_client.delete(
                f"{DOCUMENT_URL}/{document.id}", headers=auth_headers
            ).status_code
            == 204
        )
        assert (
            test_client.delete(
                f"{KNOWLEDGE_BASE_URL}/{knowledge_base.id}", headers=auth_headers
            ).status_code
            == 204
        )

    assert storage.existing_collections() == ["wegent_user_1"]
    assert storage.rows_of(str(other_knowledge_base.id)) == {
        (str(other_knowledge_base.id), "999")
    }


def test_deleting_knowledge_base_in_remote_mode_drops_its_collection(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", "remote")
    retriever_name = "milvus-remote-per-dataset"
    _create_retriever(test_db, test_user, name=retriever_name, index_mode="per_dataset")
    knowledge_base = _create_knowledge_base(
        test_db, test_user, retriever_name=retriever_name
    )
    document = _create_indexed_document(
        test_db, test_user, knowledge_base=knowledge_base
    )
    storage = RecordingMilvus(
        collection_name=lambda knowledge_id: f"wegent_kb_{knowledge_id}"
    )
    storage.index_rows(knowledge_id=str(knowledge_base.id), doc_ref=str(document.id))

    with _patch_remote_runtime(test_db, storage):
        assert (
            test_client.delete(
                f"{DOCUMENT_URL}/{document.id}", headers=auth_headers
            ).status_code
            == 204
        )
        assert (
            test_client.delete(
                f"{KNOWLEDGE_BASE_URL}/{knowledge_base.id}", headers=auth_headers
            ).status_code
            == 204
        )

    assert storage.existing_collections() == []
