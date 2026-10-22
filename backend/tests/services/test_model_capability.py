# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import ModelSpec
from app.services.model_aggregation_service import (
    ModelType,
    model_aggregation_service,
)
from app.utils.model_capability import get_model_capability_description

CAPABILITY = "响应快，适合日常问答和简单任务。Fast responses for everyday tasks."


@pytest.mark.parametrize(
    "capability",
    [None, "", CAPABILITY, {"description": CAPABILITY, "publishStatus": "published"}],
)
def test_model_capability_is_optional(
    capability: str | dict[str, object] | None,
) -> None:
    payload = {"modelConfig": {"env": {"model_id": "upstream-model"}}}
    if capability is not None:
        payload["capability"] = capability

    spec = ModelSpec.model_validate(payload)

    assert spec.capability == capability
    assert spec.model_dump()["capability"] == capability


@pytest.mark.parametrize("capability", [123, True, ["text"]])
def test_model_capability_rejects_unsupported_values(capability: object) -> None:
    with pytest.raises(ValidationError, match="capability"):
        ModelSpec.model_validate({"modelConfig": {}, "capability": capability})


@pytest.mark.parametrize(
    "model_type", [ModelType.USER, ModelType.GROUP, ModelType.PUBLIC]
)
@pytest.mark.parametrize(
    "capability",
    [None, CAPABILITY, {"description": CAPABILITY, "publishStatus": "published"}],
)
def test_model_capability_reaches_catalog_and_details(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    model_type: ModelType,
    capability: str | dict[str, object] | None,
) -> None:
    namespace = "capability-group" if model_type == ModelType.GROUP else "default"
    spec = {
        "modelConfig": {"env": {"model": "openai", "model_id": "upstream-model"}},
        "capability": capability,
    }
    model = Kind(
        user_id=0 if model_type == ModelType.PUBLIC else test_user.id,
        kind="Model",
        name="capability-model",
        namespace=namespace,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": "capability-model", "namespace": namespace},
            "spec": spec,
        },
    )
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(
        "app.services.group_permission.get_user_groups",
        lambda db, user_id: ["capability-group"],
    )

    def get_test_resource(
        *, user_id: int, kind: str, namespace: str, name: str
    ) -> Kind | None:
        return (
            test_db.query(Kind)
            .filter_by(user_id=user_id, kind=kind, namespace=namespace, name=name)
            .first()
        )

    monkeypatch.setattr(
        "app.services.model_aggregation_service.kind_service.get_resource",
        get_test_resource,
    )
    monkeypatch.setattr(
        "app.services.model_aggregation_service.get_referenced_capability",
        lambda db, **kwargs: get_test_resource(**kwargs),
    )

    catalog = model_aggregation_service.list_available_models(
        db=test_db,
        current_user=test_user,
        scope="all",
        client_origin="frontend",
    )
    details = model_aggregation_service.get_model_by_name_and_type(
        db=test_db,
        current_user=test_user,
        name=model.name,
        model_type=model_type,
    )

    entry = next(item for item in catalog if item["name"] == model.name)
    assert entry["type"] == model_type.value
    assert entry["namespace"] == namespace
    assert entry["capability"] == get_model_capability_description(capability)
    assert entry["modelId"] == "upstream-model"
    assert details is not None
    assert details["capability"] == get_model_capability_description(capability)
