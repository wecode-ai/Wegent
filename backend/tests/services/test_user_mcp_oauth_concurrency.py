# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Independent sessions must not replace newer MCP grants with stale snapshots."""

import asyncio
import threading
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
from app.services import user_mcp_service as service_module
from app.services.user_mcp_oauth import UserMcpOAuthService
from app.services.user_mcp_service import MCPPreferencesError, user_mcp_service

TOKEN_URL = "https://oauth.example.test/token"


@pytest.fixture
def oauth_sessions(tmp_path, monkeypatch, mcp_session_cache):
    engine = create_engine(f"sqlite:///{tmp_path}/oauth.sqlite")
    User.__table__.create(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(service_module, "SessionLocal", sessions, raising=False)
    yield sessions
    engine.dispose()


def seed_user(sessions) -> int:
    preferences = {"theme": "dark"}
    for service_id in ("docs", "table"):
        preferences = user_mcp_service.set_provider_service_config(
            preferences,
            provider_id="dingtalk",
            service_id=service_id,
            enabled=True,
            url=f"https://mcp.example.test/{service_id}",
            auth_mode="oauth",
        )
        preferences = user_mcp_service.save_service_oauth_credentials(
            preferences,
            "dingtalk",
            service_id,
            access_token=f"old-{service_id}-access",
            refresh_token=f"old-{service_id}-refresh",
            expires_at=1,
        )
    preferences = user_mcp_service.set_provider_oauth_client(
        preferences,
        "dingtalk",
        {"client_id": "test-client", "token_endpoint": TOKEN_URL},
    )
    with sessions.begin() as db:
        user = User(
            user_name="oauth-race",
            password_hash="synthetic",
            preferences=user_mcp_service.dump_preferences(preferences),
        )
        db.add(user)
        db.flush()
        return user.id


@pytest.mark.asyncio
async def test_stale_session_reuses_rotated_grant(oauth_sessions, httpx_mock):
    user_id = seed_user(oauth_sessions)
    requests = []

    def refresh(request):
        requests.append(request)
        if len(requests) > 1:
            return httpx.Response(400, json={"error": "invalid_grant"})
        return httpx.Response(
            200,
            json={
                "access_token": "fresh-access",
                "refresh_token": "rotated-refresh",
                "expires_in": 7200,
            },
        )

    httpx_mock.add_callback(refresh, url=TOKEN_URL, is_reusable=True)
    with oauth_sessions() as first_db, oauth_sessions() as second_db:
        first = first_db.get(User, user_id)
        second = second_db.get(User, user_id)
        first_result = await UserMcpOAuthService.ensure_access_token(
            first_db, user=first, provider_id="dingtalk", service_id="docs"
        )
        second_result = await UserMcpOAuthService.ensure_access_token(
            second_db, user=second, provider_id="dingtalk", service_id="docs"
        )

    with oauth_sessions() as db:
        stored = user_mcp_service.get_service_oauth_credentials(
            db.get(User, user_id).preferences, "dingtalk", "docs"
        )
    assert stored["access_token"] == "fresh-access"
    assert stored["refresh_token"] == "rotated-refresh"
    assert first_result == second_result == "fresh-access"
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_different_services_preserve_each_others_committed_grants(
    oauth_sessions, httpx_mock
):
    user_id = seed_user(oauth_sessions)

    def refresh(request):
        refresh_token = parse_qs(request.content.decode())["refresh_token"][0]
        service_id = "docs" if refresh_token == "old-docs-refresh" else "table"
        return httpx.Response(
            200,
            json={
                "access_token": f"fresh-{service_id}",
                "refresh_token": f"rotated-{service_id}",
                "expires_in": 7200,
            },
        )

    httpx_mock.add_callback(refresh, url=TOKEN_URL, is_reusable=True)
    with oauth_sessions() as first_db, oauth_sessions() as second_db:
        first, second = first_db.get(User, user_id), second_db.get(User, user_id)
        assert (
            await UserMcpOAuthService.ensure_access_token(
                first_db, user=first, provider_id="dingtalk", service_id="docs"
            )
            == "fresh-docs"
        )
        assert (
            UserMcpOAuthService.ensure_access_token_sync(
                second_db, user=second, provider_id="dingtalk", service_id="table"
            )
            == "fresh-table"
        )

    with oauth_sessions() as db:
        preferences = db.get(User, user_id).preferences
        for service_id in ("docs", "table"):
            stored = user_mcp_service.get_service_oauth_credentials(
                preferences, "dingtalk", service_id
            )
            assert stored["access_token"] == f"fresh-{service_id}"
        assert user_mcp_service.load_preferences(preferences)["theme"] == "dark"


@pytest.fixture
def authorization_flow(monkeypatch, httpx_mock):
    sessions = {}
    monkeypatch.setattr(settings, "MCP_OAUTH_STATE_SECRET", "synthetic-state-key")

    async def cache_get(key):
        return dict(sessions[key]) if key in sessions else None

    async def cache_set(key, value, expire):
        sessions[key] = dict(value)
        return True

    monkeypatch.setattr(cache_manager, "get", cache_get)
    monkeypatch.setattr(cache_manager, "set", cache_set)
    monkeypatch.setattr(
        UserMcpOAuthService,
        "discover",
        AsyncMock(
            return_value={
                "issuer": "https://oauth.example.test",
                "authorization_endpoint": "https://oauth.example.test/authorize",
                "registration_endpoint": "https://oauth.example.test/register",
                "token_endpoint": TOKEN_URL,
                "scope": "user",
            }
        ),
    )
    httpx_mock.add_response(
        method="POST",
        url="https://oauth.example.test/register",
        json={"client_id": "test-client"},
    )

    async def start(db, user, service_id="docs"):
        return await UserMcpOAuthService.create_session(
            db, user=user, provider_id="dingtalk", service_id=service_id
        )

    async def finish(db, session, code="synthetic-code", refresh_token=None):
        httpx_mock.add_response(
            method="POST",
            url=TOKEN_URL,
            json={
                "access_token": f"{code}-access",
                "refresh_token": (
                    f"{code}-refresh" if refresh_token is None else refresh_token
                ),
                "expires_in": 7200,
            },
        )
        return await UserMcpOAuthService.complete_callback(
            db,
            code=code,
            state_token=parse_qs(urlsplit(session["authorize_url"]).query)["state"][0],
            browser_binding=f"{session['session_id']}.{session['binding']}",
        )

    return start, finish


@pytest.mark.asyncio
@pytest.mark.parametrize("service_id", ["docs", "table"])
@pytest.mark.parametrize("refresh_status", [200, 400])
async def test_background_refresh_does_not_cancel_pending_reauthorization(
    oauth_sessions, authorization_flow, httpx_mock, service_id, refresh_status
):
    user_id = seed_user(oauth_sessions)
    start, finish = authorization_flow
    with oauth_sessions() as caller:
        user = caller.get(User, user_id)
        pending = await start(caller, user, service_id)
        httpx_mock.add_response(
            method="POST",
            url=TOKEN_URL,
            status_code=refresh_status,
            json=(
                {
                    "access_token": "background-access",
                    "refresh_token": "rotated-refresh",
                    "expires_in": 7200,
                }
                if refresh_status == 200
                else {"error": "invalid_grant"}
            ),
        )
        assert await UserMcpOAuthService.ensure_access_token(
            caller, user=user, provider_id="dingtalk", service_id=service_id
        ) == ("background-access" if refresh_status == 200 else "")

        result = await finish(caller, pending, "reauthorized")

    assert result.startswith("Connected")
    with oauth_sessions() as db:
        credentials = user_mcp_service.get_service_oauth_credentials(
            db.get(User, user_id).preferences, "dingtalk", service_id
        )
        assert credentials["access_token"] == "reauthorized-access"
        assert credentials["refresh_token"] == "reauthorized-refresh"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["disabled", "address"])
