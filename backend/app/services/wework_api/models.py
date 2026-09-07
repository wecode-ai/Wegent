# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve model identities from the same authorized catalog as Wework."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.runtime_work import RuntimeModelSelection
from app.schemas.wework_api import WeworkResponseCreate
from app.services import runtime_work_service as runtime
from app.services.model_aggregation_service import model_aggregation_service


def catalog(db: Session, user: User) -> list[dict]:
    return model_aggregation_service.list_available_models(
        db=db,
        current_user=user,
        scope="all",
        include_config=False,
        shell_type="Codex",
        model_category_type="llm",
        client_origin="wework",
    )


def model_identifier(model: dict) -> str:
    return ":".join(
        str(model.get(key, ""))
        for key in ("type", "namespace", "resourceUserId", "name")
    )


def list_models(db: Session, user: User) -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": model_identifier(model),
                "object": "model",
                "created": 0,
                "owned_by": model["type"],
                "name": model["name"],
            }
            for model in catalog(db, user)
        ],
    }


def selection(
    db: Session, user: User, body: WeworkResponseCreate
) -> RuntimeModelSelection:
    matches = [
        model
        for model in catalog(db, user)
        if body.model in {model_identifier(model), model["name"]}
        and (
            not body.wework_options.model_type
            or model["type"] == body.wework_options.model_type
        )
    ]
    if len(matches) != 1:
        raise HTTPException(
            422, "Model unavailable or ambiguous; use an id from GET /models"
        )
    model = matches[0]
    options = dict(body.wework_options.model_options)
    options[runtime.CLOUD_MODEL_NAMESPACE_OPTION] = model.get("namespace", "default")
    options[runtime.CLOUD_MODEL_RESOURCE_USER_ID_OPTION] = model.get(
        "resourceUserId", 0
    )
    return RuntimeModelSelection(
        modelName=model["name"], modelType=model["type"], options=options
    )
