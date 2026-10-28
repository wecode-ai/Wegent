# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real MySQL/Redis regression checks; OAuth HTTP responses are unit-test doubles."""

import threading
from urllib.parse import parse_qs

import httpx
import pytest
from sqlalchemy import event

from app.models.user import User
from app.services.user_mcp_oauth import UserMcpOAuthService
from app.services.user_mcp_service import MCPPreferencesError, user_mcp_service
from integration_checks.mcp_oauth_fixtures import oauth_context  # noqa: F401
from integration_checks.mcp_oauth_fixtures import (
    OAuthContext,
    contend,
)
from tests.services.test_user_mcp_oauth_concurrency import TOKEN_URL


def install_refresh(httpx_mock, status_code=200):
    entered, release = threading.Event(), threading.Event()
    requests = []

    def refresh(request):
        grant = parse_qs(request.content.decode())["refresh_token"][0]
        requests.append(grant)
        if len(requests) == 1:
            entered.set()
            assert release.wait(10), "Coordinator did not release the refresh"
        service = "docs" if grant == "old-docs-refresh" else "table"
        payload = (
            {
                "access_token": f"fresh-{service}",
                "refresh_token": f"rotated-{service}",
                "expires_in": 7200,
            }
            if status_code == 200
            else {"error": "invalid_grant"}
        )
        return httpx.Response(status_code, json=payload)

    httpx_mock.add_callback(refresh, url=TOKEN_URL, is_reusable=True)
    return entered, release, requests


def save_config(context: OAuthContext, service="docs", url=None):
    return user_mcp_service.save_service_config(
        context.user_id,
        provider_id="dingtalk",
        service_id=service,
        enabled=True,
        url=url or f"https://mcp.example.test/new-{service}",
        auth_mode="oauth",
    )


def authorize(session):
    UserMcpOAuthService._store_authorization(
        session,
        {
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 7200,
        },
    )


@pytest.mark.parametrize("second_service", ["docs", "table"])
def test_refreshes_wait_and_reread_current_credentials(
    oauth_context, httpx_mock, second_service
):
    context = oauth_context
    entered, release, requests = install_refresh(httpx_mock)
    results = contend(
        context,
        lambda: context.refresh(asynchronous=True),
        lambda: context.refresh(second_service),
        entered,
        release,
    )
    assert results == ("fresh-docs", f"fresh-{second_service}")
    expected = ["old-docs-refresh"]
    if second_service == "table":
        expected.append("old-table-refresh")
    assert requests == expected
    for service in {"docs", second_service}:
        stored = context.credentials(service)
        assert stored["access_token"] == f"fresh-{service}"
        assert stored["refresh_token"] == f"rotated-{service}"


@pytest.mark.parametrize("refresh_status", [200, 400])
@pytest.mark.parametrize(
    "operation", ["reauthorize", "disconnect", "same_config", "other_config"]
)
def test_refresh_races_with_authorization_and_configuration(
    oauth_context, httpx_mock, operation, refresh_status
):
    context = oauth_context
    pending = context.authorization()
    entered, release, requests = install_refresh(httpx_mock, refresh_status)

    def write():
        if operation == "reauthorize":
            authorize(pending)
        elif operation == "disconnect":
            UserMcpOAuthService.clear_stored_credentials(
                context.user_id, "dingtalk", "docs"
            )
        else:
            save_config(context, "docs" if operation == "same_config" else "table")

    result, _ = contend(context, context.refresh, write, entered, release)
    assert result == ("fresh-docs" if refresh_status == 200 else "")
    assert requests == ["old-docs-refresh"]
    stored = context.credentials()
    if operation == "reauthorize":
        assert stored["access_token"] == "new-access"
        assert stored["refresh_token"] == "new-refresh"
    elif operation in {"disconnect", "same_config"}:
        assert stored["access_token"] == stored["refresh_token"] == ""
        with pytest.raises(MCPPreferencesError) as error:
            authorize(pending)
        assert error.value.status_code == 409
    else:
        assert stored["access_token"] == ("fresh-docs" if refresh_status == 200 else "")
        # Changing Table must not cancel a pending Docs authorization.
        authorize(pending)
        assert context.credentials()["access_token"] == "new-access"
    with context.sessions() as db:
        preferences = db.get(User, context.user_id).preferences
        assert user_mcp_service.load_preferences(preferences)["theme"] == "dark"
    if operation in {"same_config", "other_config"}:
        service = "docs" if operation == "same_config" else "table"
        config, _ = user_mcp_service.read_service(context.user_id, "dingtalk", service)
        assert config["url"] == f"https://mcp.example.test/new-{service}"


