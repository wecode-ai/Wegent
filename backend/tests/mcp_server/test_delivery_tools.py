# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registration contract for Delivery MCP tools."""

from types import SimpleNamespace

from app.core.security import create_access_token
from app.mcp_server.auth import authenticate_mcp_token
from app.mcp_server.tools import delivery  # noqa: F401
from app.mcp_server.tools.decorator import get_registered_mcp_tools


def test_delivery_tools_are_registered_with_safe_public_parameters() -> None:
    tools = get_registered_mcp_tools(server="delivery")

    assert set(tools) == {
        "list_cloud_projects",
        "list_cloud_todos",
        "list_cloud_workspace",
        "list_loop_item_deliveries",
        "read_cloud_file",
        "read_delivery_markdown",
        "read_delivery_asset",
        "resolve_cloud_reference",
    }
    assert [
        parameter["name"]
        for parameter in tools["list_loop_item_deliveries"]["parameters"]
    ] == ["loop_item_id"]
    assert [
        parameter["name"] for parameter in tools["read_delivery_markdown"]["parameters"]
    ] == ["delivery_id"]
    assert all(
        "token_info" not in {parameter["name"] for parameter in tool["parameters"]}
        for tool in tools.values()
    )


def test_delivery_session_manager_is_part_of_application_lifespan() -> None:
    from app.main import _get_mcp_lifespan_servers

    assert "Delivery" in {name for name, _server in _get_mcp_lifespan_servers()}


def test_delivery_tools_receive_authenticated_request_context() -> None:
    from app.mcp_server.server import MCP_APP_SPECS, MCP_CONTEXT_SERVER_NAMES

    assert "delivery" in MCP_CONTEXT_SERVER_NAMES
    delivery_spec = next(spec for spec in MCP_APP_SPECS if spec.name == "delivery")
    assert delivery_spec.allow_user_token is True


def test_regular_user_token_can_authenticate_for_user_scoped_mcp(monkeypatch) -> None:
    token = create_access_token(data={"sub": "alice"})
    monkeypatch.setattr(
        "app.mcp_server.auth.verify_jwt_token",
        lambda _token: SimpleNamespace(id=7, user_name="alice", is_active=True),
    )

    auth_info = authenticate_mcp_token(token, allow_user_token=True)

    assert auth_info is not None
    assert auth_info.user_id == 7
    assert auth_info.user_name == "alice"
    assert auth_info.auth_type == "user"
    assert auth_info.task_id is None
    assert auth_info.subtask_id is None


def test_regular_user_token_is_rejected_by_task_scoped_mcp(monkeypatch) -> None:
    token = create_access_token(data={"sub": "alice"})
    monkeypatch.setattr(
        "app.mcp_server.auth.verify_jwt_token",
        lambda _token: SimpleNamespace(id=7, user_name="alice", is_active=True),
    )

    assert authenticate_mcp_token(token, allow_user_token=False) is None
