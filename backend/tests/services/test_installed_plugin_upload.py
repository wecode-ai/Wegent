# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile

import pytest
from fastapi import HTTPException

import app.services.builtin_plugin_service as builtin_plugin_service_module
from app.api.endpoints.installed_plugins import (
    _read_plugin_upload,
    ensure_builtin_plugin_installed,
)
from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.schemas.installed_plugin import BuiltinPluginInstallRequest
from app.services.builtin_plugin_registry import (
    BUILTIN_PLUGIN_OWNER_ID,
    BUILTIN_SITES_PLUGIN_NAME,
    BuiltinPluginDefinition,
)
from app.services.builtin_plugin_service import BuiltinPluginService
from app.services.installed_plugin_service import InstalledPluginService
from app.services.plugin_package_parser import (
    MAX_PLUGIN_PACKAGE_SIZE_BYTES,
    plugin_package_parser,
)


class ChunkedUpload:
    def __init__(self, chunks: list[bytes]):
        self._chunks = chunks

    async def read(self, _size: int) -> bytes:
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


def _create_plugin_zip(
    name: str = "superpowers", manifest_dir: str = ".codex-plugin"
) -> bytes:
    manifest = {
        "name": name,
        "displayName": "Superpowers",
        "description": "Test plugin",
        "version": "1.0.0",
    }
    if manifest_dir == ".codex-plugin":
        manifest["interface"] = {
            "displayName": "Superpowers",
            "shortDescription": "Codex test plugin",
            "brandColor": "#7c3aed",
        }
    else:
        manifest["commands"] = ["./commands/test.md"]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            f"{manifest_dir}/plugin.json",
            json.dumps(manifest),
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
    assert package.binary_data != package_bytes
    assert package.file_name == "superpowers.zip"
    assert package.type == "plugin"
    with zipfile.ZipFile(io.BytesIO(package.binary_data)) as archive:
        assert ".codex-plugin/plugin.json" in archive.namelist()
        assert ".claude-plugin/plugin.json" in archive.namelist()
    assert plugin_package_parser.normalize_package(package.binary_data) == (
        package.binary_data
    )

    downloaded_bytes, filename = service.package_data_for_download(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed_id,
    )
    assert downloaded_bytes == package.binary_data
    assert filename == "superpowers.zip"


def test_upload_plugin_accepts_codex_plugin_manifest(test_db, test_user):
    service = InstalledPluginService()
    package_bytes = _create_plugin_zip()

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


def test_upload_plugin_accepts_claude_plugin_manifest(test_db, test_user):
    service = InstalledPluginService()
    package_bytes = _create_plugin_zip(manifest_dir=".claude-plugin")

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

    assert installed.spec.displayName == "Superpowers"
    assert installed.spec.interface is not None
    assert installed.spec.interface.displayName == "Superpowers"
    assert installed.spec.interface.shortDescription == "Test plugin"
    assert package is not None
    with zipfile.ZipFile(io.BytesIO(package.binary_data)) as archive:
        claude_manifest = json.loads(archive.read(".claude-plugin/plugin.json"))
        codex_manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
        assert claude_manifest["commands"] == ["./commands/test.md"]
        assert "displayName" not in claude_manifest
        assert "commands" not in codex_manifest
        assert codex_manifest["name"] == "superpowers"


def test_upload_plugin_rejects_mismatched_runtime_manifest_names(test_db, test_user):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            '{"name":"codex-name"}',
        )
        archive.writestr(
            ".claude-plugin/plugin.json",
            '{"name":"claude-name"}',
        )

    with pytest.raises(HTTPException) as exc_info:
        InstalledPluginService().upload_plugin(
            db=test_db,
            user_id=test_user.id,
            package_bytes=buffer.getvalue(),
            filename="mismatched.zip",
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == (
        "Codex and Claude Code plugin manifest names must match"
    )


def test_publish_and_install_marketplace_plugin(test_db, test_user):
    service = InstalledPluginService()
    package_bytes = _create_plugin_zip()

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


def test_user_cannot_publish_builtin_plugin_to_marketplace(test_db, test_user):
    service = InstalledPluginService()

    with pytest.raises(HTTPException) as exc_info:
        service.publish_marketplace_plugin(
            db=test_db,
            user_id=test_user.id,
            package_bytes=_create_plugin_zip(name=BUILTIN_SITES_PLUGIN_NAME),
            filename=f"{BUILTIN_SITES_PLUGIN_NAME}.zip",
            visibility="public",
            featured=True,
        )

    assert exc_info.value.status_code == 403
    assert "managed by the Wegent Backend" in exc_info.value.detail
    assert (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "PluginMarketplaceItem",
        )
        .count()
        == 0
    )


