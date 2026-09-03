# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import importlib.util
import json
import sys
import zipfile
from io import BytesIO
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest


def _load_script() -> ModuleType:
    path = Path(__file__).resolve().parents[2] / "scripts/test_plugin_release.py"
    spec = importlib.util.spec_from_file_location("test_plugin_release_script", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


SCRIPT = _load_script()


def _package() -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "release-smoke-test",
                    "version": "1.2.3",
                    "description": "Release smoke test",
                }
            ),
        )
    return output.getvalue()


def _metadata(package: bytes) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "changed": True,
        "plugin": {
            "slug": "release-smoke-test",
            "version": "1.2.3",
            "listingType": "plugin",
        },
        "artifact": {
            "file": "plugin.zip",
            "sha256": hashlib.sha256(package).hexdigest(),
            "sizeBytes": len(package),
        },
        "source": {
            "projectId": "42",
            "ref": "master",
            "sourceCommitSha": "a" * 40,
            "pipelineId": 99,
            "pipelineUrl": "https://git.example/pipelines/99",
            "metadata": {"projectPath": "wework/plugins"},
        },
    }


def _artifact_files(tmp_path: Path) -> tuple[Path, Path]:
    package = _package()
    package_path = tmp_path / "plugin.zip"
    metadata_path = tmp_path / "release.json"
    package_path.write_bytes(package)
    metadata_path.write_text(json.dumps(_metadata(package)), encoding="utf-8")
    return metadata_path, package_path


def test_preflight_validates_artifact_and_derives_idempotency_key(
    tmp_path: Path,
) -> None:
    metadata_path, package_path = _artifact_files(tmp_path)

    result = SCRIPT.load_release_artifact(metadata_path, package_path)

    assert result.metadata.plugin.slug == "release-smoke-test"
    assert result.idempotency_key.startswith("wework-plugin-v1:")
    assert len(result.idempotency_key) == 81
    assert len(result.complete_tree_sha256) == 64


def test_preflight_rejects_artifact_hash_mismatch(tmp_path: Path) -> None:
    metadata_path, package_path = _artifact_files(tmp_path)
    package_path.write_bytes(package_path.read_bytes() + b"tampered")

    with pytest.raises(
        SCRIPT.ReleaseSmokeTestError,
        match="Package SHA256 does not match",
    ):
        SCRIPT.load_release_artifact(metadata_path, package_path)


def test_publish_and_marketplace_verification(tmp_path: Path) -> None:
    metadata_path, package_path = _artifact_files(tmp_path)
    preflight = SCRIPT.load_release_artifact(metadata_path, package_path)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == SCRIPT.RELEASE_PATH:
            assert request.headers["authorization"] == "Bearer wg-secret"
            assert request.headers["idempotency-key"] == preflight.idempotency_key
            return httpx.Response(
                200,
                json={
                    "pluginId": 21,
                    "releaseId": 34,
                    "created": True,
                    "catalogNamespace": "enterprise",
                    "slug": "release-smoke-test",
                    "version": "1.2.3",
                    "sha256": preflight.metadata.artifact.sha256,
                },
            )
        assert request.url.path == "/api/plugins/marketplace"
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": 21,
                        "catalogNamespace": "enterprise",
                        "version": "1.2.3",
                        "latestReleaseId": 34,
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    result = SCRIPT.publish_release(
        preflight,
        endpoint="https://wegent.example/api/internal/plugins/releases",
        token="wg-secret",
        timeout_seconds=5,
        transport=transport,
    )
    SCRIPT.verify_marketplace(
        result,
        endpoint="https://wegent.example/api/internal/plugins/releases",
        timeout_seconds=5,
        transport=transport,
    )

    assert result.pluginId == 21
    assert result.releaseId == 34


def test_endpoint_requires_exact_release_path_and_https() -> None:
    assert (
        SCRIPT.validate_endpoint(
            "https://wegent.example/api/internal/plugins/releases/",
            allow_http=False,
        )
        == "https://wegent.example/api/internal/plugins/releases"
    )
    with pytest.raises(SCRIPT.ReleaseSmokeTestError, match="absolute HTTPS"):
        SCRIPT.validate_endpoint(
            "http://wegent.example/api/internal/plugins/releases",
            allow_http=False,
        )


def test_release_ref_rejects_merge_request_artifact(tmp_path: Path) -> None:
    metadata_path, package_path = _artifact_files(tmp_path)
    raw_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    raw_metadata["source"]["ref"] = "wework/publication-1-r10"
    metadata_path.write_text(json.dumps(raw_metadata), encoding="utf-8")
    preflight = SCRIPT.load_release_artifact(metadata_path, package_path)

    with pytest.raises(
        SCRIPT.ReleaseSmokeTestError,
        match="post-merge push pipeline",
    ):
        SCRIPT.validate_release_ref(preflight.metadata, "master")


def test_rendered_curl_is_copyable_and_keeps_token_redacted(tmp_path: Path) -> None:
    metadata_path, package_path = _artifact_files(tmp_path)

    command = SCRIPT.render_curl(
        endpoint="https://wegent.example/api/internal/plugins/releases",
        metadata_path=metadata_path,
        package_path=package_path,
        package_filename="plugin.zip",
        idempotency_key="wework-plugin-v1:" + "a" * 64,
        token_env="WEWORK_PLUGIN_RELEASE_TOKEN",
    )

    assert "\n+  " not in command
    assert "${WEWORK_PLUGIN_RELEASE_TOKEN}" in command
    assert "filename=plugin.zip" in command
    assert "wg-secret" not in command


def test_preflight_cli_does_not_require_release_endpoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    metadata_path, package_path = _artifact_files(tmp_path)
    monkeypatch.delenv("WEWORK_PLUGIN_RELEASE_URL", raising=False)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "test_plugin_release.py",
            "--metadata",
            str(metadata_path),
            "--package",
            str(package_path),
        ],
    )

    assert SCRIPT.main() == 0
    output = capsys.readouterr().out
    assert "Preflight passed" in output
    assert "curl generation was skipped" in output
