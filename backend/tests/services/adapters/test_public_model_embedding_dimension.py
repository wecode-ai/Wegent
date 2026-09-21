# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the embedding dimension contract on the public model API."""

from datetime import datetime
from typing import Any, Dict, Optional

import pytest
from sqlalchemy.orm import Session

from app.core.exceptions import ValidationException
from app.models.kind import Kind
from app.models.user import User
from app.schemas.model import ModelCreate, ModelUpdate
from app.services.adapters.public_model import public_model_service


def _config(
    *,
    model_type: Optional[str] = "embedding",
    dimensions: Any = 1536,
) -> Dict[str, Any]:
    config: Dict[str, Any] = {
        "env": {"model": "custom", "base_url": "https://example.com/v1"},
    }
    if model_type is not None:
        config["modelType"] = model_type
    if dimensions is not None:
        config["embeddingConfig"] = {"dimensions": dimensions}
    return config


def _stored_model(db: Session, name: str) -> Kind:
    return (
        db.query(Kind)
        .filter(Kind.user_id == 0, Kind.kind == "Model", Kind.name == name)
        .one()
    )


def _seed_legacy_embedding_model(db: Session, name: str) -> Kind:
    model = Kind(
        user_id=0,
        kind="Model",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "modelConfig": {"env": {"model": "custom"}},
                "modelType": "embedding",
            },
        },
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


def test_create_public_embedding_model_requires_dimension(
    test_db: Session,
    test_user: User,
) -> None:
    with pytest.raises(ValidationException, match="dimensions"):
        public_model_service.create_model(
            db=test_db,
            obj_in=ModelCreate(
                name="public-embedding-model",
                config=_config(dimensions=None),
            ),
            current_user=test_user,
        )


def test_create_public_embedding_model_hoists_the_declaration(
    test_db: Session,
    test_user: User,
) -> None:
    public_model_service.create_model(
        db=test_db,
        obj_in=ModelCreate(
            name="public-embedding-model",
            config=_config(),
        ),
        current_user=test_user,
    )

    spec = _stored_model(test_db, "public-embedding-model").json["spec"]
    assert spec["modelType"] == "embedding"
    assert spec["embeddingConfig"] == {"dimensions": 1536}
    assert "modelType" not in spec["modelConfig"]
    assert "embeddingConfig" not in spec["modelConfig"]


def test_update_public_embedding_model_cannot_change_dimension(
    test_db: Session,
    test_user: User,
) -> None:
    public_model_service.create_model(
        db=test_db,
        obj_in=ModelCreate(name="public-embedding-model", config=_config()),
        current_user=test_user,
    )
    model = _stored_model(test_db, "public-embedding-model")

    with pytest.raises(ValidationException, match="immutable"):
        public_model_service.update_model(
            db=test_db,
            model_id=model.id,
            obj_in=ModelUpdate(config=_config(dimensions=768)),
            current_user=test_user,
        )


def test_update_public_model_keeps_the_stored_category(
    test_db: Session,
    test_user: User,
) -> None:
    public_model_service.create_model(
        db=test_db,
        obj_in=ModelCreate(name="public-embedding-model", config=_config()),
        current_user=test_user,
    )
    model = _stored_model(test_db, "public-embedding-model")

    public_model_service.update_model(
        db=test_db,
        model_id=model.id,
        obj_in=ModelUpdate(config=_config(model_type=None)),
        current_user=test_user,
    )

    spec = _stored_model(test_db, "public-embedding-model").json["spec"]
    assert spec["modelType"] == "embedding"
    assert spec["embeddingConfig"] == {"dimensions": 1536}


def test_update_legacy_public_embedding_model_may_declare_its_dimension(
    test_db: Session,
    test_user: User,
) -> None:
    model = _seed_legacy_embedding_model(test_db, "legacy-public-model")

    public_model_service.update_model(
        db=test_db,
        model_id=model.id,
        obj_in=ModelUpdate(config=_config()),
        current_user=test_user,
    )

    spec = _stored_model(test_db, "legacy-public-model").json["spec"]
    assert spec["embeddingConfig"] == {"dimensions": 1536}
