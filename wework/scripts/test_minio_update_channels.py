from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

SCRIPT_DIR = Path(__file__).parent


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


def test_mac_stable_manifest_bootstraps_channel_targets() -> None:
    module = load_script("upload-mac-release-to-s3.py")
    client = FakeClient()
    entry = {"signature": "mac-signature", "url": "https://example.com/mac"}
    manifest = {
        "version": "1.2.3",
        "platforms": {"darwin-aarch64": entry},
    }

    module.publish_stable_bootstrap_manifest(
        client,
        "releases",
        "wework/macos",
        manifest,
        {"darwin-aarch64"},
    )

    published = json.loads(client.objects["wework/macos/latest.json"])
    assert published["platforms"]["darwin-aarch64"] == entry
    assert published["platforms"]["stable-darwin"] == entry
    assert published["platforms"]["beta-darwin"] == entry


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
