# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolution tests for the Wegent retrieval resource adapter."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.services.knowledge.retrieval_resource_resolver import (
    resolve_embedding_model_resource,
    resolve_retriever_resource,
)
from tests.utils.retrieval_resources import embedding_model_kind, model_kind
from tests.utils.retrieval_resources import retriever_kind as _retriever


def _group(db: Session, name: str, owner_user_id: int) -> Namespace:
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner_user_id,
        visibility="internal",
        level="group",
        is_active=True,
    )
    db.add(namespace)
    db.commit()
    db.refresh(namespace)
    return namespace


def _join_group(db: Session, group: Namespace, user: User, role: str = "Reporter"):
    db.add(
        ResourceMember.create(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="user",
            entity_id=str(user.id),
            role=role,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=group.owner_user_id,
        )
    )
    db.commit()


def test_resolves_the_callers_own_retriever(test_db: Session, test_user: User) -> None:
    test_db.add(_retriever(test_user.id, "mine"))
    test_db.commit()

    resolved = resolve_retriever_resource(
        test_db, user_id=test_user.id, name="mine", namespace="default"
    )

    assert resolved is not None
    assert resolved.kind == "Retriever"
    assert resolved.name == "mine"
    assert resolved.namespace == "default"


def test_falls_back_to_a_public_retriever(test_db: Session, test_user: User) -> None:
    test_db.add(_retriever(0, "public-retriever"))
    test_db.commit()

    resolved = resolve_retriever_resource(
        test_db, user_id=test_user.id, name="public-retriever", namespace="default"
    )

    assert resolved is not None
    assert resolved.name == "public-retriever"
    assert resolved.namespace == "default"


def test_group_reference_falls_back_to_the_public_retriever(
    test_db: Session, test_user: User
) -> None:
    """A group-scoped reference may legitimately resolve to the public one."""
    group = _group(test_db, "resolver-group", owner_user_id=test_user.id + 1000)
    _join_group(test_db, group, test_user)
    test_db.add(_retriever(0, "shared-retriever"))
    test_db.commit()

    resolved = resolve_retriever_resource(
        test_db, user_id=test_user.id, name="shared-retriever", namespace=group.name
    )

    assert resolved is not None
    assert resolved.name == "shared-retriever"
    assert resolved.namespace == "default"


def test_group_reference_outside_the_callers_groups_is_not_authorized(
    test_db: Session, test_user: User
) -> None:
    foreign = _group(test_db, "foreign-group", owner_user_id=test_user.id + 1000)
    test_db.add(_retriever(test_user.id + 1000, "shared-retriever", foreign.name))
    test_db.commit()

    assert (
        resolve_retriever_resource(
            test_db,
            user_id=test_user.id,
            name="shared-retriever",
            namespace=foreign.name,
        )
        is None
    )


def test_missing_retriever_is_not_resolved(test_db: Session, test_user: User) -> None:
    assert (
        resolve_retriever_resource(
            test_db, user_id=test_user.id, name="missing", namespace="default"
        )
        is None
    )


def test_reports_the_models_real_category(test_db: Session, test_user: User) -> None:
    test_db.add(model_kind(test_user.id, "my-embedding", "embedding"))
    test_db.add(model_kind(test_user.id, "my-chat", "llm"))
    test_db.commit()

    embedding = resolve_embedding_model_resource(
        test_db, user_id=test_user.id, name="my-embedding", namespace="default"
    )
    chat = resolve_embedding_model_resource(
        test_db, user_id=test_user.id, name="my-chat", namespace="default"
    )

    assert embedding is not None
    assert embedding.kind == "Model"
    assert embedding.category == "embedding"
    assert chat is not None
    assert chat.category == "llm"


def test_resolves_a_public_embeddingmodel_kind(
    test_db: Session, test_user: User
) -> None:
    test_db.add(model_kind(0, "public-embedding", "embedding"))
    test_db.commit()

    resolved = resolve_embedding_model_resource(
        test_db, user_id=test_user.id, name="public-embedding", namespace="default"
    )

    assert resolved is not None
    assert resolved.category == "embedding"


def test_missing_embedding_model_is_not_resolved(
    test_db: Session, test_user: User
) -> None:
    assert (
        resolve_embedding_model_resource(
            test_db, user_id=test_user.id, name="missing", namespace="default"
        )
        is None
    )
