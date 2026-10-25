"""Real JWT, HTTP routing, Redis and MySQL boundaries for plugin writes."""

import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.api import dependencies
from app.api.endpoints.plugin_connections import router
from app.core.config import settings
from app.core.security import create_access_token
from app.models.kind import Kind
from app.models.user import User
from app.services import plugin_write_coordination as coordination
from app.services import plugin_write_resources as resources
from integration_checks.plugin_auth_fixtures import Context, context, sessions


@pytest.fixture
def client(context: Context, monkeypatch: pytest.MonkeyPatch):
    # Configure the real connection factory, keeping JWT verification and both
    # production get_db/get_plugin_db dependencies intact. A plain Session also
    # checks that HTTP routing configures isolation before authentication reads.
    factory = sessionmaker(
        context.sessions.kw["bind"], autoflush=False, expire_on_commit=False
    )
    monkeypatch.setattr(dependencies, "SessionLocal", factory)
    with context.sessions() as db:
        username = db.query(User.user_name).filter(User.id == context.user_id).scalar()
    token = create_access_token({"sub": username})
    app = FastAPI()
    app.include_router(router, prefix="/plugin-connections")
    with TestClient(app) as value:
        value.headers["Authorization"] = f"Bearer {token}"
        yield value


def test_concurrent_disconnect_requests_commit_once_and_report_revision_conflict(
    context: Context, client: TestClient
):
    with context.sessions.begin() as db:
        account = context.accounts.enroll(
            db, user_id=context.user_id, request=context.credential()
        )
    barrier = threading.Barrier(2, timeout=10)

    def disconnect():
        barrier.wait()
        return client.request(
            "DELETE",
            f"/plugin-connections/{account.id}",
            json={"expected_revision": account.revision},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        requests = [pool.submit(disconnect) for _ in range(2)]
        responses = [request.result(timeout=10) for request in requests]

    assert sorted(response.status_code for response in responses) == [200, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json() == {"detail": "plugin_auth_revision_conflict"}
    assert all(
        response.headers["cache-control"] == "no-store" for response in responses
    )
    stored = client.get("/plugin-connections").json()
    assert len(stored) == 1
    assert stored[0]["status"] == "disconnected"
    assert stored[0]["revision"] == account.revision + 1
    assert stored[0]["device_ids"] == []


def test_busy_http_write_preserves_state_and_can_be_retried_after_release(
    context: Context, client: TestClient
):
    key = f"wegent:plugin-write:{context.user_id}"
    redis = coordination._redis_client()
    with context.sessions() as holder:
        coordination.acquire_plugin_write_lock(holder, context.user_id)
        token = redis.get(key)
        started = time.monotonic()

        response = client.patch(
            "/plugin-connections/automation", json={"enabled": False}
        )

        assert time.monotonic() - started < 8
        assert response.status_code == 503
        assert response.json() == {"detail": "plugin_write_busy"}
        assert response.headers["cache-control"] == "no-store"
        assert redis.get(key) == token
        assert client.get("/plugin-connections/automation").json() == {"enabled": True}

    assert redis.get(key) is None
    retry = client.patch("/plugin-connections/automation", json={"enabled": False})
    assert retry.status_code == 200
    assert retry.json() == {"enabled": False}
    assert client.get("/plugin-connections/automation").json() == {"enabled": False}
    with context.sessions() as db:
        assert (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                kind="ConnectorAuthPolicy",
                namespace="plugin-auth",
                name="account",
                is_active=True,
            )
            .count()
            == 1
        )


def test_authenticated_http_disconnect_does_not_wait_for_user_row_lock(
    context: Context, client: TestClient
):
    with context.sessions.begin() as db:
        account = context.accounts.enroll(
            db, user_id=context.user_id, request=context.credential()
        )
    with ThreadPoolExecutor(max_workers=1) as pool:
        with context.sessions() as blocker:
            blocker.execute(
                text("SELECT id FROM users WHERE id = :user_id FOR UPDATE"),
                {"user_id": context.user_id},
            ).one()
            response = pool.submit(
                client.request,
                "DELETE",
                f"/plugin-connections/{account.id}",
                json={"expected_revision": account.revision},
            ).result(timeout=5)

            assert response.status_code == 200
            assert response.json()["status"] == "disconnected"
            assert blocker.in_transaction()
    assert (
        coordination._redis_client().get(f"wegent:plugin-write:{context.user_id}")
        is None
    )


def test_http_requests_still_require_a_valid_user_token(client: TestClient):
    response = client.patch(
        "/plugin-connections/automation",
        json={"enabled": False},
        headers={"Authorization": "Bearer invalid-synthetic-token"},
    )

    assert response.status_code == 401
    assert client.get("/plugin-connections/automation").json() == {"enabled": True}


def test_unreachable_redis_rejects_http_write_without_changing_state_and_recovers(
    context: Context, client: TestClient
):
    # Reserve a local port without listening, producing an actual connection
    # refusal instead of synthesizing a Redis exception or business response.
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(
                settings,
                "REDIS_URL",
                f"redis://127.0.0.1:{reserved.getsockname()[1]}/15",
            )
            patch.setattr(resources, "_redis", None)
            patch.setattr(coordination, "_redis_client", resources.redis_client)
            with resources.redis_client():
                started = time.monotonic()
                response = client.patch(
                    "/plugin-connections/automation", json={"enabled": False}
                )
                assert time.monotonic() - started < 3

    assert response.status_code == 503
    assert response.json() == {"detail": "plugin_write_unavailable"}
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/plugin-connections/automation").json() == {"enabled": True}
    with context.sessions() as db:
        assert (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                kind="ConnectorAuthPolicy",
                namespace="plugin-auth",
                name="account",
            )
            .count()
            == 0
        )
    assert (
        client.patch(
            "/plugin-connections/automation", json={"enabled": False}
        ).status_code
        == 200
    )
