# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import sys
import types

from app.models.kind import Kind
from app.models.resource_library import ResourceLibraryVersion

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


def _create_kind(
    test_db,
    *,
    user_id: int,
    kind: str = "Skill",
    name: str = "doc-summary",
    namespace: str = "default",
) -> Kind:
    source = Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {"name": name, "namespace": namespace},
            "spec": {"description": f"{kind} {name}"},
        },
        is_active=True,
    )
    test_db.add(source)
    test_db.commit()
    test_db.refresh(source)
    return source


def _create_listing(
    test_client,
    test_token: str,
    *,
    source_id: int,
    name: str = "doc-summary",
):
    return test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "skill",
            "source_id": source_id,
            "name": name,
            "display_name": "Doc Summary",
            "description": "Summarizes documents",
            "tags": ["docs"],
            "version": "1.0.0",
            "manifest_options": {
                "manifest": {"client_supplied": True},
            },
        },
    )


def test_create_and_list_resource_library_listing(
    test_client,
    test_db,
    test_user,
    test_token,
):
    source = _create_kind(test_db, user_id=test_user.id)
    create_response = _create_listing(
        test_client,
        test_token,
        source_id=source.id,
    )

    assert create_response.status_code == 201
    listing_id = create_response.json()["id"]
    version = test_db.get(
        ResourceLibraryVersion, create_response.json()["current_version_id"]
    )
    assert version.source_kind_id == source.id
    assert version.source_binary_id is None
    assert version.manifest == {
        "resource_type": "skill",
        "skill": source.json,
        "source": {
            "binary_id": None,
            "kind_id": source.id,
            "name": "doc-summary",
            "namespace": "default",
        },
    }
    assert "client_supplied" not in version.manifest

    list_response = test_client.get(
        "/api/resource-library/listings?resource_type=skill&keyword=summary",
        headers=auth_headers(test_token),
    )

    assert list_response.status_code == 200
    body = list_response.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == listing_id


def test_get_resource_library_listing(test_client, test_db, test_user, test_token):
    source = _create_kind(test_db, user_id=test_user.id)
    create_response = _create_listing(
        test_client,
        test_token,
        source_id=source.id,
    )
    listing_id = create_response.json()["id"]

    get_response = test_client.get(
        f"/api/resource-library/listings/{listing_id}",
        headers=auth_headers(test_token),
    )

    assert get_response.status_code == 200
    assert get_response.json()["id"] == listing_id


def test_archive_resource_library_listing(test_client, test_db, test_user, test_token):
    source = _create_kind(test_db, user_id=test_user.id)
    create_response = _create_listing(
        test_client,
        test_token,
        source_id=source.id,
    )
    listing_id = create_response.json()["id"]

    archive_response = test_client.post(
        f"/api/resource-library/listings/{listing_id}/archive",
        headers=auth_headers(test_token),
    )
    legacy_delete_response = test_client.delete(
        f"/api/resource-library/listings/{listing_id}",
        headers=auth_headers(test_token),
    )
    list_response = test_client.get(
        "/api/resource-library/listings?resource_type=skill&keyword=summary",
        headers=auth_headers(test_token),
    )

    assert archive_response.status_code == 200
    assert archive_response.json()["status"] == "archived"
    assert legacy_delete_response.status_code == 405
    assert list_response.status_code == 200
    assert list_response.json()["total"] == 0
