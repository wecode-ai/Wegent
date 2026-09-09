"""Prebuilt native plugin publication preserves exact verified artifact bytes."""

import hashlib
import io
import json
import stat
import zipfile
from unittest.mock import Mock

import pytest

from app.services.official_plugin_publisher import OfficialPluginPublisher
from app.services.plugin_package_scanner import PluginPackageScanError


def archive_file(tmp_path, extra_name="scripts/native/tool"):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps({"name": "native-fixture", "version": "1.0.0"}),
        )
        binary = zipfile.ZipInfo(extra_name)
        binary.external_attr = (stat.S_IFREG | 0o755) << 16
        archive.writestr(binary, b"synthetic-native-binary\0")
    path = tmp_path / "plugin.zip"
    path.write_bytes(output.getvalue())
    return path, hashlib.sha256(output.getvalue()).hexdigest()


def test_prebuilt_artifact_is_scanned_and_published_without_repacking(tmp_path):
    archive, digest = archive_file(tmp_path)
    marketplace = Mock()
    publisher = OfficialPluginPublisher(marketplace_service=marketplace)
    built = publisher.load_archive(archive, expected_sha256=digest)
    assert built.package == archive.read_bytes()
    assert built.sha256 == digest
    assert built.scan_report["executablePaths"] == ["scripts/native/tool"]
    db = Mock()
    publisher.publish_package(db, built=built)
    assert (
        marketplace.publish_official_release.call_args.kwargs["package"]
        == archive.read_bytes()
    )


@pytest.mark.parametrize("digest", ["", "invalid", "a" * 64])
def test_prebuilt_requires_a_matching_digest(tmp_path, digest):
    archive, _ = archive_file(tmp_path)
    with pytest.raises(ValueError, match="SHA-256"):
        OfficialPluginPublisher().load_archive(archive, expected_sha256=digest)


@pytest.mark.parametrize("name", ["../escape", "credentials.json"])
def test_prebuilt_does_not_bypass_package_safety(tmp_path, name):
    archive, digest = archive_file(tmp_path, name)
    with pytest.raises(PluginPackageScanError):
        OfficialPluginPublisher().load_archive(archive, expected_sha256=digest)