async def test_changed_configuration_still_rejects_pending_authorization(
    oauth_sessions, authorization_flow, change
):
    user_id = seed_user(oauth_sessions)
    start, finish = authorization_flow
    enabled = change != "disabled"
    url = (
        "https://mcp.example.test/new-docs"
        if change == "address"
        else "https://mcp.example.test/docs"
    )
    with oauth_sessions() as caller:
        pending = await start(caller, caller.get(User, user_id))
        user_mcp_service.save_service_config(
            user_id,
            provider_id="dingtalk",
            service_id="docs",
            enabled=enabled,
            url=url,
            auth_mode="oauth",
        )

        with pytest.raises(MCPPreferencesError) as error:
            await finish(caller, pending, "late")

    assert error.value.status_code == 409
    config, _ = user_mcp_service.read_service(user_id, "dingtalk", "docs")
    assert config["enabled"] is enabled
    assert config["url"] == url
    with oauth_sessions() as db:
        credentials = user_mcp_service.get_service_oauth_credentials(
            db.get(User, user_id).preferences, "dingtalk", "docs"
        )
        assert credentials["access_token"] != "late-access"


@pytest.mark.asyncio
async def test_new_authorization_does_not_inherit_the_previous_grants_refresh_token(
    oauth_sessions, authorization_flow
):
    user_id = seed_user(oauth_sessions)
    start, finish = authorization_flow
    with oauth_sessions() as caller:
        pending = await start(caller, caller.get(User, user_id))
        await finish(caller, pending, "new", refresh_token="")
    with oauth_sessions() as db:
        stored = user_mcp_service.get_service_oauth_credentials(
            db.get(User, user_id).preferences, "dingtalk", "docs"
        )
        assert stored["access_token"] == "new-access"
        assert stored["refresh_token"] == ""


