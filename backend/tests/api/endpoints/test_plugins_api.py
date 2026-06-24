# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.services.installed_plugin_service import installed_plugin_service


def _plugin_zip(name: str = "superpowers", version: str = "1.0.0") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            ".claude-plugin/plugin.json",
            json.dumps(
                {
                    "name": name,
                    "displayName": "Superpowers",
                    "description": "System plugin",
                    "version": version,
                }
            ),
        )
        archive.writestr("commands/test.md", "# Test")
    return buffer.getvalue()


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_user_can_install_and_manually_update_system_plugin(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user,
):
    claudecode_plugin = installed_plugin_service.upload_system_plugin(
        db=test_db,
        package_bytes=_plugin_zip(version="1.0.0"),
        filename="superpowers-1.0.0.zip",
        runtime="claudecode",
    )
    codex_plugin = installed_plugin_service.upload_system_plugin(
        db=test_db,
        package_bytes=_plugin_zip(version="1.0.0"),
        filename="superpowers-codex-1.0.0.zip",
        runtime="codex",
    )
    system_plugin_id = int(claudecode_plugin.metadata["labels"]["id"])
    codex_plugin_id = int(codex_plugin.metadata["labels"]["id"])

    catalog_response = test_client.get(
        "/api/plugins/catalog",
        headers=_auth_headers(test_token),
    )
    assert catalog_response.status_code == 200
    assert catalog_response.json()["items"][0]["installState"] == "not_installed"
    assert catalog_response.json()["items"][0]["variantIds"] == {
        "claudecode": system_plugin_id,
        "codex": codex_plugin_id,
    }

    install_response = test_client.post(
        f"/api/plugins/catalog/{system_plugin_id}/install",
        headers=_auth_headers(test_token),
    )
    assert install_response.status_code == 201
    installed_items = install_response.json()["items"]
    assert {item["spec"]["runtime"] for item in installed_items} == {
        "claudecode",
        "codex",
    }
    installed_by_runtime = {
        item["spec"]["runtime"]: int(item["metadata"]["labels"]["id"])
        for item in installed_items
    }
    installed_id = installed_by_runtime["claudecode"]

    installed_package = installed_plugin_service.package_data_for_download(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed_id,
    )
    assert installed_package[1] == "superpowers-1.0.0.zip"

    installed_plugin_service.replace_system_plugin_package(
        db=test_db,
        system_plugin_id=system_plugin_id,
        package_bytes=_plugin_zip(version="2.0.0"),
        filename="superpowers-2.0.0.zip",
    )
    installed_plugin_service.replace_system_plugin_package(
        db=test_db,
        system_plugin_id=codex_plugin_id,
        package_bytes=_plugin_zip(version="2.0.0"),
        filename="superpowers-codex-2.0.0.zip",
    )

    catalog_response = test_client.get(
        "/api/plugins/catalog",
        headers=_auth_headers(test_token),
    )
    catalog_item = catalog_response.json()["items"][0]
    assert catalog_item["installState"] == "update_available"
    assert catalog_item["installedPluginId"] == installed_id

    update_response = test_client.post(
        f"/api/plugins/catalog/{system_plugin_id}/update",
        headers=_auth_headers(test_token),
    )
    assert update_response.status_code == 200
    assert all(
        item["spec"]["version"] == "2.0.0" for item in update_response.json()["items"]
    )

    updated_package = installed_plugin_service.package_data_for_download(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed_id,
    )
    assert updated_package[1] == "superpowers-2.0.0.zip"


def test_admin_can_manage_system_plugin_catalog(
    test_client: TestClient,
    test_admin_token: str,
):
    upload_response = test_client.post(
        "/api/admin/plugins",
        headers=_auth_headers(test_admin_token),
        files={"file": ("superpowers.zip", _plugin_zip(), "application/zip")},
        data={"enabled": "true"},
    )
    assert upload_response.status_code == 201
    plugin_id = int(upload_response.json()["metadata"]["labels"]["id"])

    update_response = test_client.put(
        f"/api/admin/plugins/{plugin_id}",
        headers=_auth_headers(test_admin_token),
        json={
            "displayName": "Managed Plugin",
            "description": "Visible in Wework",
            "enabled": False,
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["spec"]["displayName"] == "Managed Plugin"
    assert update_response.json()["spec"]["enabled"] is False

    list_response = test_client.get(
        "/api/admin/plugins",
        headers=_auth_headers(test_admin_token),
    )
    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1

    replace_response = test_client.put(
        f"/api/admin/plugins/{plugin_id}/package",
        headers=_auth_headers(test_admin_token),
        files={
            "file": (
                "superpowers-2.0.0.zip",
                _plugin_zip(version="2.0.0"),
                "application/zip",
            )
        },
    )
    assert replace_response.status_code == 200
    assert replace_response.json()["spec"]["version"] == "2.0.0"
