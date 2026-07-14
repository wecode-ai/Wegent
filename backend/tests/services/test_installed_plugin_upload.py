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


def _create_plugin_zip(
    name: str = "superpowers", manifest_dir: str = ".claude-plugin"
) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            f"{manifest_dir}/plugin.json",
            json.dumps(
                {
                    "name": name,
                    "displayName": "Superpowers",
                    "description": "Test plugin",
                    "version": "1.0.0",
                    "interface": {
                        "displayName": "Superpowers",
                        "shortDescription": "Codex test plugin",
                        "brandColor": "#7c3aed",
                    },
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


def test_upload_plugin_accepts_codex_plugin_manifest(test_db, test_user):
    service = InstalledPluginService()
    package_bytes = _create_plugin_zip(manifest_dir=".codex-plugin")

    installed = service.upload_plugin(
        db=test_db,
        user_id=test_user.id,
        package_bytes=package_bytes,
        filename="superpowers.zip",
    )

    assert installed.spec.source.providerKey == "codex-local"
    assert installed.spec.displayName == "Superpowers"
    assert installed.spec.interface is not None
    assert installed.spec.interface.shortDescription == "Codex test plugin"


def test_publish_and_install_marketplace_plugin(test_db, test_user):
    service = InstalledPluginService()
    package_bytes = _create_plugin_zip(manifest_dir=".codex-plugin")

    item = service.publish_marketplace_plugin(
        db=test_db,
        user_id=test_user.id,
        package_bytes=package_bytes,
        filename="superpowers.zip",
        visibility="workspace",
    )
    listed = service.list_marketplace_plugins(db=test_db, user_id=test_user.id)

    assert listed.items[0].id == item.id
    assert listed.items[0].installed is False

    installed = service.install_marketplace_plugin(
        db=test_db,
        user_id=test_user.id,
        marketplace_id=item.id,
    )
    relisted = service.list_marketplace_plugins(db=test_db, user_id=test_user.id)

    assert installed.spec.source.type == "marketplace"
    assert installed.spec.source.catalogItemId == str(item.id)
    assert relisted.items[0].installed is True