@pytest.mark.asyncio
async def test_disconnect_also_cancels_an_authorization_still_discovering(
    oauth_sessions, authorization_flow, monkeypatch
):
    user_id = seed_user(oauth_sessions)
    start, _ = authorization_flow
    entered, resume = asyncio.Event(), asyncio.Event()
    metadata = UserMcpOAuthService.discover.return_value

    async def discover(url):
        entered.set()
        await resume.wait()
        return metadata

    monkeypatch.setattr(UserMcpOAuthService, "discover", discover)
    with oauth_sessions() as caller:
        user = caller.get(User, user_id)
        await UserMcpOAuthService.disconnect(
            caller, user=user, provider_id="dingtalk", service_id="docs"
        )
        task = asyncio.create_task(start(caller, user))
        try:
            await asyncio.wait_for(entered.wait(), timeout=5)
            await UserMcpOAuthService.disconnect(
                caller, user=user, provider_id="dingtalk", service_id="docs"
            )
        finally:
            resume.set()
        with pytest.raises(HTTPException) as error:
            await task
        assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_disconnect_revokes_older_sessions_even_if_service_returns_to_empty_state(
    oauth_sessions, authorization_flow
):
    user_id = seed_user(oauth_sessions)
    start, finish = authorization_flow
    with oauth_sessions() as caller:
        user = caller.get(User, user_id)
        await UserMcpOAuthService.disconnect(
            caller, user=user, provider_id="dingtalk", service_id="docs"
        )
        old = await start(caller, user)
        new = await start(caller, user)
        await finish(caller, new, "new")
        await UserMcpOAuthService.disconnect(
            caller, user=user, provider_id="dingtalk", service_id="docs"
        )
        with pytest.raises(HTTPException):
            await finish(caller, old, "old")
    with oauth_sessions() as db:
        stored = user_mcp_service.get_service_oauth_credentials(
            db.get(User, user_id).preferences, "dingtalk", "docs"
        )
        assert stored["access_token"] == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["disconnect", "replace", "url"])
async def test_late_authorization_cannot_restore_changed_service(
    oauth_sessions, authorization_flow, change
):
    user_id = seed_user(oauth_sessions)
    start, finish = authorization_flow
    with oauth_sessions() as caller:
        user = caller.get(User, user_id)
        old_session = await start(caller, user)
        if change == "replace":
            new_session = await start(caller, user)
            await finish(caller, new_session, "new")
        elif change == "disconnect":
            await UserMcpOAuthService.disconnect(
                caller, user=user, provider_id="dingtalk", service_id="docs"
            )
        else:
            user_mcp_service.save_service_config(
                user_id,
                provider_id="dingtalk",
                service_id="docs",
                enabled=True,
                url="https://mcp.example.test/personal",
                auth_mode="url",
            )
        with pytest.raises(HTTPException) as error:
            await finish(caller, old_session, "old")
        assert error.value.status_code == 409
        poll = await UserMcpOAuthService.poll_session(
            caller,
            user=user,
            provider_id="dingtalk",
            service_id="docs",
            session_id=old_session["session_id"],
            poll_token=old_session["poll_token"],
        )
        assert poll["status"] == "failed"

    with oauth_sessions() as db:
        user = db.get(User, user_id)
        stored = user_mcp_service.get_service_oauth_credentials(
            user.preferences, "dingtalk", "docs"
        )
        assert stored["access_token"] == ("new-access" if change == "replace" else "")


@pytest.mark.asyncio
async def test_callback_merges_into_current_other_service_state(
    oauth_sessions, authorization_flow, httpx_mock
):
    user_id = seed_user(oauth_sessions)
    start, finish = authorization_flow
    with oauth_sessions() as caller:
        user = caller.get(User, user_id)
        pending = await start(caller, user, "table")
        httpx_mock.add_response(
            method="POST",
            url=TOKEN_URL,
            json={
                "access_token": "fresh-docs",
                "refresh_token": "rotated-docs",
                "expires_in": 7200,
            },
        )
        await UserMcpOAuthService.ensure_access_token(
            caller, user=user, provider_id="dingtalk", service_id="docs"
        )
        await finish(caller, pending, "table")

    with oauth_sessions() as db:
        preferences = db.get(User, user_id).preferences
        for service_id, expected in (("docs", "fresh-docs"), ("table", "table-access")):
            stored = user_mcp_service.get_service_oauth_credentials(
                preferences, "dingtalk", service_id
            )
            assert stored["access_token"] == expected


