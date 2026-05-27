# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import sys
import types

try:
    import magic  # noqa: F401
except ImportError:
    sys.modules.pop("magic", None)

    class _TestMagic:
        def __init__(self, *args, **kwargs):
            pass

        def from_buffer(self, content):
            return "application/octet-stream"

    sys.modules["magic"] = types.SimpleNamespace(Magic=_TestMagic)


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_listing(test_client, test_token: str, name: str = "doc-summary"):
    return test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "skill",
            "source_id": 1,
            "name": name,
            "display_name": "Doc Summary",
            "description": "Summarizes documents",
            "tags": ["docs"],
            "version": "1.0.0",
            "manifest_options": {
                "manifest": {"skill": {"name": name}},
            },
        },
    )


def test_create_and_list_resource_library_listing(test_client, test_token):
    create_response = _create_listing(test_client, test_token)

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


def test_get_resource_library_listing(test_client, test_token):
    create_response = _create_listing(test_client, test_token)
    listing_id = create_response.json()["id"]

    get_response = test_client.get(
        f"/api/resource-library/listings/{listing_id}",
        headers=auth_headers(test_token),
    )

    assert get_response.status_code == 200
    assert get_response.json()["id"] == listing_id


def test_archive_resource_library_listing(test_client, test_token):
    create_response = _create_listing(test_client, test_token)
    listing_id = create_response.json()["id"]

    archive_response = test_client.delete(
        f"/api/resource-library/listings/{listing_id}",
        headers=auth_headers(test_token),
    )
    list_response = test_client.get(
        "/api/resource-library/listings?resource_type=skill&keyword=summary",
        headers=auth_headers(test_token),
    )

    assert archive_response.status_code == 200
    assert archive_response.json()["status"] == "archived"
    assert list_response.status_code == 200
    assert list_response.json()["total"] == 0
