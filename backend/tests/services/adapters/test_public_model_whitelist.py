# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.user import User
from app.services.adapters.public_model import (
    get_public_model_allowed_users,
    is_public_model_allowed_for_user,
    public_model_service,
)
from app.services.chat.config.model_resolver import _find_model_with_namespace
from app.services.model_aggregation_service import ModelType, model_aggregation_service


def _public_model(name: str, *, allowed_users: list[str] | None = None) -> Kind:
    spec = {
        "modelConfig": {
            "env": {
                "model": "openai",
                "model_id": name,
            }
        }
    }
    if allowed_users is not None:
        spec["allowedUsers"] = allowed_users
    return Kind(
        user_id=0,
        kind="Model",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": "default"},
            "spec": spec,
            "status": {"state": "Available"},
        },
        is_active=True,
    )


def _make_user(db: Session, user_name: str) -> User:
    user = User(
        user_name=user_name,
        password_hash=get_password_hash(f"{user_name}-password"),
        email=f"{user_name}@example.com",
        is_active=True,
        git_info=None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_allowed_users_default_to_empty() -> None:
    model = _public_model("open-model")

    assert get_public_model_allowed_users(model.json) == []
    assert is_public_model_allowed_for_user(model.json, "anyone") is True
    assert is_public_model_allowed_for_user(model.json, None) is True


def test_allowed_users_membership() -> None:
    model = _public_model("restricted-model", allowed_users=["alice", " bob ", 7])

    assert get_public_model_allowed_users(model.json) == ["alice", "bob"]
    assert is_public_model_allowed_for_user(model.json, "alice") is True
    assert is_public_model_allowed_for_user(model.json, "carol") is False
    assert is_public_model_allowed_for_user(model.json, None) is False


def test_whitelisted_public_model_is_hidden_from_other_users(
    test_db: Session,
    test_user: User,
) -> None:
    open_model = _public_model("open-public-model")
    restricted_model = _public_model("restricted-public-model", allowed_users=["alice"])
    test_db.add_all([open_model, restricted_model])
    test_db.commit()

    listed_models = public_model_service.get_models(
        db=test_db,
        current_user=test_user,
        skip=0,
        limit=100,
    )

    assert {model["name"] for model in listed_models} == {"open-public-model"}
    assert (
        public_model_service.count_active_models(
            db=test_db,
            current_user=test_user,
        )
        == 1
    )

    alice = _make_user(test_db, "alice")
    alice_models = public_model_service.get_models(
        db=test_db,
        current_user=alice,
        skip=0,
        limit=100,
    )
    assert {model["name"] for model in alice_models} == {
        "open-public-model",
        "restricted-public-model",
    }


def test_whitelisted_public_model_is_not_runtime_resolvable_for_other_users(
    test_db: Session,
    test_user: User,
) -> None:
    restricted_model = _public_model(
        "restricted-runtime-model", allowed_users=["alice"]
    )
    test_db.add(restricted_model)
    test_db.commit()

    with pytest.raises(ValueError, match="restricted to whitelisted users"):
        _find_model_with_namespace(
            test_db,
            "restricted-runtime-model",
            test_user.id,
        )

    alice = _make_user(test_db, "alice")
    resolved_model, resolved_spec = _find_model_with_namespace(
        test_db,
        "restricted-runtime-model",
        alice.id,
    )

    assert resolved_model is not None
    assert resolved_model.id == restricted_model.id
    assert resolved_spec["modelConfig"]["env"]["model_id"] == (
        "restricted-runtime-model"
    )


def test_whitelisted_public_model_aggregate_resolve_forbidden_for_other_users(
    test_db: Session,
    test_user: User,
) -> None:
    restricted_model = _public_model(
        "restricted-aggregate-model", allowed_users=["alice"]
    )
    test_db.add(restricted_model)
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        model_aggregation_service.get_model_by_name_and_type(
            test_db,
            test_user,
            "restricted-aggregate-model",
            ModelType.PUBLIC,
        )
    assert exc_info.value.status_code == 403

    alice = _make_user(test_db, "alice")
    aggregated_model = model_aggregation_service.get_model_by_name_and_type(
        test_db,
        alice,
        "restricted-aggregate-model",
        ModelType.PUBLIC,
    )

    assert aggregated_model is not None
    assert aggregated_model["name"] == "restricted-aggregate-model"
