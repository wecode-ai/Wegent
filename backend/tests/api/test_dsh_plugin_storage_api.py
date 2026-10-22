"""API coverage for generic DSH plugin storage."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.user import User

BASE_URL = "/api/v1/dsh-plugin-storage"
PACKAGE = "@wegent/ai-fleet-defense"
DESCRIPTOR = {"version": 1, "tables": ["scores"], "has_global": False}


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
