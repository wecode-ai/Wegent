# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.users import router
from app.core import security
from app.core.security import get_password_hash
from app.models.user import User
from app.services.weibo_account_binding import (
    ERROR_WEIBO_RESOLVER_NOT_CONFIGURED,
    ERROR_WEIBO_UID_RESOLVE_FAILED,
    WEIBO_BINDING_PREFERENCE_KEY,
    HttpWeiboAccountResolver,
    WeiboAccountBindingService,
    WeiboAccountProfile,
    WeiboBindingError,
    weibo_account_binding_service,
)


class StaticWeiboAccountResolver:
    def __init__(
        self,
        uid: str,
        *,
        screen_name: str | None = "微博用户",
        avatar_url: str | None = "https://weibo.com/avatar.jpg",
    ):
        self.profile = WeiboAccountProfile(
            uid=uid,
            screen_name=screen_name,
            avatar_url=avatar_url,
        )

    async def resolve_account(self, sub_cookie: str) -> WeiboAccountProfile:
        return self.profile


def get_stored_weibo_binding(user: User) -> dict:
    preferences = json.loads(user.preferences or "{}")
    return preferences.get(WEIBO_BINDING_PREFERENCE_KEY) or {}


@pytest.mark.api
@pytest.mark.asyncio
async def test_http_resolver_parses_weibo_auth_response(
    httpx_mock,
    monkeypatch: pytest.MonkeyPatch,
):
    resolver_url = "http://internal-weibo/snap_admin/auth.json?access_token=test"
    monkeypatch.setattr(
        "app.services.weibo_account_binding.WEIBO_SUB_UID_RESOLVE_URL",
        resolver_url,
    )
    monkeypatch.setattr(
        "app.services.weibo_account_binding.auth_headers",
        lambda uid, headers=None: {
            **(headers or {}),
            "Authorization": f"TAuth2 uid={uid}",
        },
    )
    httpx_mock.add_response(
        method="POST",
        url=resolver_url,
        json={
            "user": {
                "id": 2522481887,
                "screen_name": "夜阳FY",
                "profile_image_url": "https://weibo.com/small.jpg",
                "avatar_large": "https://weibo.com/large.jpg",
            }
        },
    )

    profile = await HttpWeiboAccountResolver().resolve_account("fake-sub")

    assert profile == WeiboAccountProfile(
        uid="2522481887",
        screen_name="夜阳FY",
        avatar_url="https://weibo.com/large.jpg",
    )
    request = httpx_mock.get_requests()[0]
    assert request.headers["cookie"] == "SUB=fake-sub"
    assert request.headers["authorization"] == "TAuth2 uid=5186027114"


@pytest.mark.api
@pytest.mark.asyncio
async def test_http_resolver_requires_user_payload(
    httpx_mock,
    monkeypatch: pytest.MonkeyPatch,
):
    resolver_url = "http://internal-weibo/snap_admin/auth.json?access_token=test"
    monkeypatch.setattr(
        "app.services.weibo_account_binding.WEIBO_SUB_UID_RESOLVE_URL",
        resolver_url,
    )
    monkeypatch.setattr(
        "app.services.weibo_account_binding.auth_headers",
        lambda uid, headers=None: {
            **(headers or {}),
            "Authorization": f"TAuth2 uid={uid}",
        },
    )
    httpx_mock.add_response(
        method="POST",
        url=resolver_url,
        json={"id": 2522481887, "screen_name": "legacy"},
    )

    with pytest.raises(WeiboBindingError) as exc_info:
        await HttpWeiboAccountResolver().resolve_account("fake-sub")

    assert exc_info.value.error_code == ERROR_WEIBO_UID_RESOLVE_FAILED


