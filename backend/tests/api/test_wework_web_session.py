import asyncio
import copy
import time
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from jose import jwt

from app.core.security import create_access_token
from app.schemas.wework_web_session import (
    WeworkWebSessionExchangeRequest,
    WeworkWebSessionRequest,
)
from app.services.auth import wework_web_session as service

REDIRECT = "/collaboration/123/issues/ISSUE-1?commentId=comment-17&focusRequest=open-2"
NONCE = "a" * 64
CREATE_URL = "/api/auth/wework/web-sessions"
EXCHANGE_URL = CREATE_URL + "/exchange"


class MemoryGrantCache:
    def __init__(self):
        self.values = {}

    async def set_or_raise(self, key, value, expire):
        assert expire == service.GRANT_TTL_SECONDS
        self.values[key] = copy.deepcopy(value)
        return True

    async def get_or_raise(self, key):
        return copy.deepcopy(self.values.get(key))

    async def pop_or_raise(self, key):
        return self.values.pop(key, None)


@pytest.fixture
def grants(monkeypatch):
    cache = MemoryGrantCache()
    monkeypatch.setattr(service, "cache_manager", cache)
    return cache


def create_grant(client, token):
    response = client.post(
        CREATE_URL,
        headers={"Authorization": f"Bearer {token}"},
        json={"nonce": NONCE, "redirect": REDIRECT},
    )
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    return {"code": response.json()["code"], "nonce": NONCE, "redirect": REDIRECT}


def test_exchange_mints_bound_active_user_session_once(
    test_client, test_token, test_user, grants
):
    payload = create_grant(test_client, test_token)
    response = test_client.post(EXCHANGE_URL, json=payload)
    assert response.status_code == 200
    session = response.json()
    claims = jwt.get_unverified_claims(session["access_token"])
    assert session["user_id"] == claims["user_id"] == test_user.id
    assert session["username"] == claims["sub"] == test_user.user_name
    assert session["expires_at"] == claims["exp"] > time.time()
    assert response.headers["Cache-Control"] == "no-store"
    assert test_client.post(EXCHANGE_URL, json=payload).status_code == 410


@pytest.mark.parametrize(
    "field,value",
    [("nonce", "b" * 64), ("redirect", "/collaboration/123/issues/ISSUE-2")],
)
def test_grant_cannot_be_exchanged_by_another_webview_or_for_another_issue(
    test_client, test_token, grants, field, value
):
    payload = create_grant(test_client, test_token)
    assert (
        test_client.post(EXCHANGE_URL, json={**payload, field: value}).status_code
        == 403
    )
    assert test_client.post(EXCHANGE_URL, json=payload).status_code == 200


def test_existing_account_cannot_be_replaced_in_any_credential_source(
    test_client, test_token, test_admin_token, grants
):
    for source in ("local", "cookie", "authorization"):
        payload = create_grant(test_client, test_token)
        headers = {}
        if source == "local":
            payload["existing_tokens"] = [test_token, test_admin_token]
        elif source == "cookie":
            headers["Cookie"] = f"auth_token={test_admin_token}"
        else:
            headers["Authorization"] = f"Bearer {test_admin_token}"
        response = test_client.post(EXCHANGE_URL, json=payload, headers=headers)
        assert response.status_code == 409, response.text
        assert service._grant_key(payload["code"]) in grants.values


def test_same_existing_account_can_be_reauthorized(test_client, test_token, grants):
    payload = create_grant(test_client, test_token)
    response = test_client.post(
        EXCHANGE_URL, json={**payload, "existing_tokens": [test_token]}
    )
    assert response.status_code == 200


def test_expired_same_user_web_identity_recovers_with_a_live_grant(
    test_client, test_token, test_user, grants
):
    payload = create_grant(test_client, test_token)
    expired = create_access_token(
        {"sub": test_user.user_name, "user_id": test_user.id}, expires_delta=-1
    )
    response = test_client.post(
        EXCHANGE_URL, json={**payload, "existing_tokens": [expired]}
    )
    assert response.status_code == 200
    assert (
        jwt.get_unverified_claims(response.json()["access_token"])["exp"] > time.time()
    )


def test_expired_other_user_web_identity_cannot_be_replaced(
    test_client, test_token, test_admin_user, grants
):
    payload = create_grant(test_client, test_token)
    expired = create_access_token(
        {"sub": test_admin_user.user_name, "user_id": test_admin_user.id},
        expires_delta=-1,
    )
    assert (
        test_client.post(
            EXCHANGE_URL, json={**payload, "existing_tokens": [expired]}
        ).status_code
        == 409
    )


