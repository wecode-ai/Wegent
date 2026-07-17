# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.users import router
from app.core import security
from app.models.user import User


@pytest.fixture
def user_lookup_client(test_db: Session, test_user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/users")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user
    app.dependency_overrides[security.get_current_user_optional] = lambda: test_user
    return TestClient(app)


@pytest.mark.api
def test_get_users_by_ids_preserves_order_and_omits_inactive_users(
    user_lookup_client: TestClient,
    test_db: Session,
):
    first = User(user_name="first", email="first@example.com", is_active=True)
    second = User(user_name="second", email="second@example.com", is_active=True)
    inactive = User(user_name="inactive", email="inactive@example.com", is_active=False)
    test_db.add_all([first, second, inactive])
    test_db.commit()

    response = user_lookup_client.get(
        "/api/users/by-ids",
        params=[("ids", second.id), ("ids", inactive.id), ("ids", first.id)],
    )

    assert response.status_code == 200
    assert [user["user_name"] for user in response.json()["users"]] == [
        "second",
        "first",
    ]