@pytest.fixture
def weibo_binding_client(test_db: Session, test_user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/users")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user

    return TestClient(app)


@pytest.mark.api
def test_preview_weibo_account_from_sub_cookie(
    weibo_binding_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    service = WeiboAccountBindingService(StaticWeiboAccountResolver("1234567890"))
    monkeypatch.setattr(weibo_account_binding_service, "_resolver", service._resolver)

    response = weibo_binding_client.post(
        "/api/users/me/weibo/preview",
        cookies={"SUB": "fake-sub"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "weibo_uid": "1234567890",
        "weibo_screen_name": "微博用户",
        "weibo_avatar_url": "https://weibo.com/avatar.jpg",
    }


@pytest.mark.api
def test_bind_weibo_account_after_confirming_preview(
    weibo_binding_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
):
    service = WeiboAccountBindingService(StaticWeiboAccountResolver("1234567890"))
    monkeypatch.setattr(weibo_account_binding_service, "_resolver", service._resolver)

    response = weibo_binding_client.post(
        "/api/users/me/weibo/bind",
        json={"expected_uid": "1234567890"},
        cookies={"SUB": "fake-sub"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["bound"] is True
    assert body["weibo_uid"] == "1234567890"
    assert body["weibo_screen_name"] == "微博用户"
    assert body["weibo_avatar_url"] == "https://weibo.com/avatar.jpg"
    assert body["weibo_bound_at"] is not None

    test_db.refresh(test_user)
    stored_binding = get_stored_weibo_binding(test_user)
    assert stored_binding["uid"] == "1234567890"
    assert stored_binding["screen_name"] == "微博用户"
    assert stored_binding["avatar_url"] == "https://weibo.com/avatar.jpg"
    assert stored_binding["bound_at"] is not None


@pytest.mark.api
def test_bind_weibo_account_allows_duplicate_uid(
    weibo_binding_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
):
    other_user = User(
        user_name="otheruser",
        password_hash=get_password_hash("testpassword123"),
        email="other@example.com",
        is_active=True,
        git_info=None,
        preferences=json.dumps(
            {
                WEIBO_BINDING_PREFERENCE_KEY: {
                    "uid": "1234567890",
                    "bound_at": "2026-06-03T00:00:00+00:00",
                }
            }
        ),
    )
    test_db.add(other_user)
    test_db.commit()

    service = WeiboAccountBindingService(StaticWeiboAccountResolver("1234567890"))
    monkeypatch.setattr(weibo_account_binding_service, "_resolver", service._resolver)

    response = weibo_binding_client.post(
        "/api/users/me/weibo/bind",
        json={"expected_uid": "1234567890"},
        cookies={"SUB": "fake-sub"},
    )

    assert response.status_code == 200
    test_db.refresh(test_user)
    test_db.refresh(other_user)
    assert get_stored_weibo_binding(test_user)["uid"] == "1234567890"
    assert get_stored_weibo_binding(other_user)["uid"] == "1234567890"


@pytest.mark.api
def test_bind_weibo_account_requires_sub_cookie(weibo_binding_client: TestClient):
    response = weibo_binding_client.post(
        "/api/users/me/weibo/bind",
        json={"expected_uid": "1234567890"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["error_code"] == "weibo_sub_missing"


@pytest.mark.api
def test_bind_weibo_account_rejects_changed_confirmed_uid(
    weibo_binding_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
):
    service = WeiboAccountBindingService(StaticWeiboAccountResolver("9876543210"))
    monkeypatch.setattr(weibo_account_binding_service, "_resolver", service._resolver)

    response = weibo_binding_client.post(
        "/api/users/me/weibo/bind",
        json={"expected_uid": "1234567890"},
        cookies={"SUB": "fake-sub"},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "weibo_uid_changed"
    test_db.refresh(test_user)
    assert get_stored_weibo_binding(test_user) == {}


@pytest.mark.api
def test_bind_weibo_account_reports_missing_resolver_config(
    weibo_binding_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        "app.services.weibo_account_binding.WEIBO_SUB_UID_RESOLVE_URL", ""
    )

    response = weibo_binding_client.post(
        "/api/users/me/weibo/bind",
        json={"expected_uid": "1234567890"},
        cookies={"SUB": "fake-sub"},
    )

    assert response.status_code == 503
    assert (
        response.json()["detail"]["error_code"] == ERROR_WEIBO_RESOLVER_NOT_CONFIGURED
    )


@pytest.mark.api
def test_unbind_weibo_account(
    weibo_binding_client: TestClient,
    test_db: Session,
    test_user: User,
):
    test_user.preferences = json.dumps(
        {
            "send_key": "enter",
            WEIBO_BINDING_PREFERENCE_KEY: {
                "uid": "1234567890",
                "screen_name": "微博用户",
                "avatar_url": "https://weibo.com/avatar.jpg",
                "bound_at": "2026-06-03T00:00:00+00:00",
            },
        }
    )
    test_db.add(test_user)
    test_db.commit()

    response = weibo_binding_client.delete("/api/users/me/weibo/bind")

    assert response.status_code == 200
    assert response.json() == {
        "bound": False,
        "weibo_uid": None,
        "weibo_screen_name": None,
        "weibo_avatar_url": None,
        "weibo_bound_at": None,
    }

    test_db.refresh(test_user)
    assert WEIBO_BINDING_PREFERENCE_KEY not in json.loads(test_user.preferences)
    assert json.loads(test_user.preferences)["send_key"] == "enter"
