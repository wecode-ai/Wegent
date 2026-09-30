# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The public index-management entries keep the owner's retriever access.

Skipping the execution configuration for the remote data plane must not skip the
access verdict that comes with the retriever lookup: a knowledge base owner who
is not in the retriever's group must be refused before any remote request.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.rag.runtime_resolver import RagRuntimeResolver
from tests.utils.retrieval_resources import retriever_kind

GROUP_NAMESPACE = "retriever-owners"


def _knowledge_base(
    db: Session,
    *,
    owner_user_id: int,
    namespace: str,
    retriever_owner_id: int,
) -> Kind:
    kb = Kind(
        user_id=owner_user_id,
        kind="KnowledgeBase",
        name=f"admin-kb-{namespace}",
        namespace="default",
        json={
            "spec": {
                "name": f"admin-kb-{namespace}",
                "retrievalConfig": {
                    "retriever_name": f"retriever-{namespace}",
                    "retriever_namespace": namespace,
                    "embedding_config": {
                        "model_name": f"embed-{namespace}",
                        "model_namespace": namespace,
                    },
                },
            }
        },
        is_active=True,
    )
    db.add(kb)
    db.add(retriever_kind(retriever_owner_id, f"retriever-{namespace}", namespace))
    db.commit()
    db.refresh(kb)
    return kb


def _build_spec(resolver: RagRuntimeResolver, db: Session, spec_type: str, kb_id: int):
    """Build one public admin spec the way the remote gateway does."""

    kwargs = {
        "db": db,
        "knowledge_base_id": kb_id,
        "user_id": 1,
        "user_name": "owner",
        "resolve_execution_configs": False,
    }
    if spec_type == "chunks":
        return resolver.build_public_list_chunks_runtime_spec(
            max_chunks=500, query="list_index_chunks", **kwargs
        )
    if spec_type == "purge":
        return resolver.build_public_purge_index_runtime_spec(**kwargs)
    return resolver.build_public_drop_index_runtime_spec(**kwargs)


@pytest.mark.parametrize("spec_type", ["chunks", "purge", "drop"])
def test_admin_entries_refuse_an_owner_outside_the_retriever_group(
    test_db: Session,
    test_user: User,
    spec_type: str,
) -> None:
    """An owner removed from the retriever's group cannot reach the index."""

    kb = _knowledge_base(
        test_db,
        owner_user_id=test_user.id,
        namespace=GROUP_NAMESPACE,
        retriever_owner_id=test_user.id + 100,
    )

    with pytest.raises(HTTPException) as exc_info:
        _build_spec(RagRuntimeResolver(), test_db, spec_type, kb.id)

    assert exc_info.value.status_code == 403


@pytest.mark.parametrize("spec_type", ["chunks", "purge", "drop"])
def test_admin_entries_keep_serving_an_authorized_owner(
    test_db: Session,
    test_user: User,
    spec_type: str,
) -> None:
    """An owner who may use the retriever still gets a config-free remote spec."""

    kb = _knowledge_base(
        test_db,
        owner_user_id=test_user.id,
        namespace="default",
        retriever_owner_id=test_user.id,
    )

    spec = _build_spec(RagRuntimeResolver(), test_db, spec_type, kb.id)

    assert spec.retriever_config is None
    assert spec.index_owner_user_id == test_user.id
