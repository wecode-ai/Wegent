from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from hashlib import sha256
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from minio.error import S3Error

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from minio_component_assets import (  # noqa: E402
    MANAGED_COMPONENT_IDS,
    component_channel_is_complete,
    load_component_release,
    publish_component_archives,
    publish_immutable_file,
)


def load_script(name: str) -> ModuleType:
    path = SCRIPT_DIR / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeClient:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_object(
        self,
        _bucket: str,
        object_name: str,
        content,
        length: int,
        **_kwargs,
    ) -> None:
        self.objects[object_name] = content.read(length)

    def get_object(self, _bucket: str, object_name: str):
        if object_name not in self.objects:
            raise S3Error(
                None,
                "NoSuchKey",
                "missing",
                object_name,
                "request-id",
                "host-id",
            )
        return FakeResponse(self.objects[object_name])

    def stat_object(self, _bucket: str, object_name: str):
        if object_name not in self.objects:
            raise S3Error(
                None,
                "NoSuchKey",
                "missing",
                object_name,
                "request-id",
                "host-id",
            )
        return SimpleNamespace(size=len(self.objects[object_name]))


class FakeResponse:
    def __init__(self, content: bytes) -> None:
        self.content = content
        self.offset = 0

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self.content) - self.offset
        chunk = self.content[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self) -> None:
        pass

    def release_conn(self) -> None:
        pass


def test_mac_legacy_manifest_uses_platform_defaults_only(monkeypatch) -> None:
    module = load_script("upload-mac-release-to-s3.py")
    client = FakeClient()
    arm_entry = {"signature": "arm-signature", "url": "https://example.com/arm"}
    x64_entry = {"signature": "x64-signature", "url": "https://example.com/x64"}
    arm_manifest = {
        "version": "1.2.3",
        "platforms": {"darwin-aarch64": arm_entry},
    }
    x64_manifest = {
        "version": "1.2.3",
        "platforms": {"darwin-x86_64": x64_entry},
    }
    client.objects["wework/macos-arm/latest.json"] = json.dumps(arm_manifest).encode()
    client.objects["wework/macos-x64/latest.json"] = json.dumps(x64_manifest).encode()
    client.objects["wework/macos/stable-darwin-aarch64.json"] = json.dumps(
        {"version": "1.2.3", "platforms": {"stable-darwin": arm_entry}}
    ).encode()
    client.objects["wework/macos/stable-darwin-x86_64.json"] = json.dumps(
        {"version": "1.2.3", "platforms": {"stable-darwin": x64_entry}}
    ).encode()
    monkeypatch.setenv("WEWORK_MAC_ARM64_RELEASE_S3_PREFIX", "wework/macos-arm")
    monkeypatch.setenv("WEWORK_MAC_X64_RELEASE_S3_PREFIX", "wework/macos-x64")
    monkeypatch.setenv("WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX", "wework/macos")

    module.publish_legacy_manifest(client, "releases", "1.2.3", "wework/macos")
    published = json.loads(client.objects["wework/macos/latest.json"])
    assert published["platforms"] == {
        "darwin-aarch64": arm_entry,
        "darwin-x86_64": x64_entry,
    }


def test_mac_legacy_manifest_requires_both_stable_channel_manifests(
    monkeypatch,
) -> None:
    module = load_script("upload-mac-release-to-s3.py")
    client = FakeClient()
    entry = {"signature": "signature", "url": "https://example.com/release"}
    manifest = {"version": "1.2.3", "platforms": {"darwin-aarch64": entry}}
    client.objects["wework/macos-arm/latest.json"] = json.dumps(manifest).encode()
    client.objects["wework/macos-x64/latest.json"] = json.dumps(
        {
            "version": "1.2.3",
            "platforms": {"darwin-x86_64": entry},
        }
    ).encode()
    client.objects["wework/macos/stable-darwin-aarch64.json"] = json.dumps(
        {"version": "1.2.3", "platforms": {"stable-darwin": entry}}
    ).encode()
    client.objects["wework/macos/stable-darwin-x86_64.json"] = json.dumps(
        {"version": "1.2.3", "platforms": {}}
    ).encode()
    monkeypatch.setenv("WEWORK_MAC_ARM64_RELEASE_S3_PREFIX", "wework/macos-arm")
    monkeypatch.setenv("WEWORK_MAC_X64_RELEASE_S3_PREFIX", "wework/macos-x64")

    with pytest.raises(SystemExit, match="stable channel manifest"):
        module.publish_legacy_manifest(client, "releases", "1.2.3", "wework/macos")