def test_system_builtin_publication_forces_public_featured(test_db):
    service = InstalledPluginService()

    item = service.publish_marketplace_plugin(
        db=test_db,
        user_id=BUILTIN_PLUGIN_OWNER_ID,
        package_bytes=_create_plugin_zip(name=BUILTIN_SITES_PLUGIN_NAME),
        filename=f"{BUILTIN_SITES_PLUGIN_NAME}.zip",
        visibility="personal",
        featured=False,
    )

    assert item.ownerUserId == BUILTIN_PLUGIN_OWNER_ID
    assert item.visibility == "public"
    assert item.featured is True


def test_marketplace_install_rejects_legacy_user_published_builtin(
    test_db,
    test_user,
):
    service = InstalledPluginService()
    item = service.publish_marketplace_plugin(
        db=test_db,
        user_id=test_user.id,
        package_bytes=_create_plugin_zip(),
        filename="superpowers.zip",
        visibility="public",
    )
    row = test_db.query(Kind).filter(Kind.id == item.id).one()
    payload = dict(row.json)
    spec = dict(payload["spec"])
    spec["name"] = BUILTIN_SITES_PLUGIN_NAME
    payload["spec"] = spec
    row.json = payload
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        service.install_marketplace_plugin(
            db=test_db,
            user_id=test_user.id,
            marketplace_id=item.id,
        )

    assert exc_info.value.status_code == 404


def test_builtin_plugin_is_published_and_installed_idempotently(
    test_db,
    test_user,
    tmp_path,
):
    legacy_row = Kind(
        user_id=test_user.id,
        kind="PluginMarketplaceItem",
        name="legacy-sites",
        namespace="default",
        json={
            "spec": {
                "name": BUILTIN_SITES_PLUGIN_NAME,
                "visibility": "public",
                "featured": True,
            }
        },
        is_active=True,
    )
    test_db.add(legacy_row)
    test_db.commit()

    plugin_dir = tmp_path / BUILTIN_SITES_PLUGIN_NAME
    manifest_dir = plugin_dir / ".codex-plugin"
    scripts_dir = plugin_dir / "scripts"
    manifest_dir.mkdir(parents=True)
    scripts_dir.mkdir()
    (manifest_dir / "plugin.json").write_text(
        json.dumps(
            {
                "name": BUILTIN_SITES_PLUGIN_NAME,
                "version": "1.0.0",
                "interface": {
                    "displayName": "Sites",
                    "shortDescription": "Build sites",
                },
            }
        ),
        encoding="utf-8",
    )
    executable = scripts_dir / "build.sh"
    executable.write_text("#!/bin/sh\n", encoding="utf-8")
    executable.chmod(0o755)

    builtin_service = BuiltinPluginService()
    published = builtin_service.sync_marketplace_plugins(
        test_db,
        plugins_dir=tmp_path,
    )

    assert len(published) == 1
    assert published[0].name == BUILTIN_SITES_PLUGIN_NAME
    assert published[0].ownerUserId == 0
    assert published[0].visibility == "public"
    assert published[0].featured is True
    test_db.refresh(legacy_row)
    assert legacy_row.is_active is False
    listed = InstalledPluginService().list_marketplace_plugins(
        db=test_db,
        user_id=test_user.id,
    )
    assert [item.name for item in listed.items] == [BUILTIN_SITES_PLUGIN_NAME]

    installed_service = InstalledPluginService()
    first = installed_service.install_builtin_plugin(
        db=test_db,
        user_id=test_user.id,
        plugin_key=BUILTIN_SITES_PLUGIN_NAME,
    )
    second = installed_service.install_builtin_plugin(
        db=test_db,
        user_id=test_user.id,
        plugin_key=BUILTIN_SITES_PLUGIN_NAME,
    )

    assert first.metadata["labels"]["id"] == second.metadata["labels"]["id"]
    assert first.spec.source.providerKey == "wegent-marketplace"
    assert first.spec.source.marketplace == "wegent"
    installed_rows = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "InstalledPlugin",
        )
        .all()
    )
    assert len(installed_rows) == 1

    marketplace_row = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "PluginMarketplaceItem",
        )
        .one()
    )
    package = (
        test_db.query(SkillBinary)
        .filter(SkillBinary.kind_id == marketplace_row.id)
        .one()
    )
    with zipfile.ZipFile(io.BytesIO(package.binary_data)) as archive:
        script_info = archive.getinfo("scripts/build.sh")
        assert stat_mode(script_info.external_attr) == 0o755
        codex_manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
        claude_manifest = json.loads(archive.read(".claude-plugin/plugin.json"))
        assert codex_manifest["interface"]["displayName"] == "Sites"
        assert claude_manifest == {
            "description": "Build sites",
            "name": BUILTIN_SITES_PLUGIN_NAME,
            "version": "1.0.0",
        }


def test_builtin_plugin_sync_skips_when_optional_root_is_missing(test_db, tmp_path):
    missing_root = tmp_path / "missing"

    published = BuiltinPluginService().sync_marketplace_plugins(
        test_db,
        plugins_dir=missing_root,
    )

    assert published == []


