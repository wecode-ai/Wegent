# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest

from app.services.official_smart_app_publisher import official_smart_app_publisher
from app.services.smart_app_marketplace_service import smart_app_marketplace_service


def _source(tmp_path, *, version: str = "1.0.0"):
    source = tmp_path / "official-app"
    source.mkdir()
    (source / "plugin-manifest.json").write_text(
        json.dumps(
            {
                "name": "official-research",
                "displayName": "Official Research",
                "version": version,
                "type": "deepseek-harness-plugin-bundle",
                "description": "Official research workspace",
                "entry": {
                    "installPackage": "bundle",
                    "profile": "research",
                },
                "requirements": {"dsh": "0.1.0", "node": ">=22"},
            }
        ),
        encoding="utf-8",
    )
    (source / "bundle").mkdir()
    (source / "bundle" / "cordis.patch.yml").write_text(
        "plugins: []\n", encoding="utf-8"
    )
    (source / "icon.png").write_bytes(b"png")
    (source / "smart-app-marketplace.json").write_text(
        json.dumps(
            {
                "summary": "Official research workspace",
                "descriptionMd": "# Official Research",
                "tags": ["data_analysis"],
                "icon": "icon.png",
                "extensions": {
                    "schemaVersion": 2,
                    "com.weibo.internal": {"businessOwner": "platform"},
                },
                "releaseExtensions": {"com.weibo.build": {"pipeline": "official"}},
            }
        ),
        encoding="utf-8",
    )
    return source


def test_official_package_is_deterministic(tmp_path):
    source = _source(tmp_path)

    first = official_smart_app_publisher.build_package(source)
    second = official_smart_app_publisher.build_package(source)

    assert first.package == second.package
    assert first.sha256 == second.sha256
    assert first.metadata["extensions"]["schemaVersion"] == 2
    assert first.metadata["releaseExtensions"]["com.weibo.build"] == {
        "pipeline": "official"
    }


def test_official_package_rejects_invalid_version(tmp_path):
    source = _source(tmp_path, version="latest")

    with pytest.raises(Exception, match="SemVer"):
        official_smart_app_publisher.build_package(source)


def test_official_publication_forwards_application_and_release_extensions(
    tmp_path, monkeypatch
):
    built = official_smart_app_publisher.build_package(_source(tmp_path))
    captured = {}

    def publish_official_package(db, **kwargs):
        captured.update(kwargs)
        return object(), object(), True

    monkeypatch.setattr(
        smart_app_marketplace_service,
        "publish_official_package",
        publish_official_package,
    )

    official_smart_app_publisher.publish_package(object(), built=built)

    assert captured["extensions"] == built.metadata["extensions"]
    assert captured["release_extensions"] == built.metadata["releaseExtensions"]
