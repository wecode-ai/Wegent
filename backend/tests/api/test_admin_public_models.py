# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.endpoints.admin.public_models import (
    create_public_model,
    update_public_model,
)
from app.models.user import User
from app.schemas.admin import PublicModelCreate, PublicModelUpdate


def _model_json(name: str) -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Model",
        "metadata": {"name": name, "namespace": "default"},
        "spec": {
            "modelConfig": {
                "env": {
                    "model": "openai",
                    "model_id": name,
                }
            }
        },
        "status": {"state": "Available"},
    }


def test_public_model_schema_rejects_non_object_spec() -> None:
    with pytest.raises(ValidationError, match="spec must be an object"):
        PublicModelCreate(
            name="invalid-spec-public-model",
            json={"kind": "Model", "spec": "invalid"},
        )


def test_public_model_schema_uses_model_validation_and_preserves_extensions() -> None:
    model_json = _model_json("validated-public-model")
    model_json["spec"]["futureSpecOption"] = {"enabled": False}
    model_json["spec"]["videoConfig"] = {"futureVideoOption": "kept"}

    validated = PublicModelCreate(
        name="validated-public-model",
        json=model_json,
    ).model_json

    assert validated["spec"]["futureSpecOption"] == {"enabled": False}
    assert validated["spec"]["videoConfig"]["futureVideoOption"] == "kept"


def test_public_model_schema_rejects_known_invalid_fields_and_unsafe_keys() -> None:
    invalid_type = _model_json("invalid-public-model")
    invalid_type["spec"]["modelType"] = "tts"
    invalid_type["spec"]["ttsConfig"] = {"speed": 9}
    with pytest.raises(ValidationError, match="less than or equal to 4"):
        PublicModelCreate(name="invalid-public-model", json=invalid_type)

    unsafe = _model_json("unsafe-public-model")
    unsafe["spec"]["modelConfig"]["env"]["nested"] = {"prototype": True}
    with pytest.raises(ValidationError, match="unsafe key names"):
        PublicModelUpdate(json=unsafe)


@pytest.mark.asyncio
async def test_public_model_create_defaults_to_visible(
    test_db: Session,
    test_admin_user: User,
) -> None:
    response = await create_public_model(
        model_data=PublicModelCreate(
            name="default-visible-public-model",
            json=_model_json("default-visible-public-model"),
        ),
        db=test_db,
        current_user=test_admin_user,
    )

    assert response.is_visible is True
    assert response.model_json["spec"]["isVisible"] is True


@pytest.mark.asyncio
async def test_public_model_visibility_can_be_disabled_without_deactivation(
    test_db: Session,
    test_admin_user: User,
) -> None:
    created = await create_public_model(
        model_data=PublicModelCreate(
            name="hidden-public-model",
            json=_model_json("hidden-public-model"),
        ),
        db=test_db,
        current_user=test_admin_user,
    )

    response = await update_public_model(
        model_data=PublicModelUpdate(is_visible=False),
        model_id=created.id,
        db=test_db,
        current_user=test_admin_user,
    )

    assert response.is_active is True
    assert response.is_visible is False
    assert response.model_json["spec"]["isVisible"] is False


@pytest.mark.asyncio
async def test_public_model_config_update_preserves_hidden_state(
    test_db: Session,
    test_admin_user: User,
) -> None:
    created = await create_public_model(
        model_data=PublicModelCreate(
            name="hidden-config-update-model",
            json=_model_json("hidden-config-update-model"),
            is_visible=False,
        ),
        db=test_db,
        current_user=test_admin_user,
    )
    updated_json = _model_json("hidden-config-update-model")
    updated_json["spec"]["modelConfig"]["temperature"] = 0.2

    response = await update_public_model(
        model_data=PublicModelUpdate(json=updated_json),
        model_id=created.id,
        db=test_db,
        current_user=test_admin_user,
    )

    assert response.is_visible is False
    assert response.model_json["spec"]["isVisible"] is False
    assert response.model_json["spec"]["modelConfig"]["temperature"] == 0.2


@pytest.mark.asyncio
async def test_public_model_json_visibility_is_authoritative(
    test_db: Session,
    test_admin_user: User,
) -> None:
    created = await create_public_model(
        model_data=PublicModelCreate(
            name="json-visibility-model",
            json=_model_json("json-visibility-model"),
        ),
        db=test_db,
        current_user=test_admin_user,
    )
    updated_json = _model_json("json-visibility-model")
    updated_json["spec"]["isVisible"] = False

    response = await update_public_model(
        model_data=PublicModelUpdate(json=updated_json),
        model_id=created.id,
        db=test_db,
        current_user=test_admin_user,
    )

    assert response.is_visible is False
    assert response.model_json["spec"]["isVisible"] is False
