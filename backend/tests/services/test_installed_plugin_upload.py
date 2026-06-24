# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile

import pytest
from fastapi import HTTPException

from app.api.endpoints.installed_plugins import _read_plugin_upload
from app.models.skill_binary import SkillBinary
from app.services.claude_plugin_parser import MAX_PLUGIN_PACKAGE_SIZE_BYTES
from app.services.installed_plugin_service import InstalledPluginService


class ChunkedUpload:
    def __init__(self, chunks: list[bytes]):
        self._chunks = chunks

    async def read(self, _size: int) -> bytes:
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


def _create_plugin_zip(name: str = "superpowers", version: str = "1.0.0") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            ".claude-plugin/plugin.json",
            json.dumps(
                {
                    "name": name,
                    "displayName": "Superpowers",
                    "description": "Test plugin",
                    "version": version,
                }
            ),
        )
        archive.writestr("commands/test.md", "# Test")
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_read_plugin_upload_rejects_before_buffering_past_limit():
    upload = ChunkedUpload([b"a" * MAX_PLUGIN_PACKAGE_SIZE_BYTES, b"b"])

    with pytest.raises(HTTPException) as exc_info:
        await _read_plugin_upload(upload)  # type: ignore[arg-type]

    assert exc_info.value.status_code == 413


def test_safe_kind_name_uses_hash_suffix_to_avoid_slug_collisions():
    service = InstalledPluginService()

    assert service._safe_kind_name("my/plugin") != service._safe_kind_name("my plugin")
    assert len(service._safe_kind_name("x" * 200)) <= 100


def test_upload_plugin_stores_package_in_database(test_db, test_user):
    service = InstalledPluginService()
    package_bytes = _create_plugin_zip()

    installed = service.upload_plugin(
        db=test_db,
        user_id=test_user.id,
        package_bytes=package_bytes,
        filename="superpowers.zip",
    )
    installed_id = int(installed.metadata["labels"]["id"])

    package = (
        test_db.query(SkillBinary).filter(SkillBinary.kind_id == installed_id).first()
    )
    assert package is not None
    assert package.binary_data == package_bytes
    assert package.file_name == "superpowers.zip"
    assert package.type == "plugin"

    downloaded_bytes, filename = service.package_data_for_download(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed_id,
    )
    assert downloaded_bytes == package_bytes
    assert filename == "superpowers.zip"


def test_system_plugin_catalog_install_and_manual_update_flow(test_db, test_user):
    service = InstalledPluginService()
    package_v1 = _create_plugin_zip(version="1.0.0")
    package_v2 = _create_plugin_zip(version="2.0.0")

    claudecode_plugin = service.upload_system_plugin(
        db=test_db,
        package_bytes=package_v1,
        filename="superpowers-1.0.0.zip",
        enabled=True,
        runtime="claudecode",
    )
    codex_plugin = service.upload_system_plugin(
        db=test_db,
        package_bytes=package_v1,
        filename="superpowers-codex-1.0.0.zip",
        enabled=True,
        runtime="codex",
    )
    claudecode_plugin_id = int(claudecode_plugin.metadata["labels"]["id"])
    codex_plugin_id = int(codex_plugin.metadata["labels"]["id"])

    catalog = service.list_system_plugin_catalog(db=test_db, user_id=test_user.id)
    assert len(catalog.items) == 1
    catalog_item = catalog.items[0]
    assert catalog_item.id == claudecode_plugin_id
    assert catalog_item.variantIds == {
        "claudecode": claudecode_plugin_id,
        "codex": codex_plugin_id,
    }
    assert catalog_item.installState == "not_installed"
    assert catalog_item.installedPluginId is None

    installed_response = service.install_system_plugin(
        db=test_db,
        user_id=test_user.id,
        system_plugin_id=claudecode_plugin_id,
    )
    assert len(installed_response.items) == 2
    installed_by_runtime = {
        item.spec.runtime: int(item.metadata["labels"]["id"])
        for item in installed_response.items
    }
    installed_id = installed_by_runtime["claudecode"]
    codex_installed_id = installed_by_runtime["codex"]

    catalog = service.list_system_plugin_catalog(db=test_db, user_id=test_user.id)
    assert catalog.items[0].installState == "installed"
    assert catalog.items[0].installedPluginId == installed_id
    assert catalog.items[0].installedPluginIds == {
        "claudecode": installed_id,
        "codex": codex_installed_id,
    }

    service.update_system_plugin_metadata(
        db=test_db,
        system_plugin_id=claudecode_plugin_id,
        display_name="Curated Superpowers",
        description="Reviewed by admin",
    )

    service.replace_system_plugin_package(
        db=test_db,
        system_plugin_id=claudecode_plugin_id,
        package_bytes=package_v2,
        filename="superpowers-2.0.0.zip",
    )
    service.replace_system_plugin_package(
        db=test_db,
        system_plugin_id=codex_plugin_id,
        package_bytes=package_v2,
        filename="superpowers-codex-2.0.0.zip",
    )

    catalog = service.list_system_plugin_catalog(db=test_db, user_id=test_user.id)
    assert catalog.items[0].installState == "update_available"
    assert catalog.items[0].version == "2.0.0"
    assert catalog.items[0].displayName == "Curated Superpowers"
    assert catalog.items[0].description == "Reviewed by admin"

    downloaded_bytes, filename = service.package_data_for_download(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed_id,
    )
    assert downloaded_bytes == package_v1
    assert filename == "superpowers-1.0.0.zip"

    updated_response = service.update_installed_plugin_from_system(
        db=test_db,
        user_id=test_user.id,
        system_plugin_id=claudecode_plugin_id,
    )
    assert {item.spec.runtime for item in updated_response.items} == {
        "claudecode",
        "codex",
    }
    assert all(item.spec.version == "2.0.0" for item in updated_response.items)

    downloaded_bytes, filename = service.package_data_for_download(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed_id,
    )
    assert downloaded_bytes == package_v2
    assert filename == "superpowers-2.0.0.zip"


def test_disabled_system_plugin_is_hidden_from_user_catalog(test_db, test_user):
    service = InstalledPluginService()
    system_plugin = service.upload_system_plugin(
        db=test_db,
        package_bytes=_create_plugin_zip(),
        filename="superpowers.zip",
        enabled=True,
        runtime="claudecode",
    )
    system_plugin_id = int(system_plugin.metadata["labels"]["id"])

    service.update_system_plugin_metadata(
        db=test_db,
        system_plugin_id=system_plugin_id,
        display_name="Internal Only",
        description="Hidden from users",
        enabled=False,
    )

    catalog = service.list_system_plugin_catalog(db=test_db, user_id=test_user.id)

    assert catalog.items == []
