# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_create_and_list_resource_library_listing(test_client, test_token):
    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "skill",
            "source_id": 1,
            "name": "doc-summary",
            "display_name": "Doc Summary",
            "description": "Summarizes documents",
            "tags": ["docs"],
            "version": "1.0.0",
            "manifest_options": {
                "manifest": {"skill": {"name": "doc-summary"}},
            },
        },
    )

    assert create_response.status_code == 201
    listing_id = create_response.json()["id"]

    list_response = test_client.get(
        "/api/resource-library/listings?resource_type=skill&keyword=summary",
        headers=auth_headers(test_token),
    )

    assert list_response.status_code == 200
    body = list_response.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == listing_id


def test_install_resource_library_listing(test_client, test_token):
    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "skill",
            "source_id": 1,
            "name": "installable-summary",
            "display_name": "Installable Summary",
            "description": "Summarizes documents",
            "tags": ["docs"],
            "version": "1.0.0",
            "manifest_options": {
                "manifest": {
                    "resource_type": "skill",
                    "skill": {"metadata": {"name": "installable-summary"}},
                },
            },
        },
    )
    listing_id = create_response.json()["id"]

    install_response = test_client.post(
        f"/api/resource-library/listings/{listing_id}/install",
        headers=auth_headers(test_token),
        json={"target_namespace": "default"},
    )

    assert install_response.status_code == 200
    assert install_response.json()["listing_id"] == listing_id
    assert install_response.json()["install_status"] == "installed"


def test_list_my_published_and_archive_resource_library_listing(
    test_client, test_token
):
    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "agent",
            "source_id": 1,
            "name": "published-agent",
            "display_name": "Published Agent",
            "description": "Reusable agent",
            "tags": ["agent"],
            "version": "1.0.0",
            "manifest_options": {
                "manifest": {"team": {"metadata": {"name": "published-agent"}}},
            },
        },
    )
    listing_id = create_response.json()["id"]

    published_response = test_client.get(
        "/api/resource-library/users/me/published?resource_type=agent",
        headers=auth_headers(test_token),
    )

    assert published_response.status_code == 200
    assert published_response.json()["total"] == 1
    assert published_response.json()["items"][0]["id"] == listing_id

    archive_response = test_client.post(
        f"/api/resource-library/listings/{listing_id}/archive",
        headers=auth_headers(test_token),
    )

    assert archive_response.status_code == 200
    assert archive_response.json()["status"] == "archived"


def test_list_my_installs(test_client, test_token):
    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "mcp",
            "source_id": 1,
            "name": "docs-mcp",
            "display_name": "Docs MCP",
            "description": "Documentation MCP",
            "tags": ["docs"],
            "version": "1.0.0",
            "manifest_options": {
                "manifest": {
                    "resource_type": "mcp",
                    "server_name": "docs",
                    "server_config_template": {"type": "streamable-http", "url": ""},
                    "required_fields": ["url"],
                },
            },
        },
    )
    listing_id = create_response.json()["id"]
    test_client.post(
        f"/api/resource-library/listings/{listing_id}/install",
        headers=auth_headers(test_token),
        json={"install_options": {"url": "https://example.com/mcp"}},
    )

    installs_response = test_client.get(
        "/api/resource-library/users/me/installs?resource_type=mcp",
        headers=auth_headers(test_token),
    )

    assert installs_response.status_code == 200
    assert installs_response.json()["total"] == 1
    assert installs_response.json()["items"][0]["listing_id"] == listing_id
