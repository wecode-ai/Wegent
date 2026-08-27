"""API coverage for generic DSH plugin storage."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.kind import Kind
from app.models.user import User

BASE_URL = "/api/v1/dsh-plugin-storage"
PACKAGE = "@wegent/ai-fleet-defense"
DESCRIPTOR = {"version": 1, "tables": ["scores"], "has_global": False}


def test_stores_and_loads_private_plugin_records(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
) -> None:
    response = test_client.put(
        f"{BASE_URL}/units/ai_fleet_defense/tables/scores/records/best",
        params={"package": PACKAGE},
        headers=_auth(test_token),
        json={**DESCRIPTOR, "value": {"score": 1200}, "shared": False},
    )

    assert response.status_code == 204
    stored = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "DshPluginData",
            Kind.namespace == PACKAGE,
            Kind.name == "ai_fleet_defense",
        )
        .one()
    )
    assert stored.json["tables"]["scores"]["best"] == {
        "value": {"score": 1200},
        "shared": False,
    }

    loaded = test_client.post(
        f"{BASE_URL}/units/ai_fleet_defense/load",
        params={"package": PACKAGE},
        headers=_auth(test_token),
        json=DESCRIPTOR,
    )
    assert loaded.status_code == 200
    assert loaded.json() == {
        "version": 1,
        "tables": {"scores": {"best": {"score": 1200}}},
        "global": None,
    }


def test_shared_scan_returns_only_explicitly_shared_records(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
) -> None:
    second_user = User(
        user_name="fleet-rival",
        password_hash=get_password_hash("secret-password"),
        email="fleet-rival@example.com",
        is_active=True,
    )
    test_db.add(second_user)
    test_db.commit()
    second_token = create_access_token(data={"sub": second_user.user_name})

    _put_score(test_client, test_token, "best", 1500, shared=True)
    _put_score(test_client, second_token, "best", 2100, shared=True)
    _put_score(test_client, second_token, "draft", 9999, shared=False)

    response = test_client.get(
        f"{BASE_URL}/units/ai_fleet_defense/tables/scores/shared",
        params={"package": PACKAGE},
        headers=_auth(test_token),
    )

    assert response.status_code == 200
    records = response.json()["records"]
    assert {
        (record["owner_name"], record["key"], record["value"]["score"])
        for record in records
    } == {
        (test_user.user_name, "best", 1500),
        (second_user.user_name, "best", 2100),
    }


def test_rejects_descriptor_version_changes(
    test_client: TestClient,
    test_token: str,
) -> None:
    _put_score(test_client, test_token, "best", 1500, shared=True)

    response = test_client.post(
        f"{BASE_URL}/units/ai_fleet_defense/load",
        params={"package": PACKAGE},
        headers=_auth(test_token),
        json={**DESCRIPTOR, "version": 2},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Storage unit version does not match"


def test_requires_authentication(test_client: TestClient) -> None:
    response = test_client.post(
        f"{BASE_URL}/units/ai_fleet_defense/load",
        params={"package": PACKAGE},
        json=DESCRIPTOR,
    )

    assert response.status_code == 401


def _put_score(
    client: TestClient,
    token: str,
    key: str,
    score: int,
    *,
    shared: bool,
) -> None:
    response = client.put(
        f"{BASE_URL}/units/ai_fleet_defense/tables/scores/records/{key}",
        params={"package": PACKAGE},
        headers=_auth(token),
        json={**DESCRIPTOR, "value": {"score": score}, "shared": shared},
    )
    assert response.status_code == 204


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
