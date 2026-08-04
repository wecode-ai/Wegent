# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the external knowledge MCP auth handler.

The internal handler accepts either credential: the gateway ``X-User-Name``
employee id is tried first, then falls back to the open-source personal API
key handler so external user tokens keep working.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from wecode.mcp_server import auth


def _request(headers: dict[str, str]) -> SimpleNamespace:
    return SimpleNamespace(headers=headers)


def test_erp_auth_handler_returns_employee_user_without_token_fallback():
    # Arrange
    employee_user = object()
    request = _request({"X-User-Name": "230473"})

    with (
        patch.object(
            auth, "_resolve_by_employee_id", return_value=employee_user
        ) as resolve_employee,
        patch.object(
            auth.mcp_server_module, "_default_external_auth_handler"
        ) as default_handler,
    ):
        # Act
        result = auth.erp_auth_handler("wg-token", request)

    # Assert
    assert result is employee_user
    resolve_employee.assert_called_once_with(request)
    default_handler.assert_not_called()


def test_erp_auth_handler_falls_back_to_user_token():
    # Arrange
    token_user = object()
    request = _request({})

    with (
        patch.object(auth, "_resolve_by_employee_id", return_value=None),
        patch.object(
            auth.mcp_server_module,
            "_default_external_auth_handler",
            return_value=token_user,
        ) as default_handler,
    ):
        # Act
        result = auth.erp_auth_handler("wg-token", request)

    # Assert
    assert result is token_user
    default_handler.assert_called_once_with("wg-token", request)


def test_erp_auth_handler_returns_none_when_neither_credential_resolves():
    # Arrange
    request = _request({})

    with (
        patch.object(auth, "_resolve_by_employee_id", return_value=None),
        patch.object(
            auth.mcp_server_module,
            "_default_external_auth_handler",
            return_value=None,
        ),
    ):
        # Act
        result = auth.erp_auth_handler(None, request)

    # Assert
    assert result is None


def test_resolve_by_employee_id_returns_none_without_header():
    # Arrange: missing X-User-Name must short-circuit before touching the DB.
    request = _request({})

    with patch.object(auth, "get_db_session") as get_db_session:
        # Act
        result = auth._resolve_by_employee_id(request)

    # Assert
    assert result is None
    get_db_session.assert_not_called()


def test_resolve_by_employee_id_resolves_active_user():
    # Arrange
    request = _request({"X-User-Name": "230473"})
    resolved_user = MagicMock(id=7, user_name="testuser")
    db = MagicMock()
    ctx = MagicMock()
    ctx.__enter__.return_value = db

    with (
        patch.object(auth, "get_db_session", return_value=ctx),
        patch.object(
            auth, "_resolve_user_by_employee_id", return_value=resolved_user
        ) as resolve_user,
    ):
        # Act
        result = auth._resolve_by_employee_id(request)

    # Assert
    resolve_user.assert_called_once_with(db, "230473")
    assert result.id == 7
    assert result.user_name == "testuser"
