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

from minio_release_assets import (  # noqa: E402
    COMPONENT_RELEASE_SCOPES,
    MANAGED_COMPONENT_IDS,
    load_component_assets,
    load_release_artifacts,
    publish_component_assets,
    publish_component_manifest,
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

    def copy_object(self, _bucket: str, object_name: str, source, **_kwargs) -> None:
        self.objects[object_name] = self.objects[source.object_name]


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


def test_windows_latest_installer_uses_canonical_release_name(tmp_path: Path) -> None:
    module = load_script("upload-windows-release-to-s3.py")
    client = FakeClient()
    version = "1.2.3"
    installer = tmp_path / f"WeWork_{version}_windows-x64-setup.exe"
    host_update = tmp_path / f"WeWorkHostUpdate_{version}_windows-x64-setup.exe"
    installer.write_bytes(b"installer")
    host_update.write_bytes(b"host-update")
    client.objects[f"wework/windows/{installer.name}"] = installer.read_bytes()
    client.objects[f"wework/windows/{host_update.name}"] = host_update.read_bytes()

    module.publish_latest_installer(
        client,
        "releases",
        "wework/windows",
        version,
        [host_update, installer],
    )

    assert client.objects["wework/windows/WeWork_latest_windows-x64-setup.exe"] == (
        b"installer"
    )


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
    ("script_name", "version_key"),
    [
        ("upload-mac-release-to-s3.py", "appVersion"),
        ("upload-windows-release-to-s3.py", "version"),
    ],
)
def test_rolling_channels_never_move_backwards(
    script_name: str,
    version_key: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "stable-platform.json"
    path.write_text(json.dumps({version_key: "1.2.3"}), encoding="utf-8")
    client.objects["wework/stable-platform.json"] = json.dumps(
        {version_key: "1.2.4"}
    ).encode()

    assert not module.release_advances_channel(
        client,
        "releases",
        "wework",
        path,
    )


@pytest.mark.parametrize(
    ("script_name", "electron_manifest", "version_key"),
    [
        ("upload-mac-release-to-s3.py", "latest-mac.yml", "appVersion"),
        ("upload-windows-release-to-s3.py", "latest.yml", "version"),
    ],
)
def test_same_version_repairs_incomplete_rolling_channels(
    script_name: str,
    electron_manifest: str,
    version_key: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "stable-platform.json"
    path.write_text(json.dumps({version_key: "1.2.3"}), encoding="utf-8")
    client.objects["wework/stable-platform.json"] = json.dumps(
        {version_key: "1.2.3"}
    ).encode()

    assert module.release_advances_channel(
        client,
        "releases",
        "wework",
        path,
        (("wework", electron_manifest),),
    )


@pytest.mark.parametrize(
    ("script_name", "electron_manifest", "version_key"),
    [
        ("upload-mac-release-to-s3.py", "latest-mac.yml", "appVersion"),
        ("upload-windows-release-to-s3.py", "latest.yml", "version"),
    ],
)
def test_older_release_rejects_incomplete_newer_rolling_channels(
    script_name: str,
    electron_manifest: str,
    version_key: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "stable-platform.json"
    path.write_text(json.dumps({version_key: "1.2.3"}), encoding="utf-8")
    client.objects["wework/stable-platform.json"] = json.dumps(
        {version_key: "1.2.4"}
    ).encode()

    with pytest.raises(SystemExit, match="Newer release channel 1.2.4 is incomplete"):
        module.release_advances_channel(
            client,
            "releases",
            "wework",
            path,
            (("wework", electron_manifest),),
        )


@pytest.mark.parametrize(
    ("script_name", "electron_manifest", "version_key"),
    [
        ("upload-mac-release-to-s3.py", "latest-mac.yml", "appVersion"),
        ("upload-windows-release-to-s3.py", "latest.yml", "version"),
    ],
)
def test_complete_same_version_rolling_channels_are_reused(
    script_name: str,
    electron_manifest: str,
    version_key: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "stable-platform.json"
    path.write_text(json.dumps({version_key: "1.2.3"}), encoding="utf-8")
    client.objects["wework/stable-platform.json"] = json.dumps(
        {version_key: "1.2.3"}
    ).encode()
    client.objects[f"wework/{electron_manifest}"] = b"version: 1.2.3\n"

    assert not module.release_advances_channel(
        client,
        "releases",
        "wework",
        path,
        (("wework", electron_manifest),),
    )


@pytest.mark.parametrize(
    (
        "script_name",
        "electron_manifest",
        "component_manifest",
    ),
    [
        (
            "upload-mac-release-to-s3.py",
            "latest-mac.yml",
            "components-stable-macos-arm64.json",
        ),
        (
            "upload-windows-release-to-s3.py",
            "latest.yml",
            "components-stable-windows-x64.json",
        ),
    ],
)
def test_channel_repair_publishes_rolling_pointer_last(
    script_name: str,
    electron_manifest: str,
    component_manifest: str,
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    channel_manifest = tmp_path / "stable-windows-x86_64.json"
    version_key = "version"
    if script_name == "upload-mac-release-to-s3.py":
        channel_manifest = tmp_path / component_manifest
        version_key = "appVersion"
    channel_manifest.write_text(json.dumps({version_key: "1.2.3"}), encoding="utf-8")
    (tmp_path / electron_manifest).write_text("version: 1.2.3\n", encoding="utf-8")
    remote_channel = f"wework/{channel_manifest.name}"
    client.objects[remote_channel] = json.dumps({version_key: "1.2.3"}).encode()
    uploaded = []
    monkeypatch.setattr(
        module,
        "upload_electron_manifest",
        lambda _client, _bucket, _prefix, path: uploaded.append(path.name),
    )
    if script_name == "upload-windows-release-to-s3.py":
        monkeypatch.setattr(
            module,
            "upload_channel_manifest",
            lambda _client, _bucket, _prefix, path: uploaded.append(path.name),
        )
    if script_name == "upload-mac-release-to-s3.py":
        repaired = module.publish_channel(
            client,
            "releases",
            "wework",
            tmp_path,
            "stable",
            "darwin-aarch64",
            lambda: uploaded.append(component_manifest),
        )
    else:
        repaired = module.publish_channel(
            client,
            "releases",
            "wework",
            tmp_path,
            "stable",
            lambda: uploaded.append(component_manifest),
        )

    assert repaired
    expected = [component_manifest, electron_manifest]
    if script_name == "upload-windows-release-to-s3.py":
        expected.insert(1, channel_manifest.name)
    assert uploaded == expected


def write_component_release(
    tmp_path: Path,
    platform: str = "macos",
    arch: str = "arm64",
    version: str = "1.2.3",
    source_sha: str = "a" * 40,
) -> None:
    components = {}
    for component_id in MANAGED_COMPONENT_IDS:
        content = component_id.encode()
        archive_sha256 = sha256(content).hexdigest()
        asset_name = (
            f"WeworkComponent_{component_id}_{archive_sha256}_{platform}_{arch}.tar.gz"
        )
        (tmp_path / asset_name).write_bytes(content)
        components[component_id] = {
            "version": "fixture",
            "contentSha256": "b" * 64,
            "archiveSha256": archive_sha256,
            "archiveBytes": len(content),
            "assetName": asset_name,
            "releaseScope": COMPONENT_RELEASE_SCOPES[component_id],
            "entryPath": ".",
        }
    (tmp_path / f"components-{platform}-{arch}.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "appVersion": version,
                "platform": platform,
                "arch": arch,
                "components": components,
            }
        ),
        encoding="utf-8",
    )
    for channel in ("stable", "beta"):
        (tmp_path / f"components-{channel}-{platform}-{arch}.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "appVersion": version,
                    "sourceSha": source_sha,
                    "channel": channel,
                    "platform": platform,
                    "arch": arch,
                    "capabilities": {"componentizedHostUpdate": 1},
                    "components": components,
                }
            ),
            encoding="utf-8",
        )


def test_component_assets_split_shared_and_release_specific_storage(
    tmp_path: Path,
) -> None:
    write_component_release(tmp_path)
    client = FakeClient()
    uploaded = []

    publish_component_assets(
        client,
        "releases",
        "wework/macos",
        "wework/components",
        load_component_assets(tmp_path, "macos", "arm64", "1.2.3"),
        lambda path, prefix: uploaded.append((path.name, prefix)),
    )

    assert [prefix for _, prefix in uploaded] == [
        "wework/components",
        "wework/macos",
        "wework/macos",
        "wework/macos",
        "wework/macos",
        "wework/components",
        "wework/components",
    ]


def test_reused_component_assets_do_not_require_local_archives(tmp_path: Path) -> None:
    write_component_release(tmp_path)
    descriptor_path = tmp_path / "components-macos-arm64.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    reused = descriptor["components"]["codex"]
    (tmp_path / reused["assetName"]).unlink()
    reused["reused"] = True
    reused["downloadUrl"] = f"https://minio.example/{reused['assetName']}"
    descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")

    assets = load_component_assets(tmp_path, "macos", "arm64", "1.2.3")

    assert {asset.component_id for asset in assets} == set(MANAGED_COMPONENT_IDS) - {
        "codex"
    }


def test_component_only_manifest_requires_the_same_installed_app_version(
    tmp_path: Path,
) -> None:
    write_component_release(tmp_path)
    client = FakeClient()
    manifest_name = "components-stable-macos-arm64.json"
    client.objects[f"wework/macos/{manifest_name}"] = json.dumps(
        {"appVersion": "1.2.4"}
    ).encode()

    with pytest.raises(SystemExit, match="advanced from 1.2.3 to 1.2.4"):
        publish_component_manifest(
            client,
            "releases",
            "wework/macos",
            tmp_path,
            "stable",
            "macos",
            "arm64",
            "1.2.3",
            "a" * 40,
            True,
            False,
            lambda _path, _prefix: None,
        )


def test_component_only_manifest_replaces_the_same_app_version(
    tmp_path: Path,
) -> None:
    write_component_release(tmp_path)
    client = FakeClient()
    manifest_name = "components-stable-macos-arm64.json"
    client.objects[f"wework/macos/{manifest_name}"] = json.dumps(
        {"appVersion": "1.2.3", "sourceSha": "0" * 40}
    ).encode()
    uploaded = []

    published = publish_component_manifest(
        client,
        "releases",
        "wework/macos",
        tmp_path,
        "stable",
        "macos",
        "arm64",
        "1.2.3",
        "a" * 40,
        True,
        False,
        lambda path, prefix: uploaded.append((path.name, prefix)),
    )

    assert published
    assert uploaded == [(manifest_name, "wework/macos")]


def test_component_only_secondary_channel_keeps_a_different_app_version(
    tmp_path: Path,
) -> None:
    write_component_release(tmp_path)
    client = FakeClient()
    manifest_name = "components-beta-macos-arm64.json"
    client.objects[f"wework/macos/{manifest_name}"] = json.dumps(
        {"appVersion": "1.2.4-beta.1"}
    ).encode()
    uploaded = []

    published = publish_component_manifest(
        client,
        "releases",
        "wework/macos",
        tmp_path,
        "beta",
        "macos",
        "arm64",
        "1.2.3",
        "a" * 40,
        True,
        True,
        lambda path, prefix: uploaded.append((path, prefix)),
    )

    assert not published
    assert uploaded == []


def test_versioned_release_assets_are_immutable(tmp_path: Path) -> None:
    artifact = tmp_path / "WeWork_1.2.3_darwin-aarch64.dmg"
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


def test_release_artifacts_include_full_and_componentized_host_packages(
    tmp_path: Path,
) -> None:
    version = "1.2.3"
    expected = [
        tmp_path / f"WeWork_{version}_darwin-aarch64.zip",
        tmp_path / f"WeWork_{version}_darwin-aarch64.zip.blockmap",
        tmp_path / f"WeWorkHostUpdate_{version}_darwin-aarch64.zip",
        tmp_path / f"WeWorkHostUpdate_{version}_darwin-aarch64.zip.blockmap",
    ]
    for path in expected:
        path.write_bytes(path.name.encode())
    (tmp_path / f"Other_{version}.zip").write_bytes(b"ignored")

    assert load_release_artifacts(tmp_path, version) == sorted(expected)


def test_minio_macos_build_uses_electron_only_release_assets() -> None:
    script = (SCRIPT_DIR / "build-minio-mac-release.sh").read_text(encoding="utf-8")
    preparer = (SCRIPT_DIR / "prepare-desktop-release-assets.mjs").read_text(
        encoding="utf-8"
    )

    assert "pnpm --filter wework build:release" in script
    assert "prepare-desktop-release-assets.mjs" in script
    assert "generate-desktop-update-manifests.mjs" in script
    assert 'WEWORK_RELEASE_TARGETS="macos-$arch"' in script
    assert 'WEWORK_COMPONENT_BASE_URL="$COMPONENT_BASE_URL"' in script
    assert '--release-kind) RELEASE_KIND="$2"' in script
    assert '"$notes_path" "$SOURCE_SHA"' in script
    assert 'WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL"' in script
    assert 'WEWORK_RUNTIME_TARGET="$MACOS_BUILD_TARGET"' in script
    assert 'WEWORK_BRAND_CONFIG="$BRAND_CONFIG"' in script
    assert 'WEWORK_RELEASE_VERSION="$VERSION"' in script
    assert 'WEWORK_SOURCE_SHA="$SOURCE_SHA"' in script
    assert "WeWork_${VERSION}_$(release_platform).dmg" in script
    assert "WeWork_${VERSION}_$(release_platform).zip" in script
    assert "WeWorkHostUpdate_${VERSION}_$(release_platform).zip" in script
    assert "WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS" in script
    assert "WEWORK_RELEASE_COMPONENT_ASSET_SOURCE=packaged-macos-app" in script
    assert 'WEWORK_USE_COMPONENTIZED_HOST_UPDATE="$COMPONENTIZED_HOST_UPDATE"' in script
    assert "components-$CHANNEL-macos-$arch.json" in script
    assert "const releaseBaseName = `WeWork_${version}_${releasePlatform}`" in preparer
    assert "cp(dmg, join(output, basename(dmg)))" not in preparer
    assert "cp(zip, join(output, basename(zip)))" not in preparer
    assert "WEWORK_NOTARYTOOL_S3_ACCELERATION" in script
    assert "WEWORK_CUSTOM_MACOS_NOTARIZATION" in script
    assert (
        'component_signing_identity="${APPLE_SIGNING_IDENTITY:-${CSC_NAME:-}}"'
        in script
    )
    assert 'export APPLE_SIGNING_IDENTITY="$component_signing_identity"' in script
    assert (
        "APPLE_SIGNING_IDENTITY or CSC_NAME is required to sign bundled components."
        in script
    )
    assert "--resume-signed-app" in script
    assert "--signed-app-only" in script
    assert "--upload-existing" in script
    assert "WEWORK_RELEASE_DIR_ONLY" in script
    assert "WEWORK_SKIP_MACOS_NOTARIZATION" in script
    assert "package-prebuilt-macos-release.mjs" in script
    assert 'pnpm --dir "$WEWORK_DIR/electron" install --frozen-lockfile' in script
    assert "WEWORK_PREVIOUS_COMPONENT_MANIFEST" in script
    assert "wework_configure_internal_updater_key" not in script
    assert "sync-desktop-release-version.mjs" not in script
    assert "VERSION_BACKUP_DIR" not in script
    assert "package.json" not in script
    assert "src-tauri" not in script
    assert "pnpm exec tauri build" not in script


def test_minio_windows_build_uses_native_electron_release() -> None:
    script = (SCRIPT_DIR / "build-minio-windows-release.sh").read_text(encoding="utf-8")
    preparer = (SCRIPT_DIR / "prepare-desktop-release-assets.mjs").read_text(
        encoding="utf-8"
    )

    assert "pnpm --filter wework build:release" in script
    assert "prepare-desktop-release-assets.mjs" in script
    assert "generate-desktop-update-manifests.mjs" in script
    assert "WEWORK_RELEASE_TARGETS=windows-x64" in script
    assert "WeWork_${VERSION}_windows-x64-setup.exe" in script
    assert "WeWorkHostUpdate_${VERSION}_windows-x64-setup.exe" in script
    assert "WeWork_${VERSION}_windows-x64.md" in script
    assert "windows_" + "x64" not in script
    assert "windows-${arch}-setup" in preparer
    assert "windows_${arch}-setup" not in preparer
    assert 'WEWORK_COMPONENT_BASE_URL="$COMPONENT_BASE_URL"' in script
    assert '--release-kind) RELEASE_KIND="$2"' in script
    assert '"$notes_path" "$SOURCE_SHA"' in script
    assert 'WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL"' in script
    assert 'WEWORK_RUNTIME_TARGET="$WINDOWS_BUILD_TARGET"' in script
    assert 'WEWORK_BRAND_CONFIG="$BRAND_CONFIG"' in script
    assert 'WEWORK_RELEASE_VERSION="$VERSION"' in script
    assert 'WEWORK_SOURCE_SHA="$SOURCE_SHA"' in script
    assert "WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS" in script
    assert 'WEWORK_USE_COMPONENTIZED_HOST_UPDATE="$COMPONENTIZED_HOST_UPDATE"' in script
    assert "components-$CHANNEL-windows-x64.json" in script
    assert '--unsigned) UNSIGNED="true"' in script
    assert 'if [ "$UNSIGNED" = "true" ]' in script
    assert "export CSC_IDENTITY_AUTO_DISCOVERY=false" in script
    assert "unset WIN_CSC_LINK" in script
    assert "wework_configure_internal_updater_key" not in script
    assert "Tauri updater bridge" not in script
    assert "node -p process.platform" in script
    assert "sync-desktop-release-version.mjs" not in script
    assert "VERSION_BACKUP_DIR" not in script
    assert "package.json" not in script
    assert "cargo-xwin" not in script
    assert "src-tauri" not in script
    assert "pnpm exec tauri build" not in script


def test_windows_jenkins_pipeline_builds_unsigned_with_the_tauri_bridge() -> None:
    pipeline = (SCRIPT_DIR.parent / "jenkins/windows-release/Jenkinsfile").read_text(
        encoding="utf-8"
    )

    assert "label 'windows'" in pipeline
    assert "C:\\\\Windows\\\\System32\\\\cmd.exe" in pipeline
    assert "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe" in pipeline
    assert "build-minio-windows-release.sh" in pipeline
    assert "--unsigned" in pipeline
    assert "WEWORK_UPDATER_KEY_PATH" in pipeline
    assert "Required legacy updater key file is missing or empty" in pipeline
    assert "WeWork_${version}_windows-x64-setup.exe" in pipeline
    assert "WeWorkHostUpdate_${version}_windows-x64-setup.exe" in pipeline
    assert "windows_" + "x64" not in pipeline
    assert "windows-x86_64" in pipeline
    assert "latest.json" in pipeline
    assert "archiveArtifacts" in pipeline
    assert "wegent-windows-signing-pfx" not in pipeline
    assert "wegent-windows-signing-password" not in pipeline
    assert "pwsh.exe" in pipeline
    assert "\n        powershell" not in pipeline.lower()


@pytest.mark.parametrize(
    "script_name",
    ["upload-mac-release-to-s3.py", "upload-windows-release-to-s3.py"],
)
def test_minio_uploads_component_assets_without_legacy_runtime_sidecars(
    script_name: str,
) -> None:
    script = (SCRIPT_DIR / script_name).read_text(encoding="utf-8")

    assert "upload_electron_manifest" in script
    assert "publish_component_assets" in script
    assert "publish_component_manifest" in script
    assert "load_release_artifacts" in script
    assert "publish_runtime_asset_pairs" not in script


def test_electron_release_bakes_the_minio_update_base_url() -> None:
    builder = (SCRIPT_DIR.parent / "electron/electron-builder.config.cjs").read_text(
        encoding="utf-8"
    )
    main = (SCRIPT_DIR.parent / "electron/src/main.ts").read_text(encoding="utf-8")

    assert "weworkUpdateBaseUrl: updateBaseUrl" in builder
    assert "packageMetadata.weworkUpdateBaseUrl?.trim()" in main


def test_harness_runtime_install_uses_the_requested_target_platform() -> None:
    script = (SCRIPT_DIR / "prepare-harness-runtime.mjs").read_text(encoding="utf-8")

    assert "WEWORK_RUNTIME_TARGET" in script
    assert "dsh-runtime-tar-gzip-v10" in script
    assert ".update(runtimePlatform())" in script
    assert "current.runtimePlatform === runtimePlatform()" in script
    assert "supportedArchitectures" in script
    assert "--config.node-linker=hoisted" in script
    assert "from 'tar'" in script
    assert "run('tar'" not in script
    assert (
        "crossTargetRequested() && entry.name === 'pnpm-workspace.yaml'" not in script
    )
    assert "--ignore-scripts" in script
    assert "prepareTargetSpawnHelpers" in script


@pytest.mark.parametrize(
    ("build_script", "upload_script"),
    [
        ("build-minio-mac-release.sh", "upload-mac-release-to-s3.py"),
        ("build-minio-windows-release.sh", "upload-windows-release-to-s3.py"),
    ],
)
def test_minio_uploaders_use_an_isolated_uv_script(
    build_script: str, upload_script: str
) -> None:
    build = (SCRIPT_DIR / build_script).read_text(encoding="utf-8")
    uploader = (SCRIPT_DIR / upload_script).read_text(encoding="utf-8")

    assert f'uv run --script "$SCRIPT_DIR/{upload_script}"' in build
    assert 'uv run --project "$PROJECT_DIR/backend"' not in build
    assert '# dependencies = ["minio==7.2.20"]' in uploader


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