def test_invalid_existing_session_is_preserved_and_rejected(
    test_client, test_token, grants
):
    payload = create_grant(test_client, test_token)
    response = test_client.post(
        EXCHANGE_URL, json={**payload, "existing_tokens": ["not-a-session"]}
    )
    assert response.status_code == 401
    assert service._grant_key(payload["code"]) in grants.values


def test_grant_expires_and_a_fresh_grant_recovers(test_client, test_token, grants):
    payload = create_grant(test_client, test_token)
    grants.values[service._grant_key(payload["code"])]["expires_at"] = time.time() - 1
    assert test_client.post(EXCHANGE_URL, json=payload).status_code == 410
    fresh = create_grant(test_client, test_token)
    assert test_client.post(EXCHANGE_URL, json=fresh).status_code == 200


def test_deactivated_account_cannot_redeem_previously_created_grant(
    test_client, test_token, test_user, test_db, grants
):
    payload = create_grant(test_client, test_token)
    test_user.is_active = False
    test_db.commit()
    assert test_client.post(EXCHANGE_URL, json=payload).status_code == 401


def test_creation_requires_a_live_user_session(test_client, test_user, grants):
    body = {"nonce": NONCE, "redirect": REDIRECT}
    assert test_client.post(CREATE_URL, json=body).status_code == 401
    expired = create_access_token({"sub": test_user.user_name}, expires_delta=-1)
    assert (
        test_client.post(
            CREATE_URL, json=body, headers={"Authorization": f"Bearer {expired}"}
        ).status_code
        == 401
    )


@pytest.mark.parametrize(
    "redirect",
    [
        "//attacker.example/",
        "/collaboration/123/issues/../login",
        "/collaboration/123/issues/ISSUE-1?next=https://attacker.example",
        "/collaboration/123/issues/ISSUE-1?commentId=one&commentId=two",
    ],
)
def test_handoff_rejects_non_issue_destinations(
    test_client, test_token, grants, redirect
):
    response = test_client.post(
        CREATE_URL,
        headers={"Authorization": f"Bearer {test_token}"},
        json={"nonce": NONCE, "redirect": redirect},
    )
    assert response.status_code == 422


def test_cache_failure_cannot_issue_a_reusable_session(
    test_client, test_token, grants, monkeypatch
):
    payload = create_grant(test_client, test_token)
    monkeypatch.setattr(grants, "pop_or_raise", AsyncMock(side_effect=OSError))
    assert test_client.post(EXCHANGE_URL, json=payload).status_code == 503


@pytest.mark.parametrize(
    "extra_claims",
    [
        {"scope": "read"},
        {"token_use": "wework_refresh"},
        {"user_id": "1"},
        {"user_id": True},
    ],
)
def test_non_session_credentials_cannot_establish_an_existing_identity(
    test_client, test_token, test_user, grants, extra_claims
):
    payload = create_grant(test_client, test_token)
    token = create_access_token({"sub": test_user.user_name, **extra_claims})
    response = test_client.post(
        EXCHANGE_URL, json={**payload, "existing_tokens": [token]}
    )
    assert response.status_code == 401


async def test_concurrent_exchanges_can_mint_only_one_session(
    test_user, test_db, grants, monkeypatch
):
    grant = await service.create_web_session(
        test_user, WeworkWebSessionRequest(nonce=NONCE, redirect=REDIRECT)
    )
    request = WeworkWebSessionExchangeRequest(
        nonce=NONCE, redirect=REDIRECT, code=grant.code
    )
    read = grants.get_or_raise
    both_read = asyncio.Event()
    readers = 0

    async def simultaneous_read(key):
        nonlocal readers
        value = await read(key)
        readers += 1
        if readers == 2:
            both_read.set()
        await both_read.wait()
        return value

    monkeypatch.setattr(grants, "get_or_raise", simultaneous_read)
    results = await asyncio.gather(
        service.exchange_web_session(test_db, request, []),
        service.exchange_web_session(test_db, request, []),
        return_exceptions=True,
    )
    failures = [result for result in results if isinstance(result, HTTPException)]
    assert len(failures) == 1
    assert failures[0].status_code == 410
    assert len([result for result in results if hasattr(result, "access_token")]) == 1
