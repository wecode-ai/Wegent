from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))


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


class FakeResponse:
    def __init__(self, content: bytes) -> None:
        self.content = content

    def read(self) -> bytes:
        return self.content

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
    "script",
    (
        "upload-mac-release-to-s3.py",
        "upload-windows-release-to-s3.py",
    ),
)
def test_runtime_assets_are_loaded_from_the_release_manifest(
    script: str, tmp_path: Path
) -> None:
    module = load_script(script)
    harness = tmp_path / "harness-runtime-macos-arm64-fixture.tar.gz"
    node = tmp_path / "node-runtime-macos-arm64-fixture.tar.gz"
    harness.write_bytes(b"harness")
    node.write_bytes(b"node")
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps(
            {
                "assets": [
                    {"kind": "harness", "name": harness.name},
                    {"kind": "node", "name": node.name},
                ]
            }
        ),
        encoding="utf-8",
    )

    assert module.load_runtime_assets(tmp_path) == [harness, node]


@pytest.mark.parametrize(
    "script",
    (
        "upload-mac-release-to-s3.py",
        "upload-windows-release-to-s3.py",
    ),
)
def test_runtime_asset_manifest_requires_both_runtime_kinds(
    script: str, tmp_path: Path
) -> None:
    module = load_script(script)
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps({"assets": [{"kind": "harness", "name": "harness.tar.gz"}]}),
        encoding="utf-8",
    )

    with pytest.raises(SystemExit, match="harness and node"):
        module.load_runtime_assets(tmp_path)


@pytest.mark.parametrize(
    "script",
    (
        "upload-mac-release-to-s3.py",
        "upload-windows-release-to-s3.py",
    ),
)
def test_runtime_asset_manifest_rejects_paths_outside_the_release_directory(
    script: str, tmp_path: Path
) -> None:
    module = load_script(script)
    (tmp_path / "release-runtime-assets.json").write_text(
        json.dumps(
            {
                "assets": [
                    {"kind": "harness", "name": "../harness-runtime.tar.gz"},
                    {"kind": "node", "name": "node-runtime.tar.gz"},
                ]
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(SystemExit, match="invalid asset name"):
        module.load_runtime_assets(tmp_path)
