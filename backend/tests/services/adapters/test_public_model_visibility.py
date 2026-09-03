# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.adapters.public_model import (
    is_public_model_visible,
    public_model_service,
)
from app.services.chat.config.model_resolver import _find_model_with_namespace
from app.services.model_aggregation_service import ModelType, model_aggregation_service


def _public_model(name: str, *, is_visible: bool | None = None) -> Kind:
    spec = {
        "modelConfig": {
            "env": {
                "model": "openai",
                "model_id": name,
            }
        }
    }
    if is_visible is not None:
        spec["isVisible"] = is_visible
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


def test_public_model_visibility_defaults_to_true() -> None:
    model = _public_model("legacy-public-model")

    assert is_public_model_visible(model.json) is True


def test_hidden_public_model_is_not_listed_but_remains_runtime_resolvable(
    test_db: Session,
    test_user: User,
) -> None:
    visible_model = _public_model("visible-public-model", is_visible=True)
    hidden_model = _public_model("hidden-public-model", is_visible=False)
    test_db.add_all([visible_model, hidden_model])
    test_db.commit()

    listed_models = public_model_service.get_models(
        db=test_db,
        current_user=test_user,
        skip=0,
        limit=100,
    )

    assert {model["name"] for model in listed_models} == {"visible-public-model"}
    assert (
        public_model_service.count_active_models(
            db=test_db,
            current_user=test_user,
        )
        == 1
    )

    resolved_model, resolved_spec = _find_model_with_namespace(
        test_db,
        "hidden-public-model",
        test_user.id,
    )

    assert resolved_model is not None
    assert resolved_model.id == hidden_model.id
    assert resolved_spec is not None
    assert resolved_spec["modelConfig"]["env"]["model_id"] == "hidden-public-model"

    aggregated_model = model_aggregation_service.get_model_by_name_and_type(
        test_db,
        test_user,
        "hidden-public-model",
        ModelType.PUBLIC,
    )

    assert aggregated_model is not None
    assert aggregated_model["name"] == "hidden-public-model"


def test_hidden_public_model_outside_listing_limit_remains_resolvable(
    test_db: Session,
    test_user: User,
) -> None:
    hidden_model = _public_model("older-hidden-public-model", is_visible=False)
    hidden_model.created_at = datetime(2025, 1, 1)
    newer_models = [
        _public_model(f"newer-public-model-{index}", is_visible=True)
        for index in range(1000)
    ]
    for model in newer_models:
        model.created_at = datetime(2026, 1, 1)
    test_db.add_all([hidden_model, *newer_models])
    test_db.commit()

    capped_models = public_model_service.get_models(
        db=test_db,
        current_user=test_user,
        skip=0,
        limit=1000,
        include_hidden=True,
    )
    assert hidden_model.name not in {model["name"] for model in capped_models}

    aggregated_model = model_aggregation_service.get_model_by_name_and_type(
        test_db,
        test_user,
        hidden_model.name,
        ModelType.PUBLIC,
    )

    assert aggregated_model is not None
    assert aggregated_model["name"] == hidden_model.name
