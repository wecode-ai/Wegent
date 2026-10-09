# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolution tests for the Wegent retrieval resource adapter."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.user import User
from app.services.knowledge.retrieval_resource_resolver import (
    resolve_embedding_model_resource,
    resolve_retriever_resource,
)
from tests.utils.namespace_members import add_group_member, group_namespace
from tests.utils.retrieval_resources import embedding_model_kind, model_kind
from tests.utils.retrieval_resources import retriever_kind as _retriever


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
    group = group_namespace(
        test_db, "resolver-group", owner_user_id=test_user.id + 1000
    )
    add_group_member(test_db, group, test_user)
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
    foreign = group_namespace(
        test_db, "foreign-group", owner_user_id=test_user.id + 1000
    )
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


def test_resolves_a_public_embedding_model(test_db: Session, test_user: User) -> None:
    test_db.add(model_kind(0, "public-embedding", "embedding"))
    test_db.commit()

    resolved = resolve_embedding_model_resource(
        test_db, user_id=test_user.id, name="public-embedding", namespace="default"
    )

    assert resolved is not None
    assert resolved.category == "embedding"


def test_group_embedding_model_is_not_authorized_for_non_members(
    test_db: Session, test_user: User
) -> None:
    """A group model is only usable by members of the namespace that owns it."""
    group = group_namespace(
        test_db, "embedded-group", owner_user_id=test_user.id + 1000
    )
    test_db.add(
        model_kind(test_user.id + 1000, "group-embedding", "embedding", group.name)
    )
    test_db.commit()

    assert (
        resolve_embedding_model_resource(
            test_db,
            user_id=test_user.id,
            name="group-embedding",
            namespace=group.name,
        )
        is None
    )


def test_group_embedding_model_is_authorized_for_group_members(
    test_db: Session, test_user: User
) -> None:
    group = group_namespace(test_db, "member-group", owner_user_id=test_user.id + 1000)
    add_group_member(test_db, group, test_user)
    test_db.add(
        model_kind(test_user.id + 1000, "group-embedding", "embedding", group.name)
    )
    test_db.commit()

    resolved = resolve_embedding_model_resource(
        test_db,
        user_id=test_user.id,
        name="group-embedding",
        namespace=group.name,
    )

    assert resolved is not None
    assert resolved.category == "embedding"
    assert resolved.namespace == group.name


def test_missing_embedding_model_is_not_resolved(
    test_db: Session, test_user: User
) -> None:
    assert (
        resolve_embedding_model_resource(
            test_db, user_id=test_user.id, name="missing", namespace="default"
        )
        is None
    )


def test_approved_model_uses_receiver_scope_without_source_membership(
    test_db: Session, test_user: User
) -> None:
    from app.models.resource_member import ResourceMember

    source = group_namespace(test_db, "model-source", owner_user_id=test_user.id + 1000)
    model = embedding_model_kind(test_user.id + 1000, "shared-embedding", source.name)
    test_db.add(model)
    test_db.flush()
    grant = ResourceMember.create(
        resource_type="Model",
        resource_id=model.id,
        entity_type="user",
        entity_id=str(test_user.id),
        status="approved",
    )
    test_db.add(grant)
    test_db.commit()

    resolved = resolve_embedding_model_resource(
        test_db, user_id=test_user.id, name=model.name, namespace="default"
    )
    assert resolved is not None
    assert resolved.namespace == "default"
    assert resolved.category == "embedding"

    grant.status = "rejected"
    test_db.commit()
    assert (
        resolve_embedding_model_resource(
            test_db, user_id=test_user.id, name=model.name, namespace="default"
        )
        is None
    )
