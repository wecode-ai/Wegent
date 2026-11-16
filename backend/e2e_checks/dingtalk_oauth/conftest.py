"""No unit-test fixtures or in-process Wegent overrides are loaded here."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import pytest

from e2e_checks.dingtalk_oauth.provider import DingTalkProvider
from e2e_checks.dingtalk_oauth.support import Actor, assert_test_database, ok
from tests.e2e.knowledge_remote_index_support import (
    BACKEND_URL,
    _login,
)


@pytest.fixture(scope="session")
def provider() -> Iterator[DingTalkProvider]:
    assert (
        os.environ.get("DINGTALK_OAUTH_E2E") == "1"
    ), "Run the live-service suite explicitly"
    simulator = DingTalkProvider(os.environ["DINGTALK_E2E_DOWNLOAD_ORIGIN"])
    simulator.start(
        os.environ["DINGTALK_E2E_TLS_CERT"], os.environ["DINGTALK_E2E_TLS_KEY"]
    )
    try:
        yield simulator
    finally:
        simulator.stop()


@pytest.fixture(scope="session")
def admin() -> Iterator[httpx.Client]:
    assert_test_database()
    with httpx.Client(base_url=BACKEND_URL, timeout=60) as client:
        token, _ = _login(client)
        client.headers["Authorization"] = f"Bearer {token}"
        yield client


@pytest.fixture
def actor_factory(
    admin: httpx.Client, provider: DingTalkProvider, request: pytest.FixtureRequest
) -> Iterator[Callable[[], Actor]]:
    actors: list[Actor] = []

    def create() -> Actor:
        name = "e2e-dt-oauth-" + secrets.token_hex(6)
        password = secrets.token_urlsafe(24)
        user = ok(
            admin.post(
                "/api/users",
                json={
                    "user_name": name,
                    "password": password,
                    "email": f"{name}@example.com",
                },
            ),
            201,
        )
        login = ok(
            admin.post(
                "/api/auth/login", json={"user_name": name, "password": password}
            )
        )
        actor = Actor(user["id"], login["access_token"], name, provider)
        actors.append(actor)
        return actor

    try:
        yield create
    finally:
        provider.unblock()
        errors: list[Exception] = []
        evidence = []
        for actor in reversed(actors):
            try:
                evidence.append(actor.evidence())
            except Exception as error:
                errors.append(error)
            try:
                actor.close()
            except Exception as error:
                errors.append(error)
            response = admin.delete(f"/api/admin/users/{actor.id}")
            if response.status_code != 204:
                errors.append(
                    AssertionError(
                        f"Failed to delete E2E user: HTTP {response.status_code}"
                    )
                )
        directory = Path("reports/dingtalk-oauth-e2e")
        directory.mkdir(parents=True, exist_ok=True)
        name = hashlib.sha256(request.node.nodeid.encode()).hexdigest()[:16]
        (directory / f"{name}.json").write_text(
            json.dumps({"scenario": request.node.nodeid, "actors": evidence}, indent=2),
            encoding="utf-8",
        )
        if errors:
            raise ExceptionGroup("E2E cleanup failed", errors)


@pytest.fixture
def actor(actor_factory: Callable[[], Actor]) -> Actor:
    return actor_factory()