@pytest.mark.asyncio
async def test_async_refresh_keeps_event_loop_and_caller_transaction_independent(
    oauth_sessions, httpx_mock
):
    user_id = seed_user(oauth_sessions)
    entered, release = threading.Event(), threading.Event()
    event_loop_thread = threading.get_ident()

    def refresh(request):
        assert threading.get_ident() != event_loop_thread
        entered.set()
        assert release.wait(5), "Event loop did not release the refresh worker"
        return httpx.Response(
            200,
            json={
                "access_token": "fresh-access",
                "refresh_token": "fresh-refresh",
                "expires_in": 7200,
            },
        )

    httpx_mock.add_callback(refresh, url=TOKEN_URL)
    with oauth_sessions() as caller:
        user = caller.get(User, user_id)
        caller.add(User(user_name="uncommitted", password_hash="synthetic"))
        task = asyncio.create_task(
            UserMcpOAuthService.ensure_access_token(
                caller, user=user, provider_id="dingtalk", service_id="docs"
            )
        )
        try:
            assert await asyncio.to_thread(entered.wait, 5)
        finally:
            release.set()
        assert await task == "fresh-access"
        with oauth_sessions() as check:
            assert check.query(User).filter_by(user_name="uncommitted").first() is None


@pytest.mark.asyncio
async def test_authorization_requires_saving_oauth_mode_first(
    oauth_sessions, monkeypatch
):
    user_id = seed_user(oauth_sessions)
    user_mcp_service.save_service_config(
        user_id,
        provider_id="dingtalk",
        service_id="docs",
        enabled=True,
        url="https://mcp.example.test/personal",
        auth_mode="url",
    )
    discover = AsyncMock(side_effect=AssertionError("URL mode must not start OAuth"))
    monkeypatch.setattr(UserMcpOAuthService, "discover", discover)
    with oauth_sessions() as caller:
        with pytest.raises(HTTPException) as error:
            await UserMcpOAuthService.create_session(
                caller,
                user=caller.get(User, user_id),
                provider_id="dingtalk",
                service_id="docs",
            )
    assert error.value.status_code == 409
    assert "OAuth mode" in error.value.detail
    discover.assert_not_awaited()


@pytest.mark.asyncio
async def test_disconnect_fails_closed_when_pending_sessions_cannot_be_canceled(
    oauth_sessions, monkeypatch
):
    user_id = seed_user(oauth_sessions)
    monkeypatch.setattr(cache_manager, "set_from_sync", lambda *args, **kwargs: False)
    with oauth_sessions() as caller:
        with pytest.raises(HTTPException) as error:
            await UserMcpOAuthService.disconnect(
                caller,
                user=caller.get(User, user_id),
                provider_id="dingtalk",
                service_id="docs",
            )
    assert error.value.status_code == 503
    assert "retry" in error.value.detail
    with oauth_sessions() as db:
        stored = user_mcp_service.get_service_oauth_credentials(
            db.get(User, user_id).preferences, "dingtalk", "docs"
        )
        assert stored["refresh_token"] == "old-docs-refresh"


@pytest.mark.parametrize("error_code", [1205, 1213, 3572])
def test_database_lock_errors_return_retry_response(oauth_sessions, error_code):
    user_id = seed_user(oauth_sessions)

    def fail_query(connection, cursor, statement, parameters, context, executemany):
        raise OperationalError(
            statement, parameters, Exception(error_code, "synthetic database error")
        )

    event.listen(oauth_sessions.kw["bind"], "before_cursor_execute", fail_query)
    with pytest.raises(MCPPreferencesError) as error:
        user_mcp_service.save_service_config(
            user_id,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://mcp.example.test/docs",
            auth_mode="oauth",
        )
    assert error.value.status_code == 503
    assert error.value.error_code == "mcp_authorization_busy"
    assert "retry" in error.value.detail


def test_other_database_errors_are_not_reported_as_lock_conflicts(oauth_sessions):
    user_id = seed_user(oauth_sessions)
    original_error = OperationalError(
        "SELECT", {}, Exception(1064, "synthetic SQL error")
    )

    def fail_query(connection, cursor, statement, parameters, context, executemany):
        raise original_error

    event.listen(oauth_sessions.kw["bind"], "before_cursor_execute", fail_query)
    with pytest.raises(OperationalError) as error:
        user_mcp_service.save_service_config(
            user_id,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://mcp.example.test/docs",
            auth_mode="oauth",
        )
    assert error.value is original_error
