# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authorization tests for public model write endpoints."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _seed_public_model(db: Session, name: str) -> Kind:
    model = Kind(
        user_id=0,
        kind="Model",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"modelConfig": {"env": {"model": "openai"}}},
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


def test_public_model_writes_require_admin(
    test_client,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    model = _seed_public_model(test_db, "auth-guarded-model")
    create_payload = {"name": "unauthorized-model", "config": {"env": {}}}
    update_payload = {"config": {"env": {"base_url": "https://attacker.example/v1"}}}

    assert (
        test_client.post(
            "/api/models", json=create_payload, headers=_headers(test_token)
        ).status_code
        == 403
    )
    assert (
        test_client.post(
            "/api/models/batch", json=[], headers=_headers(test_token)
        ).status_code
        == 403
    )
    assert (
        test_client.put(
            f"/api/models/{model.id}", json=update_payload, headers=_headers(test_token)
        ).status_code
        == 403
    )
    assert (
        test_client.delete(
            f"/api/models/{model.id}", headers=_headers(test_token)
        ).status_code
        == 403
    )

    db_model = test_db.query(Kind).filter(Kind.id == model.id).one()
    assert db_model.is_active is True
    assert db_model.json["spec"]["modelConfig"]["env"].get("base_url") is None


def test_admin_can_use_public_model_write_endpoints(
    test_client,
    test_admin_token: str,
) -> None:
    headers = _headers(test_admin_token)

    response = test_client.post(
        "/api/models",
        json={"name": "admin-created-model", "config": {"env": {"model": "openai"}}},
        headers=headers,
    )
    assert response.status_code == 201

    response = test_client.post("/api/models/batch", json=[], headers=headers)
    assert response.status_code == 201
    assert response.json() == {"created": [], "updated": [], "skipped": []}