@pytest.mark.parametrize("operation", ["reauthorize", "disconnect", "config"])
def test_stale_refresh_waits_for_newer_write(oauth_context, httpx_mock, operation):
    context = oauth_context
    pending = context.authorization()
    entered, release = threading.Event(), threading.Event()
    with context.sessions() as caller:
        stale_user = caller.get(User, context.user_id)

    def write():
        # Pause the real transaction after its UPDATE, before it commits.
        def pause(connection, cursor, statement, parameters, execution, executemany):
            if statement.lstrip().upper().startswith("UPDATE USERS"):
                entered.set()
                assert release.wait(10)

        event.listen(context.engine, "after_cursor_execute", pause)
        try:
            if operation == "reauthorize":
                authorize(pending)
            elif operation == "disconnect":
                UserMcpOAuthService.clear_stored_credentials(
                    context.user_id, "dingtalk", "docs"
                )
            else:
                save_config(context)
        finally:
            event.remove(context.engine, "after_cursor_execute", pause)

    def refresh():
        with context.sessions() as db:
            try:
                return UserMcpOAuthService.ensure_access_token_sync(
                    db, user=stale_user, provider_id="dingtalk", service_id="docs"
                )
            except MCPPreferencesError as exc:
                return exc.status_code

    _, result = contend(context, write, refresh, entered, release)
    assert (
        result
        == {"reauthorize": "new-access", "disconnect": "", "config": 409}[operation]
    )
    assert httpx_mock.get_requests() == []
    stored = context.credentials()
    assert stored["access_token"] == (
        "new-access" if operation == "reauthorize" else ""
    )
    assert stored["refresh_token"] == (
        "new-refresh" if operation == "reauthorize" else ""
    )


def test_different_service_configurations_do_not_lose_updates(oauth_context):
    context = oauth_context
    entered, release = threading.Event(), threading.Event()

    def first():
        def pause(connection, cursor, statement, parameters, execution, executemany):
            if statement.lstrip().upper().startswith("UPDATE USERS"):
                entered.set()
                assert release.wait(10)

        event.listen(context.engine, "after_cursor_execute", pause)
        try:
            return save_config(context, "docs")
        finally:
            event.remove(context.engine, "after_cursor_execute", pause)

    results = contend(
        context, first, lambda: save_config(context, "table"), entered, release
    )
    for service, result in zip(("docs", "table"), results):
        assert result["url"] == f"https://mcp.example.test/new-{service}"
        stored, _ = user_mcp_service.read_service(context.user_id, "dingtalk", service)
        assert stored["url"] == result["url"]
        assert context.credentials(service)["refresh_token"] == ""


def test_invalid_old_grant_cannot_clear_new_authorization(oauth_context):
    context = oauth_context
    authorize(context.authorization())
    with user_mcp_service.locked_user(context.user_id) as current:
        UserMcpOAuthService._note_refresh_failure(
            user=current,
            provider_id="dingtalk",
            service_id="docs",
            reason="HTTP 400",
            expected_refresh_token="old-docs-refresh",
            response=httpx.Response(400, json={"error": "invalid_grant"}),
        )
    assert context.credentials()["access_token"] == "new-access"
    assert context.credentials()["refresh_token"] == "new-refresh"


def test_configuration_round_trip_does_not_reactivate_old_callback(oauth_context):
    context = oauth_context
    pending = context.authorization()
    save_config(context)
    save_config(context, url="https://mcp.example.test/docs")
    with pytest.raises(MCPPreferencesError) as error:
        authorize(pending)
    assert error.value.status_code == 409
    assert context.credentials()["access_token"] == ""


def test_real_lock_timeout_preserves_credentials(oauth_context):
    context = oauth_context

    @event.listens_for(context.engine, "checkout")
    def short_timeout(connection, record, proxy):
        with connection.cursor() as cursor:
            cursor.execute("SET SESSION innodb_lock_wait_timeout=1")

    with user_mcp_service.locked_user(context.user_id):
        with pytest.raises(MCPPreferencesError) as error:
            context.refresh()
    assert error.value.status_code == 503
    assert error.value.error_code == "mcp_authorization_busy"
    assert context.credentials()["refresh_token"] == "old-docs-refresh"
