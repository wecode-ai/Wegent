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
    load_runtime_asset_pairs,
    publish_runtime_asset_pairs,
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
    ("script_name", "electron_manifest"),
    [
        ("upload-mac-release-to-s3.py", "latest-mac.yml"),
        ("upload-windows-release-to-s3.py", "latest.yml"),
    ],
)
def test_same_version_repairs_incomplete_rolling_channels(
    script_name: str,
    electron_manifest: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "stable-platform.json"
    path.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    client.objects["wework/stable-platform.json"] = json.dumps(
        {"version": "1.2.3"}
    ).encode()

    assert module.release_advances_channel(
        client,
        "releases",
        "wework",
        path,
        (("wework", electron_manifest),),
    )


@pytest.mark.parametrize(
    ("script_name", "electron_manifest"),
    [
        ("upload-mac-release-to-s3.py", "latest-mac.yml"),
        ("upload-windows-release-to-s3.py", "latest.yml"),
    ],
)
def test_older_release_rejects_incomplete_newer_rolling_channels(
    script_name: str,
    electron_manifest: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "stable-platform.json"
    path.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    client.objects["wework/stable-platform.json"] = json.dumps(
        {"version": "1.2.4"}
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
    ("script_name", "electron_manifest"),
    [
        ("upload-mac-release-to-s3.py", "latest-mac.yml"),
        ("upload-windows-release-to-s3.py", "latest.yml"),
    ],
)
def test_complete_same_version_rolling_channels_are_reused(
    script_name: str,
    electron_manifest: str,
    tmp_path: Path,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    path = tmp_path / "stable-platform.json"
    path.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    client.objects["wework/stable-platform.json"] = json.dumps(
        {"version": "1.2.3"}
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
    ("script_name", "electron_manifest"),
    [
        ("upload-mac-release-to-s3.py", "latest-mac.yml"),
        ("upload-windows-release-to-s3.py", "latest.yml"),
    ],
)
def test_channel_repair_uploads_electron_manifest_before_channel_entry(
    script_name: str,
    electron_manifest: str,
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = load_script(script_name)
    client = FakeClient()
    channel_manifest = tmp_path / "stable-windows-x86_64.json"
    if script_name == "upload-mac-release-to-s3.py":
        channel_manifest = tmp_path / "stable-darwin-aarch64.json"
    channel_manifest.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
    (tmp_path / electron_manifest).write_text("version: 1.2.3\n", encoding="utf-8")
    remote_channel = f"wework/{channel_manifest.name}"
    client.objects[remote_channel] = json.dumps({"version": "1.2.3"}).encode()
    uploaded = []
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
        repaired = module.publish_channel(
            client,
            "releases",
            "wework",
            "wework",
            tmp_path,
            "stable",
            "darwin-aarch64",
        )
    else:
        repaired = module.publish_channel(
            client,
            "releases",
            "wework",
            tmp_path,
            "stable",
        )

    assert repaired
    assert uploaded == [electron_manifest, channel_manifest.name]


def write_runtime_pair(tmp_path: Path, kind: str, suffix: str) -> tuple[Path, Path]:
    archive = tmp_path / f"{kind}-runtime-macos-arm64-{suffix}.tar.gz"
    descriptor = archive.with_name(archive.name.removesuffix(".tar.gz") + ".json")
    content = kind.encode()
    archive.write_bytes(content)
    descriptor.write_text(
        json.dumps(
            {
                "assetName": archive.name,
                "archiveBytes": len(content),
                "archiveSha256": sha256(content).hexdigest(),
            }
        ),
        encoding="utf-8",
    )
    return archive, descriptor


def runtime_asset(kind: str, archive: Path, descriptor: Path) -> dict[str, str]:
    return {
        "kind": kind,
        "archiveName": archive.name,
        "descriptorName": descriptor.name,
    }


def test_runtime_asset_pairs_are_loaded_from_the_release_manifest(
    tmp_path: Path,
) -> None:
    harness_rc7 = write_runtime_pair(tmp_path, "harness", "rc7")
    harness_rc8 = write_runtime_pair(tmp_path, "harness", "rc8")
    node = write_runtime_pair(tmp_path, "node", "fixture")
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps(
            {
                "assets": [
                    runtime_asset("harness", *harness_rc7),
                    runtime_asset("harness", *harness_rc8),
                    runtime_asset("node", *node),
                ]
            }
        ),
        encoding="utf-8",
    )

    pairs = load_runtime_asset_pairs(tmp_path)
    assert [(pair.archive, pair.descriptor) for pair in pairs] == [
        harness_rc7,
        harness_rc8,
        node,
    ]


def test_runtime_asset_manifest_requires_node_and_harness_runtimes(
    tmp_path: Path,
) -> None:
    harness = write_runtime_pair(tmp_path, "harness", "fixture")
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps({"assets": [runtime_asset("harness", *harness)]}),
        encoding="utf-8",
    )

    with pytest.raises(SystemExit, match="one node and at least one harness"):
        load_runtime_asset_pairs(tmp_path)


def test_runtime_asset_manifest_rejects_paths_outside_the_release_directory(
    tmp_path: Path,
) -> None:
    node = write_runtime_pair(tmp_path, "node", "fixture")
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps(
            {
                "assets": [
                    {
                        "kind": "harness",
                        "archiveName": "../harness-runtime.tar.gz",
                        "descriptorName": "harness-runtime.json",
                    },
                    runtime_asset("node", *node),
                ]
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(SystemExit, match="invalid asset pair"):
        load_runtime_asset_pairs(tmp_path)


def test_runtime_asset_pairs_publish_archive_before_descriptor(
    tmp_path: Path,
) -> None:
    harness = write_runtime_pair(tmp_path, "harness", "fixture")
    node = write_runtime_pair(tmp_path, "node", "fixture")
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps(
            {
                "assets": [
                    runtime_asset("harness", *harness),
                    runtime_asset("node", *node),
                ]
            }
        ),
        encoding="utf-8",
    )
    client = FakeClient()
    uploaded = []

    publish_runtime_asset_pairs(
        client,
        "releases",
        "wework/macos",
        tmp_path,
        uploaded.append,
    )

    assert uploaded == [harness[0], harness[1], node[0], node[1]]


def test_runtime_asset_pairs_reuse_complete_publications(tmp_path: Path) -> None:
    harness = write_runtime_pair(tmp_path, "harness", "fixture")
    node = write_runtime_pair(tmp_path, "node", "fixture")
    assets = [
        runtime_asset("harness", *harness),
        runtime_asset("node", *node),
    ]
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps({"assets": assets}),
        encoding="utf-8",
    )
    client = FakeClient()
    for asset in assets:
        client.objects[f"wework/macos/{asset['archiveName']}"] = b"archive"
        client.objects[f"wework/macos/{asset['descriptorName']}"] = (
            tmp_path / asset["descriptorName"]
        ).read_bytes()

    uploaded = []
    publish_runtime_asset_pairs(
        client,
        "releases",
        "wework/macos",
        tmp_path,
        uploaded.append,
    )

    assert uploaded == []


def test_runtime_asset_pairs_reject_changed_published_descriptors(
    tmp_path: Path,
) -> None:
    harness = write_runtime_pair(tmp_path, "harness", "fixture")
    node = write_runtime_pair(tmp_path, "node", "fixture")
    assets = [
        runtime_asset("harness", *harness),
        runtime_asset("node", *node),
    ]
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps({"assets": assets}),
        encoding="utf-8",
    )
    client = FakeClient()
    client.objects[f"wework/macos/{harness[0].name}"] = harness[0].read_bytes()
    client.objects[f"wework/macos/{harness[1].name}"] = b"{}"

    with pytest.raises(SystemExit, match="descriptor does not match"):
        publish_runtime_asset_pairs(
            client,
            "releases",
            "wework/macos",
            tmp_path,
            lambda _path: None,
        )


def test_runtime_asset_pairs_migrate_matching_legacy_archives(tmp_path: Path) -> None:
    harness = write_runtime_pair(tmp_path, "harness", "fixture")
    node = write_runtime_pair(tmp_path, "node", "fixture")
    assets = [
        runtime_asset("harness", *harness),
        runtime_asset("node", *node),
    ]
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps({"assets": assets}),
        encoding="utf-8",
    )
    client = FakeClient()
    client.objects[f"wework/macos/{harness[0].name}"] = harness[0].read_bytes()
    uploaded = []

    publish_runtime_asset_pairs(
        client,
        "releases",
        "wework/macos",
        tmp_path,
        uploaded.append,
    )

    assert uploaded == [harness[1], node[0], node[1]]


