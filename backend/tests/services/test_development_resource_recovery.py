"""Historical development data must not fail model or Workspace discovery."""

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.kind_impl import ModelKindService
from app.services.workspaces.lifecycle import WorkspaceLifecycleService
from shared.utils.crypto import CryptoConfigurationError


def test_model_list_survives_a_credential_configuration_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resources = [
        Kind(
            name=name,
            namespace="default",
            json={"spec": {"modelConfig": {"env": {"api_key": "stored-ciphertext"}}}},
        )
        for name in ("first-model", "second-model")
    ]

    def unavailable_credentials(value: str) -> str:
        raise CryptoConfigurationError("Invalid development credential configuration")

    monkeypatch.setattr(
        "app.services.kind_impl.decrypt_api_key", unavailable_credentials
    )
    service = ModelKindService()

    models = [service._format_resource(resource) for resource in resources]

    assert [model["metadata"]["name"] for model in models] == [
        "first-model",
        "second-model",
    ]
    assert all(
        model["spec"]["modelConfig"]["env"]["api_key"] == "stored-ciphertext"
        for model in models
    )


def test_workspace_list_orders_legacy_null_timestamps(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspaces = [
        Kind(
            kind="CollaborationWorkspace",
            name=name,
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={"spec": {"isDefault": name == "default"}},
        )
        for name in ("default", "legacy", "recent")
    ]
    test_db.add_all(workspaces)
    test_db.flush()
    test_db.query(Kind).filter(Kind.id.in_([row.id for row in workspaces[:2]])).update(
        {"created_at": None, "updated_at": None}, synchronize_session=False
    )
    workspaces[2].updated_at = datetime(2026, 10, 14)
    test_db.commit()
    test_db.expire_all()
    monkeypatch.setattr(
        "app.services.workspaces.lifecycle.readable_workspace_ids",
        lambda user_id: [row.id for row in workspaces],
    )

    result = WorkspaceLifecycleService().list_accessible(test_db, test_user.id)

    assert [workspace.name for workspace in result] == ["default", "recent", "legacy"]
    assert result[0].updated_at is None
    assert result[-1].updated_at is None