def test_windows_stable_manifest_bootstraps_channel_targets(tmp_path: Path) -> None:
    module = load_script("upload-windows-release-to-s3.py")
    client = FakeClient()
    entry = {"signature": "windows-signature", "url": "https://example.com/windows"}
    manifest_path = tmp_path / "latest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "version": "1.2.3",
                "platforms": {"windows-x86_64": entry},
            }
        ),
        encoding="utf-8",
    )

    module.publish_stable_bootstrap_manifest(
        client,
        "releases",
        "wework/windows",
        manifest_path,
    )

    published = json.loads(client.objects["wework/windows/latest.json"])
    assert published["platforms"]["windows-x86_64"] == entry
    assert published["platforms"]["stable-windows"] == entry
    assert published["platforms"]["beta-windows"] == entry


def test_stable_versions_sort_after_beta_versions() -> None:
    for script in (
        "upload-mac-release-to-s3.py",
        "upload-windows-release-to-s3.py",
    ):
        module = load_script(script)
        assert module.version_parts("1.2.3") > module.version_parts("1.2.3-beta.2")
        assert module.version_parts("1.2.3-beta.2") > module.version_parts(
            "1.2.3-beta.1"
        )


@pytest.mark.parametrize(
    "script_name",
    ["upload-mac-release-to-s3.py", "upload-windows-release-to-s3.py"],
)
def test_rolling_channels_never_move_backwards(
    script_name: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "stable-platform.json"
    path.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    client.objects["wework/stable-platform.json"] = json.dumps(
        {"version": "1.2.4"}
    ).encode()

    assert not module.release_advances_channel(
        client,
        "releases",
        "wework",
        path,
    )


@pytest.mark.parametrize(
    "script_name",
    ["upload-mac-release-to-s3.py", "upload-windows-release-to-s3.py"],
)
def test_equal_incomplete_channels_are_repaired(
    script_name: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "beta-platform.json"
    path.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    client.objects["wework/beta-platform.json"] = json.dumps(
        {"version": "1.2.3"}
    ).encode()

    assert module.release_advances_channel(
        client,
        "releases",
        "wework",
        path,
        complete=False,
    )


@pytest.mark.parametrize(
    "script_name",
    ["upload-mac-release-to-s3.py", "upload-windows-release-to-s3.py"],
)
def test_complete_same_version_rolling_channels_are_reused(
    script_name: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "beta-platform.json"
    path.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    client.objects["wework/beta-platform.json"] = json.dumps(
        {"version": "1.2.3"}
    ).encode()

    assert not module.release_advances_channel(
        client,
        "releases",
        "wework",
        path,
        complete=True,
    )


@pytest.mark.parametrize(
    "script_name",
    ["upload-mac-release-to-s3.py", "upload-windows-release-to-s3.py"],
)
def test_newer_incomplete_channels_fail(
    script_name: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "beta-platform.json"
    path.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    client.objects["wework/beta-platform.json"] = json.dumps(
        {"version": "1.2.4"}
    ).encode()

    with pytest.raises(SystemExit, match="Newer release channel"):
        module.release_advances_channel(
            client,
            "releases",
            "wework",
            path,
            complete=False,
        )


def write_component_release(
    tmp_path: Path,
    version: str = "1.2.3",
    channel: str = "beta",
    platform: str = "macos",
    arch: str = "arm64",
) -> None:
    source_components = {}
    rolling_components = {}
    for component_id in MANAGED_COMPONENT_IDS:
        content = f"{component_id}-{platform}-{arch}".encode()
        archive_sha256 = sha256(content).hexdigest()
        asset_name = (
            f"WeworkComponent_{component_id}_{archive_sha256}_"
            f"{platform}_{arch}.tar.gz"
        )
        (tmp_path / asset_name).write_bytes(content)
        source_components[component_id] = {
            "version": "fixture",
            "contentSha256": sha256(component_id.encode()).hexdigest(),
            "archiveSha256": archive_sha256,
            "assetName": asset_name,
            "entryPath": ".",
        }
        rolling_components[component_id] = {
            "version": "fixture",
            "contentSha256": sha256(component_id.encode()).hexdigest(),
            "archiveSha256": archive_sha256,
            "archiveBytes": len(content),
            "downloadUrl": f"https://minio.example/releases/{asset_name}",
            "entryPath": ".",
        }
    identity = {
        "schemaVersion": 1,
        "appVersion": version,
        "platform": platform,
        "arch": arch,
    }
    (tmp_path / f"components-{platform}-{arch}.json").write_text(
        json.dumps({**identity, "components": source_components}),
        encoding="utf-8",
    )
    (tmp_path / f"components-{channel}-{platform}-{arch}.json").write_text(
        json.dumps(
            {
                **identity,
                "channel": channel,
                "releaseDate": "2026-08-27T00:00:00.000Z",
                "components": rolling_components,
            }
        ),
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    ("script_name", "electron_manifest", "channel_manifest", "platform", "arch"),
    [
        (
            "upload-mac-release-to-s3.py",
            "latest-mac.yml",
            "stable-darwin-aarch64.json",
            "macos",
            "arm64",
        ),
        (
            "upload-windows-release-to-s3.py",
            "latest.yml",
            "stable-windows-x86_64.json",
            "windows",
            "x64",
        ),
    ],
)
def test_channel_repair_publishes_rolling_pointer_last(
    script_name: str,
    electron_manifest: str,
    channel_manifest: str,
    platform: str,
    arch: str,
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    write_component_release(
        tmp_path,
        channel="stable",
        platform=platform,
        arch=arch,
    )
    component_release = load_component_release(
        tmp_path,
        "1.2.3",
        "stable",
        platform,
        arch,
    )
    (tmp_path / channel_manifest).write_text(
        json.dumps({"version": "1.2.3"}),
        encoding="utf-8",
    )
    (tmp_path / electron_manifest).write_text("version: 1.2.3\n", encoding="utf-8")
    client.objects[f"wework/{channel_manifest}"] = json.dumps(
        {"version": "1.2.3"}
    ).encode()
    uploaded = []
    monkeypatch.setattr(
        module,
        "upload_file",
        lambda _client, _bucket, _prefix, path, _cache: uploaded.append(path.name),
    )
    monkeypatch.setattr(
        module,
        "upload_electron_manifest",
        lambda _client, _bucket, _prefix, path: uploaded.append(path.name),
    )
    monkeypatch.setattr(
        module,
        "upload_channel_manifest",
        lambda _client, _bucket, _prefix, path: uploaded.append(path.name),
    )

    if script_name == "upload-mac-release-to-s3.py":
        repaired = module.publish_release_channel(
            client,
            "releases",
            "wework",
            "wework",
            "1.2.3",
            "stable",
            "darwin-aarch64",
            tmp_path,
            component_release,
        )
    else:
        repaired = module.publish_release_channel(
            client,
            "releases",
            "wework",
            "1.2.3",
            "stable",
            tmp_path,
            component_release,
        )

    assert repaired
    assert uploaded == [
        component_release.channel_manifest.name,
        electron_manifest,
        channel_manifest,
    ]


def test_component_release_loads_all_managed_components(tmp_path: Path) -> None:
    write_component_release(tmp_path)

    release = load_component_release(
        tmp_path,
        "1.2.3",
        "beta",
        "macos",
        "arm64",
    )

    assert [asset.component_id for asset in release.assets] == list(
        MANAGED_COMPONENT_IDS
    )


def test_component_archives_are_uploaded_once_and_reused(tmp_path: Path) -> None:
    write_component_release(tmp_path)
    release = load_component_release(
        tmp_path,
        "1.2.3",
        "beta",
        "macos",
        "arm64",
    )
    client = FakeClient()
    uploaded = []

    def upload(path: Path) -> None:
        uploaded.append(path.name)
        client.objects[f"wework/macos/{path.name}"] = path.read_bytes()

    publish_component_archives(
        client,
        "releases",
        "wework/macos",
        release,
        upload,
    )
    publish_component_archives(
        client,
        "releases",
        "wework/macos",
        release,
        upload,
    )

    assert uploaded == [asset.path.name for asset in release.assets]


def test_component_archives_reject_changed_immutable_objects(
    tmp_path: Path,
) -> None:
    write_component_release(tmp_path)
    release = load_component_release(
        tmp_path,
        "1.2.3",
        "beta",
        "macos",
        "arm64",
    )
    client = FakeClient()
    client.objects[f"wework/macos/{release.assets[0].path.name}"] = b"wrong"

    with pytest.raises(SystemExit, match="immutable asset"):
        publish_component_archives(
            client,
            "releases",
            "wework/macos",
            release,
            lambda _path: None,
        )


def test_versioned_release_assets_are_immutable(tmp_path: Path) -> None:
    artifact = tmp_path / "WeWork_1.2.3_macos_arm64.dmg"
    artifact.write_bytes(b"local")
    client = FakeClient()
    client.objects[f"wework/macos/{artifact.name}"] = b"remote"

    with pytest.raises(SystemExit, match="immutable asset"):
        publish_immutable_file(
            client,
            "releases",
            "wework/macos",
            artifact,
            lambda _path: None,
        )


def test_component_channel_requires_manifest_and_all_archives(
    tmp_path: Path,
) -> None:
    write_component_release(tmp_path)
    release = load_component_release(
        tmp_path,
        "1.2.3",
        "beta",
        "macos",
        "arm64",
    )
    client = FakeClient()
    for asset in release.assets:
        client.objects[f"wework/macos/{asset.path.name}"] = asset.path.read_bytes()
    assert not component_channel_is_complete(
        client,
        "releases",
        "wework/macos",
        release,
    )

    client.objects[f"wework/macos/{release.channel_manifest.name}"] = (
        release.channel_manifest.read_bytes()
    )

    assert component_channel_is_complete(
        client,
        "releases",
        "wework/macos",
        release,
    )


def test_minio_macos_build_uses_the_electron_release_and_tauri_bridge() -> None:
    script = (SCRIPT_DIR / "build-minio-mac-release.sh").read_text(encoding="utf-8")

    assert "pnpm --filter wework build:release" in script
    assert "prepare-desktop-release-assets.mjs" in script
    assert "generate-desktop-update-manifests.mjs" in script
    assert 'WEWORK_RELEASE_TARGETS="macos-$arch"' in script
    assert 'WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL"' in script
    assert 'WEWORK_COMPONENT_BASE_URL="$UPDATE_BASE_URL"' in script
    assert 'WEWORK_RUNTIME_TARGET="$MACOS_BUILD_TARGET"' in script
    assert 'WEWORK_BRAND_CONFIG="$BRAND_CONFIG"' in script
    assert 'WEWORK_RELEASE_VERSION="$VERSION"' in script
    assert 'WEWORK_SOURCE_SHA="$SOURCE_SHA"' in script
    assert '"$notes_path" "$SOURCE_SHA"' in script
    assert "WEWORK_NOTARYTOOL_S3_ACCELERATION" in script
    assert "WEWORK_CUSTOM_MACOS_NOTARIZATION" in script
    assert "--resume-signed-app" in script
    assert "package-prebuilt-macos-release.mjs" in script
    assert "verify-minio-component-release.mjs" in script
    assert "wework_configure_internal_updater_key" in script
    assert "sync-desktop-release-version.mjs" not in script
    assert "VERSION_BACKUP_DIR" not in script
    assert "package.json" not in script
    assert "src-tauri" not in script
    assert "pnpm exec tauri build" not in script


def test_minio_windows_build_uses_native_electron_release_and_tauri_bridge() -> None:
    script = (SCRIPT_DIR / "build-minio-windows-release.sh").read_text(encoding="utf-8")

    assert "pnpm --filter wework build:release" in script
    assert "prepare-desktop-release-assets.mjs" in script
    assert "generate-desktop-update-manifests.mjs" in script
    assert "WEWORK_RELEASE_TARGETS=windows-x64" in script
    assert 'WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL"' in script
    assert 'WEWORK_COMPONENT_BASE_URL="$UPDATE_BASE_URL"' in script
    assert 'WEWORK_RUNTIME_TARGET="$WINDOWS_BUILD_TARGET"' in script
    assert 'WEWORK_BRAND_CONFIG="$BRAND_CONFIG"' in script
    assert 'WEWORK_RELEASE_VERSION="$VERSION"' in script
    assert 'WEWORK_SOURCE_SHA="$SOURCE_SHA"' in script
    assert '"$notes_path" "$SOURCE_SHA"' in script
    assert "verify-minio-component-release.mjs" in script
    assert "node -p process.platform" in script
    assert "sync-desktop-release-version.mjs" not in script
    assert "VERSION_BACKUP_DIR" not in script
    assert "package.json" not in script
    assert "cargo-xwin" not in script
    assert "src-tauri" not in script
    assert "pnpm exec tauri build" not in script


@pytest.mark.parametrize(
    "script_name",
    ["upload-mac-release-to-s3.py", "upload-windows-release-to-s3.py"],
)
def test_minio_uploads_electron_manifests_without_runtime_sidecars(
    script_name: str,
) -> None:
    script = (SCRIPT_DIR / script_name).read_text(encoding="utf-8")

    assert "upload_electron_manifest" in script
    assert "publish_runtime_asset_pairs" not in script
    assert "publish_component_archives" in script
    assert "component_channel_is_complete" in script


def test_electron_release_bakes_the_minio_update_base_url() -> None:
    builder = (SCRIPT_DIR.parent / "electron/electron-builder.config.cjs").read_text(
        encoding="utf-8"
    )
    main = (SCRIPT_DIR.parent / "electron/src/main.ts").read_text(encoding="utf-8")

    assert "weworkUpdateBaseUrl: updateBaseUrl" in builder
    assert "packageMetadata.weworkUpdateBaseUrl?.trim()" in main


def test_macos_release_components_are_created_from_the_packaged_app() -> None:
    script = (SCRIPT_DIR / "prepare-desktop-release-assets.mjs").read_text(
        encoding="utf-8"
    )

    assert "arch === 'arm64' ? 'mac-arm64' : 'mac'" in script
    assert (
        "packagedComponentResourcesRoot = join(appPath, 'Contents', 'Resources')"
        in script
    )
    assert "join(packagedComponentResourcesRoot, component.path)" in script


def test_harness_runtime_install_uses_the_requested_target_platform() -> None:
    script = (SCRIPT_DIR / "prepare-harness-runtime.mjs").read_text(encoding="utf-8")

    assert "WEWORK_RUNTIME_TARGET" in script
    assert "dsh-runtime-tar-gzip-v6" in script
    assert "supportedArchitectures" in script
    assert "--ignore-scripts" in script
    assert "prepareTargetSpawnHelpers" in script


@pytest.mark.parametrize(
    ("script_name", "target", "expected"),
    [
        ("prepare-harness-runtime.mjs", "x86_64-apple-darwin", "macos-x64"),
        ("prepare-harness-runtime.mjs", "x86_64-pc-windows-msvc", "windows-x64"),
    ],
)
def test_runtime_preparation_resolves_the_requested_target(
    script_name: str, target: str, expected: str
) -> None:
    environment = os.environ.copy()
    environment["WEWORK_RUNTIME_TARGET"] = target

    result = subprocess.run(
        ["node", str(SCRIPT_DIR / script_name), "--print-runtime-platform"],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )

    assert result.stdout.strip() == expected


def test_minio_release_notes_decode_escaped_newlines() -> None:
    result = subprocess.run(
        [
            "bash",
            "-c",
            """
source "$1"
wework_decode_release_notes '## 更新内容\\n\\n- 修复发布流程\\n- 保留普通文本'
""",
            "bash",
            str(SCRIPT_DIR / "lib/wework-release-notes.sh"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout == "## 更新内容\n\n- 修复发布流程\n- 保留普通文本"


def test_internal_updater_key_exports_private_key_content(tmp_path: Path) -> None:
    key_path = tmp_path / "updater.key"
    key_path.write_text("private-key-content\n", encoding="utf-8")
    key_path.with_suffix(".key.pub").write_text(
        "public-key-content\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            "bash",
            "-c",
            """
source "$1"
wework_configure_internal_updater_key "$2" "$3"
printf '%s\\n%s\\n%s\\n%s\\n%s\\n' \
  "$TAURI_SIGNING_PRIVATE_KEY" \
  "$TAURI_SIGNING_PRIVATE_KEY_PATH" \
  "$TAURI_KEY_PASSWORD" \
  "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
  "$TAURI_UPDATER_PUBKEY"
""",
            "bash",
            str(SCRIPT_DIR / "lib/wework-updater-signing.sh"),
            str(SCRIPT_DIR.parent.parent),
            str(key_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.splitlines() == [
        "private-key-content",
        "",
        "",
        "",
        "public-key-content",
    ]


def test_macos_signing_identity_removes_electron_builder_prefix() -> None:
    result = subprocess.run(
        [
            "bash",
            "-c",
            """
source "$1"
wework_normalize_macos_signing_identity \
  'Developer ID Application: Example Company (TEAMID)'
""",
            "bash",
            str(SCRIPT_DIR / "lib/wework-macos-signing.sh"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout == "Example Company (TEAMID)\n"


def test_macos_hook_build_removes_stale_architecture(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "src-tauri/hook-plugins/codex-code-statistics"
    bundle_bin_dir = tmp_path / "src-tauri/bundled-hooks/codex-code-statistics/bin"
    plugin_dir.mkdir(parents=True)
    (bundle_bin_dir / "macos-aarch64").mkdir(parents=True)
    (bundle_bin_dir / "macos-x86_64").mkdir(parents=True)
    (bundle_bin_dir / "macos-aarch64/stale").touch()
    (bundle_bin_dir / "macos-x86_64/stale").touch()
    build_script = plugin_dir / "build-target.sh"
    build_script.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  aarch64-apple-darwin) platform=macos-aarch64 ;;
  x86_64-apple-darwin) platform=macos-x86_64 ;;
esac
destination="$(cd "$(dirname "$0")/../.." && pwd)/bundled-hooks/codex-code-statistics/bin/$platform"
mkdir -p "$destination"
touch "$destination/codex-code-statistics"
""",
        encoding="utf-8",
    )
    build_script.chmod(0o755)

    subprocess.run(
        [
            "bash",
            "-c",
            """
source "$1"
wework_build_code_statistics_hook "$2" aarch64-apple-darwin
""",
            "bash",
            str(SCRIPT_DIR / "lib/codex-code-statistics.sh"),
            str(tmp_path),
        ],
        check=True,
    )

    assert (bundle_bin_dir / "macos-aarch64/codex-code-statistics").is_file()
    assert not (bundle_bin_dir / "macos-x86_64").exists()
