# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression coverage for persisted Task model references."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.chat.config.model_resolver import _find_model_with_namespace


def _model_kind(
    *,
    user_id: int,
    name: str,
    namespace: str,
    provider_model_id: str,
) -> Kind:
    return Kind(
        user_id=user_id,
        kind="Model",
        name=name,
        namespace=namespace,
        json={
            "spec": {
                "modelConfig": {
                    "env": {
                        "model": "openai",
                        "model_id": provider_model_id,
                        "api_key": "test-key",
                        "base_url": "https://models.example.test/v1",
                    }
                }
            }
        },
        is_active=True,
    )


def test_exact_task_reference_does_not_select_same_named_private_model(
    test_db: Session, test_user: User
) -> None:
    """A public task reference must not be shadowed by a personal Model name."""
    public_model = _model_kind(
        user_id=0,
        name="same-name-model",
        namespace="default",
        provider_model_id="public-provider-model",
    )
    private_model = _model_kind(
        user_id=test_user.id,
        name="same-name-model",
        namespace="default",
        provider_model_id="private-provider-model",
    )
    test_db.add_all([public_model, private_model])
    test_db.commit()

    model_kind, model_spec = _find_model_with_namespace(
        test_db,
        "same-name-model",
        test_user.id,
        namespace="default",
        model_type="public",
    )

    assert model_kind is not None
    assert model_kind.id == public_model.id
    assert model_spec["modelConfig"]["env"]["model_id"] == "public-provider-model"


def test_incomplete_new_task_reference_does_not_fall_back_to_another_scope(
    test_db: Session, test_user: User
) -> None:
    """Persisted namespace without scope is rejected instead of silently guessing."""
    private_model = _model_kind(
        user_id=test_user.id,
        name="same-name-model",
        namespace="default",
        provider_model_id="private-provider-model",
    )
    test_db.add(private_model)
    test_db.commit()

    model_kind, model_spec = _find_model_with_namespace(
        test_db,
        "same-name-model",
        test_user.id,
        namespace="default",
        model_type=None,
    )

    assert model_kind is None
    assert model_spec is None


def test_exact_group_task_reference_uses_its_persisted_namespace(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    """Two accessible groups can expose a name without making the lookup ambiguous."""
    intended_model = _model_kind(
        user_id=101,
        name="same-name-model",
        namespace="team-platform",
        provider_model_id="team-platform-provider-model",
    )
    other_group_model = _model_kind(
        user_id=102,
        name="same-name-model",
        namespace="team-other",
        provider_model_id="team-other-provider-model",
    )
    test_db.add_all([intended_model, other_group_model])
    test_db.commit()
    monkeypatch.setattr(
        "app.services.group_permission.get_user_groups",
        lambda _db, _user_id: ["team-platform", "team-other"],
    )

    model_kind, model_spec = _find_model_with_namespace(
        test_db,
        "same-name-model",
        test_user.id,
        namespace="team-platform",
        model_type="group",
    )

    assert model_kind is not None
    assert model_kind.id == intended_model.id
    assert (
        model_spec["modelConfig"]["env"]["model_id"] == "team-platform-provider-model"
    )