def test_builtin_plugin_sync_skips_when_optional_plugin_is_missing(
    test_db,
    tmp_path,
):
    published = BuiltinPluginService().sync_marketplace_plugins(
        test_db,
        plugins_dir=tmp_path,
    )

    assert published == []


def test_builtin_plugin_validation_fails_when_required_manifest_is_missing(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(
        builtin_plugin_service_module,
        "BUILTIN_PLUGINS",
        (
            BuiltinPluginDefinition(
                name=BUILTIN_SITES_PLUGIN_NAME,
                required=True,
            ),
        ),
    )
    (tmp_path / BUILTIN_SITES_PLUGIN_NAME).mkdir()

    with pytest.raises(RuntimeError, match="manifest is missing"):
        BuiltinPluginService().validate_required_plugins(tmp_path)


def test_builtin_plugin_validation_fails_when_manifest_name_does_not_match(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(
        builtin_plugin_service_module,
        "BUILTIN_PLUGINS",
        (
            BuiltinPluginDefinition(
                name=BUILTIN_SITES_PLUGIN_NAME,
                required=True,
            ),
        ),
    )
    manifest_dir = tmp_path / BUILTIN_SITES_PLUGIN_NAME / ".codex-plugin"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "plugin.json").write_text(
        json.dumps({"name": "another-plugin"}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="manifest name"):
        BuiltinPluginService().validate_required_plugins(tmp_path)


def stat_mode(external_attr: int) -> int:
    return (external_attr >> 16) & 0o777


def test_install_builtin_plugin_rejects_missing_system_item(test_db, test_user):
    service = InstalledPluginService()

    with pytest.raises(HTTPException) as exc_info:
        service.install_builtin_plugin(
            db=test_db,
            user_id=test_user.id,
            plugin_key=BUILTIN_SITES_PLUGIN_NAME,
        )

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_ensure_builtin_plugin_waits_for_requested_device_sync(
    test_db,
    test_user,
    monkeypatch,
):
    InstalledPluginService().publish_marketplace_plugin(
        db=test_db,
        user_id=BUILTIN_PLUGIN_OWNER_ID,
        package_bytes=_create_plugin_zip(name=BUILTIN_SITES_PLUGIN_NAME),
        filename=f"{BUILTIN_SITES_PLUGIN_NAME}.zip",
        visibility="public",
        featured=True,
    )
    requested_syncs = []

    async def fake_sync(db, *, user_id, device_id, installed_plugin_id):
        requested_syncs.append((device_id, installed_plugin_id))
        result = DeviceCapabilitySyncResult(
            device_id=device_id,
            success=True,
            plugins=[
                {
                    "id": installed_plugin_id,
                    "name": BUILTIN_SITES_PLUGIN_NAME,
                    "status": "synced",
                }
            ],
        )
        return DeviceCapabilitySyncResponse(
            success=True,
            device_id=device_id,
            mode="merge",
            plugins=result.plugins,
            synced=1,
            results=[result],
        )

    monkeypatch.setattr(
        "app.api.endpoints.installed_plugins.device_capability_sync_service.sync_installed_plugin_to_device",
        fake_sync,
    )

    response = await ensure_builtin_plugin_installed(
        BUILTIN_SITES_PLUGIN_NAME,
        BuiltinPluginInstallRequest(device_id="device-1"),
        db=test_db,
        current_user=test_user,
    )

    assert len(requested_syncs) == 1
    assert requested_syncs[0][0] == "device-1"
    assert requested_syncs[0][1] > 0
    assert response.plugin.spec.source.pluginKey == BUILTIN_SITES_PLUGIN_NAME
    assert response.sync is not None
    assert response.sync.success is True
    assert response.sync.mode == "merge"


@pytest.mark.asyncio
async def test_ensure_builtin_plugin_without_device_syncs_online_devices(
    test_db,
    test_user,
    monkeypatch,
):
    InstalledPluginService().publish_marketplace_plugin(
        db=test_db,
        user_id=BUILTIN_PLUGIN_OWNER_ID,
        package_bytes=_create_plugin_zip(name=BUILTIN_SITES_PLUGIN_NAME),
        filename=f"{BUILTIN_SITES_PLUGIN_NAME}.zip",
        visibility="public",
        featured=True,
    )
    sync_response = DeviceCapabilitySyncResponse(
        success=True,
        device_id="",
        mode="replace",
        synced=0,
        results=[],
    )

    async def fake_sync_global(db, *, user_id, mode="replace"):
        assert db is test_db
        assert user_id == test_user.id
        assert mode == "replace"
        return sync_response

    monkeypatch.setattr(
        "app.api.endpoints.installed_plugins.device_capability_sync_service.sync_user_global_capabilities",
        fake_sync_global,
    )

    response = await ensure_builtin_plugin_installed(
        BUILTIN_SITES_PLUGIN_NAME,
        BuiltinPluginInstallRequest(),
        db=test_db,
        current_user=test_user,
    )

    assert response.plugin.spec.source.pluginKey == BUILTIN_SITES_PLUGIN_NAME
    assert response.sync == sync_response
