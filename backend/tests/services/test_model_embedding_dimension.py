# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the embedding dimension contract declared by Model resources."""

from datetime import datetime
from typing import Any, Dict, Optional

import pytest
from pytest_mock import MockerFixture
from sqlalchemy.orm import Session

from app.core.exceptions import ValidationException
from app.models.kind import Kind
from app.models.user import User
from app.services.kind_impl import ModelKindService


class _SessionProxy:
    """Let a service use the test session without closing it."""

    def __init__(self, session: Session):
        self._session = session

    def __enter__(self) -> Session:
        return self._session

    def __exit__(self, *exc_info: Any) -> bool:
        return False


def _model_resource(
    *,
    name: str = "embedding-model",
    model_type: Optional[str] = "embedding",
    dimensions: Any = 1024,
) -> Dict[str, Any]:
    spec: Dict[str, Any] = {
        "modelConfig": {"env": {"model": "custom", "base_url": "https://x/v1"}},
    }
    if model_type is not None:
        spec["modelType"] = model_type
    if dimensions is not None:
        spec["embeddingConfig"] = {"dimensions": dimensions}
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Model",
        "metadata": {"name": name, "namespace": "default"},
        "spec": spec,
    }


@pytest.fixture
def model_service(mocker: MockerFixture, test_db: Session) -> ModelKindService:
    service = ModelKindService()
    mocker.patch.object(service, "get_db", return_value=_SessionProxy(test_db))
    return service


def _seed_legacy_model(test_db: Session, test_user: User, name: str) -> None:
    """Store an embedding model the way versions before the contract did."""
    resource = _model_resource(name=name, dimensions=None)
    test_db.add(
        Kind(
            user_id=test_user.id,
            kind="Model",
            name=name,
            namespace="default",
            json=resource,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
    )
    test_db.commit()


def test_create_embedding_model_requires_declared_dimension(
    model_service: ModelKindService,
    test_user: User,
) -> None:
    with pytest.raises(ValidationException, match="dimensions"):
        model_service.create_resource(
            test_user.id,
            _model_resource(name="legacy-model", dimensions=None),
        )


@pytest.mark.parametrize("dimensions", [0, -1, -1024])
def test_create_embedding_model_rejects_non_positive_dimension(
    model_service: ModelKindService,
    test_user: User,
    dimensions: int,
) -> None:
    with pytest.raises(ValidationException, match="dimensions"):
        model_service.create_resource(
            test_user.id,
            _model_resource(name=f"bad-model-{dimensions}", dimensions=dimensions),
        )


def test_create_embedding_model_accepts_declared_dimension(
    model_service: ModelKindService,
    test_user: User,
) -> None:
    resource_id = model_service.create_resource(
        test_user.id,
        _model_resource(name="good-model", dimensions=1536),
    )

    assert resource_id > 0


def test_create_llm_model_does_not_require_dimension(
    model_service: ModelKindService,
    test_user: User,
) -> None:
    resource_id = model_service.create_resource(
        test_user.id,
        _model_resource(name="llm-model", model_type="llm", dimensions=None),
    )

    assert resource_id > 0


def test_create_legacy_format_embedding_model_requires_dimension(
    model_service: ModelKindService,
    test_user: User,
) -> None:
    resource = _model_resource(name="nested-model", dimensions=None)
    resource["spec"].pop("modelType")
    resource["spec"]["modelConfig"]["modelType"] = "embedding"

    with pytest.raises(ValidationException, match="dimensions"):
        model_service.create_resource(test_user.id, resource)


def test_update_legacy_embedding_model_may_declare_its_dimension(
    model_service: ModelKindService,
    test_user: User,
    test_db: Session,
) -> None:
    _seed_legacy_model(test_db, test_user, "legacy-model")

    model_service.update_resource(
        test_user.id,
        "default",
        "legacy-model",
        _model_resource(name="legacy-model", dimensions=1024),
    )

    assert (
        _read_model_spec(model_service, test_user, "legacy-model")["embeddingConfig"][
            "dimensions"
        ]
        == 1024
    )


def test_update_embedding_model_cannot_change_dimension(
    model_service: ModelKindService,
    test_user: User,
) -> None:
    model_service.create_resource(
        test_user.id,
        _model_resource(name="stable-model", dimensions=1024),
    )

    with pytest.raises(ValidationException, match="immutable"):
        model_service.update_resource(
            test_user.id,
            "default",
            "stable-model",
            _model_resource(name="stable-model", dimensions=768),
        )


def test_update_embedding_model_allows_the_same_dimension(
    model_service: ModelKindService,
    test_user: User,
) -> None:
    model_service.create_resource(
        test_user.id,
        _model_resource(name="stable-model", dimensions=1024),
    )

    model_service.update_resource(
        test_user.id,
        "default",
        "stable-model",
        _model_resource(name="stable-model", dimensions=1024),
    )

    assert (
        _read_model_spec(model_service, test_user, "stable-model")["embeddingConfig"][
            "dimensions"
        ]
        == 1024
    )


def test_update_embedding_model_cannot_drop_dimension(
    model_service: ModelKindService,
    test_user: User,
) -> None:
    model_service.create_resource(
        test_user.id,
        _model_resource(name="stable-model", dimensions=1024),
    )

    with pytest.raises(ValidationException, match="dimensions"):
        model_service.update_resource(
            test_user.id,
            "default",
            "stable-model",
            _model_resource(name="stable-model", dimensions=None),
        )


@pytest.mark.parametrize("model_type", [None, "llm"])
def test_update_cannot_silence_the_contract_by_omitting_the_model_type(
    model_service: ModelKindService,
    test_user: User,
    model_type: Optional[str],
) -> None:
    model_service.create_resource(
        test_user.id,
        _model_resource(name="stable-model", dimensions=1024),
    )
    update = _model_resource(
        name="stable-model",
        model_type=model_type,
        dimensions=None,
    )

    with pytest.raises(ValidationException, match="dimensions"):
        model_service.update_resource(
            test_user.id,
            "default",
            "stable-model",
            update,
        )


def _read_model_spec(
    model_service: ModelKindService,
    test_user: User,
    name: str,
) -> Dict[str, Any]:
    stored = model_service.get_resource(test_user.id, "default", name)
    assert stored is not None
    return stored.json["spec"]