def test_runtime_asset_pairs_reject_mismatched_legacy_archives(
    tmp_path: Path,
) -> None:
    harness = write_runtime_pair(tmp_path, "harness", "fixture")
    node = write_runtime_pair(tmp_path, "node", "fixture")
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps(
            {
                "assets": [
                    runtime_asset("harness", *harness),
                    runtime_asset("node", *node),
                ]
            }
        ),
        encoding="utf-8",
    )
    client = FakeClient()
    client.objects[f"wework/macos/{harness[0].name}"] = b"wrong"

    with pytest.raises(SystemExit, match="archive does not match"):
        publish_runtime_asset_pairs(
            client,
            "releases",
            "wework/macos",
            tmp_path,
            lambda _path: None,
        )


def test_runtime_asset_pairs_reject_descriptor_only_publications(
    tmp_path: Path,
) -> None:
    harness = write_runtime_pair(tmp_path, "harness", "fixture")
    node = write_runtime_pair(tmp_path, "node", "fixture")
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps(
            {
                "assets": [
                    runtime_asset("harness", *harness),
                    runtime_asset("node", *node),
                ]
            }
        ),
        encoding="utf-8",
    )
    client = FakeClient()
    client.objects[f"wework/macos/{harness[1].name}"] = harness[1].read_bytes()

    with pytest.raises(SystemExit, match="publication is incomplete"):
        publish_runtime_asset_pairs(
            client,
            "releases",
            "wework/macos",
            tmp_path,
            lambda _path: None,
        )


