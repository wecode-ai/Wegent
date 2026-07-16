# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_create_and_list_custom_mcp(test_client: TestClient, test_token: str):
    response = test_client.post(
        "/api/mcps/custom",
        headers=_auth_headers(test_token),
        json={
            "name": "custom-docs",
            "displayName": "Custom Docs",
            "description": "Search custom docs",
            "server": {
                "type": "streamable-http",
                "url": "https://mcp.example.com/docs",
                "headers": {"Authorization": "Bearer test"},
            },
        },
    )

    assert response.status_code == 201
    created = response.json()
    assert created["kind"] == "InstalledMCP"
    assert created["metadata"]["name"] == "custom-docs"
    assert created["spec"]["source"]["type"] == "custom"
    assert created["spec"]["enabled"] is True

    list_response = test_client.get(
        "/api/mcps/installed",
        headers=_auth_headers(test_token),
    )

    assert list_response.status_code == 200
    items = list_response.json()["items"]
    assert len(items) == 1
    assert items[0]["metadata"]["name"] == "custom-docs"


def test_install_provider_mcp_and_toggle_enabled(
    test_client: TestClient, test_token: str
):
    install_response = test_client.post(
        "/api/mcps/install",
        headers=_auth_headers(test_token),
        json={
            "providerKey": "modelscope",
            "serverKey": "browser",
            "catalogItemId": "@modelscope/browser",
            "displayName": "Browser MCP",
            "description": "Browse pages",
            "server": {
                "type": "streamable-http",
                "url": "https://mcp.example.com/browser",
            },
        },
    )

    assert install_response.status_code == 201
    installed = install_response.json()
    installed_id = installed["metadata"]["labels"]["id"]
    assert installed["spec"]["source"]["type"] == "provider"
    assert installed["spec"]["source"]["providerKey"] == "modelscope"

    update_response = test_client.put(
        f"/api/mcps/installed/{installed_id}",
        headers=_auth_headers(test_token),
        json={"enabled": False},
    )

    assert update_response.status_code == 200
    assert update_response.json()["spec"]["enabled"] is False


def test_uninstall_installed_mcp(test_client: TestClient, test_token: str):
    create_response = test_client.post(
        "/api/mcps/custom",
        headers=_auth_headers(test_token),
        json={
            "name": "custom-shell",
            "displayName": "Custom Shell",
            "server": {
                "type": "stdio",
                "command": "uvx",
                "args": ["custom-shell"],
            },
        },
    )
    installed_id = create_response.json()["metadata"]["labels"]["id"]

    delete_response = test_client.delete(
        f"/api/mcps/installed/{installed_id}",
        headers=_auth_headers(test_token),
    )

    assert delete_response.status_code == 204

    list_response = test_client.get(
        "/api/mcps/installed",
        headers=_auth_headers(test_token),
    )
    assert list_response.json()["items"] == []