def test_minio_macos_build_uses_the_electron_release_and_tauri_bridge() -> None:
    script = (SCRIPT_DIR / "build-minio-mac-release.sh").read_text(encoding="utf-8")

    assert "pnpm --filter wework build:release" in script
    assert "prepare-desktop-release-assets.mjs" in script
    assert "generate-desktop-update-manifests.mjs" in script
    assert 'WEWORK_RELEASE_TARGETS="macos-$arch"' in script
    assert 'WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL"' in script
    assert 'WEWORK_RUNTIME_TARGET="$MACOS_BUILD_TARGET"' in script
    assert "wework_configure_internal_updater_key" in script
    assert "src-tauri" not in script
    assert "pnpm exec tauri build" not in script


def test_minio_windows_build_uses_native_electron_release_and_tauri_bridge() -> None:
    script = (SCRIPT_DIR / "build-minio-windows-release.sh").read_text(encoding="utf-8")

    assert "pnpm --filter wework build:release" in script
    assert "prepare-desktop-release-assets.mjs" in script
    assert "generate-desktop-update-manifests.mjs" in script
    assert "WEWORK_RELEASE_TARGETS=windows-x64" in script
    assert 'WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL"' in script
    assert 'WEWORK_RUNTIME_TARGET="$WINDOWS_BUILD_TARGET"' in script
    assert "node -p process.platform" in script
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


def test_electron_release_bakes_the_minio_update_base_url() -> None:
    builder = (SCRIPT_DIR.parent / "electron/electron-builder.config.cjs").read_text(
        encoding="utf-8"
    )
    main = (SCRIPT_DIR.parent / "electron/src/main.ts").read_text(encoding="utf-8")

    assert "weworkUpdateBaseUrl: updateBaseUrl" in builder
    assert "packageMetadata.weworkUpdateBaseUrl?.trim()" in main


def test_node_runtime_format_version_avoids_legacy_minio_asset_names() -> None:
    script = (SCRIPT_DIR / "prepare-execution-runtime.mjs").read_text(encoding="utf-8")

    assert "node-runtime-tar-gzip-v2" in script
    assert "WEWORK_RUNTIME_TARGET" in script
    assert "SHASUMS256.txt" in script
    assert "Target Node runtime has the wrong architecture" in script


def test_harness_runtime_install_uses_the_requested_target_platform() -> None:
    script = (SCRIPT_DIR / "prepare-harness-runtime.mjs").read_text(encoding="utf-8")

    assert "WEWORK_RUNTIME_TARGET" in script
    assert "dsh-runtime-tar-gzip-v5" in script
    assert "supportedArchitectures" in script
    assert "--ignore-scripts" in script
    assert "prepareTargetSpawnHelpers" in script


@pytest.mark.parametrize(
    ("script_name", "target", "expected"),
    [
        ("prepare-execution-runtime.mjs", "x86_64-apple-darwin", "macos-x64"),
        ("prepare-harness-runtime.mjs", "x86_64-apple-darwin", "macos-x64"),
        ("prepare-execution-runtime.mjs", "x86_64-pc-windows-msvc", "windows-x64"),
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
printf '%s\\n%s\\n%s\\n' \
  "$TAURI_SIGNING_PRIVATE_KEY" \
  "$TAURI_SIGNING_PRIVATE_KEY_PATH" \
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
        str(key_path),
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
