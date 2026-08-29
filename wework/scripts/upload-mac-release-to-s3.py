# /// script
# requires-python = ">=3.13"
# dependencies = ["minio==7.2.20"]
# ///

from __future__ import annotations

import json
import mimetypes
import os
import re
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

from minio import Minio
from minio.commonconfig import CopySource
from minio.error import S3Error
from minio_release_assets import (
    load_component_assets,
    publish_component_assets,
    publish_component_manifest,
    publish_immutable_file,
)

MACOS_PLATFORM_PREFIXES = {
    "darwin-aarch64": "WEWORK_MAC_ARM64_RELEASE_S3_PREFIX",
    "darwin-x86_64": "WEWORK_MAC_X64_RELEASE_S3_PREFIX",
}
VERSION_PATTERN = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-beta\.([1-9]\d*))?$")


def require_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def create_client(endpoint: str) -> Minio:
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit(f"Invalid ATTACHMENT_S3_ENDPOINT: {endpoint}")
    if parsed.path not in {"", "/"}:
        raise SystemExit("ATTACHMENT_S3_ENDPOINT must not include an object path")

    return Minio(
        parsed.netloc,
        access_key=require_env("ATTACHMENT_S3_ACCESS_KEY"),
        secret_key=require_env("ATTACHMENT_S3_SECRET_KEY"),
        secure=parsed.scheme == "https",
        region=os.environ.get("ATTACHMENT_S3_REGION", "us-east-1"),
    )


def storage_key(prefix: str, filename: str) -> str:
    return "/".join(part for part in (prefix.strip("/"), filename) if part)


def upload_file(
    client: Minio,
    bucket: str,
    prefix: str,
    path: Path,
    cache_control: str,
) -> None:
    object_name = storage_key(prefix, path.name)
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    client.fput_object(
        bucket,
        object_name,
        str(path),
        content_type=content_type,
        metadata={"Cache-Control": cache_control},
    )
    print(f"Uploaded: s3://{bucket}/{object_name}")


def publish_latest_dmg(
    client: Minio,
    bucket: str,
    prefix: str,
    version: str,
    artifacts: list[Path],
) -> None:
    dmg_files = [artifact for artifact in artifacts if artifact.suffix == ".dmg"]
    if len(dmg_files) != 1:
        raise SystemExit(
            f"Expected exactly one DMG for version {version}, found {len(dmg_files)}"
        )

    versioned_name = dmg_files[0].name
    platform_suffix = versioned_name.removeprefix(f"WeWork_{version}_")
    latest_name = f"WeWork_latest_{platform_suffix}"
    versioned_key = storage_key(prefix, versioned_name)
    latest_key = storage_key(prefix, latest_name)
    client.copy_object(
        bucket,
        latest_key,
        CopySource(bucket, versioned_key),
        metadata={
            "Content-Type": "application/x-apple-diskimage",
            "Cache-Control": "no-cache, no-store",
        },
        metadata_directive="REPLACE",
    )
    print(f"Published latest DMG: s3://{bucket}/{latest_key}")


def validate_manifest(path: Path, version: str, expected_platforms: set[str]) -> dict:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid updater manifest {path}: {error}") from error

    if manifest.get("version") != version:
        raise SystemExit(
            f"Updater manifest version must be {version}, got {manifest.get('version')!r}"
        )

    platforms = manifest.get("platforms")
    if not isinstance(platforms, dict):
        raise SystemExit("Updater manifest must contain a platforms object")

    missing_platforms = expected_platforms.difference(platforms)
    if missing_platforms:
        missing = ", ".join(sorted(missing_platforms))
        raise SystemExit(
            "Refusing to publish an incomplete macOS updater manifest; "
            f"missing platforms: {missing}"
        )
    return manifest


def read_manifest(
    client: Minio, bucket: str, prefix: str, filename: str = "latest.json"
) -> dict | None:
    response = None
    try:
        response = client.get_object(bucket, storage_key(prefix, filename))
        return json.loads(response.read().decode("utf-8"))
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject"}:
            return None
        raise
    finally:
        if response is not None:
            response.close()
            response.release_conn()


def version_parts(version: str) -> tuple[int, int, int, int, int]:
    match = VERSION_PATTERN.fullmatch(version)
    if match is None:
        raise SystemExit(f"Unsupported Wework version: {version}")
    major, minor, patch, beta = match.groups()
    return (
        int(major),
        int(minor),
        int(patch),
        1 if beta is None else 0,
        0 if beta is None else int(beta),
    )


def upload_channel_manifest(
    client: Minio,
    bucket: str,
    prefix: str,
    path: Path,
) -> None:
    if not path.is_file():
        raise SystemExit(f"Updater channel manifest not found: {path}")
    upload_file(client, bucket, prefix, path, "no-cache, no-store")


def release_advances_channel(
    client: Minio,
    bucket: str,
    prefix: str,
    path: Path,
    required_objects: tuple[tuple[str, str], ...] = (),
) -> bool:
    if not path.is_file():
        raise SystemExit(f"Updater channel manifest not found: {path}")
    candidate = json.loads(path.read_text(encoding="utf-8"))
    current = read_manifest(client, bucket, prefix, path.name)
    if current is None:
        return True
    candidate_version = candidate["version"]
    current_version = current["version"]
    if version_parts(candidate_version) > version_parts(current_version):
        return True

    complete = all(
        object_exists(client, bucket, object_prefix, filename)
        for object_prefix, filename in required_objects
    )
    if candidate_version == current_version and not complete:
        print(
            f"Repairing incomplete release channel at {candidate_version}: "
            f"s3://{bucket}/{storage_key(prefix, path.name)}"
        )
        return True
    if (
        version_parts(current_version) > version_parts(candidate_version)
        and not complete
    ):
        raise SystemExit(
            f"Newer release channel {current_version} is incomplete; "
            f"refusing to replace it with {candidate_version}"
        )

    print(
        f"Keeping newer or equal release channel: "
        f"s3://{bucket}/{storage_key(prefix, path.name)}"
    )
    return False


def object_exists(
    client: Minio,
    bucket: str,
    prefix: str,
    filename: str,
) -> bool:
    try:
        client.stat_object(bucket, storage_key(prefix, filename))
        return True
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject"}:
            return False
        raise


def upload_electron_manifest(
    client: Minio,
    bucket: str,
    prefix: str,
    path: Path,
) -> None:
    if not path.is_file():
        raise SystemExit(f"Electron updater manifest not found: {path}")
    upload_file(client, bucket, prefix, path, "no-cache, no-store")


def publish_channel(
    client: Minio,
    bucket: str,
    release_prefix: str,
    manifest_prefix: str,
    output_dir: Path,
    channel: str,
    platform: str,
    publish_components,
) -> bool:
    operating_system, architecture = platform.split("-", 1)
    channel_manifest = output_dir / f"{channel}-{operating_system}-{architecture}.json"
    component_arch = "arm64" if architecture == "aarch64" else "x64"
    component_manifest = (
        output_dir / f"components-{channel}-macos-{component_arch}.json"
    )
    electron_channel = "latest" if channel == "stable" else "beta"
    electron_manifest = output_dir / f"{electron_channel}-mac.yml"
    if not release_advances_channel(
        client,
        bucket,
        manifest_prefix,
        channel_manifest,
        (
            (release_prefix, electron_manifest.name),
            (release_prefix, component_manifest.name),
        ),
    ):
        return False
    publish_components()
    upload_electron_manifest(client, bucket, release_prefix, electron_manifest)
    upload_channel_manifest(client, bucket, manifest_prefix, channel_manifest)
    return True


def publish_legacy_manifest(
    client: Minio,
    bucket: str,
    version: str,
    manifest_prefix: str,
) -> None:
    manifests = {}
    for platform, prefix_env in MACOS_PLATFORM_PREFIXES.items():
        prefix = os.environ.get(prefix_env, "")
        manifest = read_manifest(client, bucket, prefix)
        if manifest is None or manifest.get("version") != version:
            print(
                f"Legacy manifest unchanged: {platform} release {version} "
                f"is not available under s3://{bucket}/{prefix}."
            )
            return
        platforms = manifest.get("platforms", {})
        if platform not in platforms:
            raise SystemExit(
                f"Manifest under s3://{bucket}/{prefix} is missing {platform}"
            )
        manifests[platform] = manifest

    for platform, manifest in manifests.items():
        operating_system, architecture = platform.split("-", 1)
        channel_manifest = read_manifest(
            client,
            bucket,
            manifest_prefix,
            f"stable-{operating_system}-{architecture}.json",
        )
        expected_entry = manifest["platforms"][platform]
        if (
            channel_manifest is None
            or channel_manifest.get("version") != version
            or channel_manifest.get("platforms", {}).get(f"stable-{operating_system}")
            != expected_entry
        ):
            raise SystemExit(
                "Refusing to publish the legacy macOS manifest before the "
                f"stable channel manifest for {platform} is available under "
                f"s3://{bucket}/{manifest_prefix}."
            )

    arm_manifest = manifests["darwin-aarch64"]
    legacy_manifest = {
        "version": version,
        "notes": arm_manifest.get("notes"),
        "pub_date": arm_manifest.get("pub_date"),
        "platforms": {
            platform: manifests[platform]["platforms"][platform]
            for platform in MACOS_PLATFORM_PREFIXES
        },
    }
    content = (
        json.dumps(legacy_manifest, ensure_ascii=False, indent=2) + "\n"
    ).encode()
    legacy_prefix = os.environ.get(
        "WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX", "wework/macos"
    )
    object_name = storage_key(legacy_prefix, "latest.json")
    client.put_object(
        bucket,
        object_name,
        BytesIO(content),
        len(content),
        content_type="application/json",
        metadata={"Cache-Control": "no-cache, no-store"},
    )
    print(f"Published legacy macOS updater manifest: s3://{bucket}/{object_name}")


def main() -> None:
    client = create_client(require_env("ATTACHMENT_S3_ENDPOINT"))
    bucket = require_env("ATTACHMENT_S3_BUCKET")
    prefix = os.environ.get("WEWORK_RELEASE_S3_PREFIX", "wework/macos")
    manifest_prefix = os.environ.get("WEWORK_UPDATE_MANIFEST_S3_PREFIX", prefix)
    version = require_env("RELEASE_VERSION")
    source_sha = require_env("RELEASE_SOURCE_SHA")
    release_kind = os.environ.get("RELEASE_KIND", "full")
    if release_kind not in {"full", "component"}:
        raise SystemExit(f"Unsupported Wework release kind: {release_kind}")
    channel = os.environ.get("RELEASE_CHANNEL", "stable")
    if channel not in {"stable", "beta"}:
        raise SystemExit(f"Unsupported Wework update channel: {channel}")
    expected_platforms = set(require_env("UPDATER_PLATFORMS").split(","))
    output_dir = Path(require_env("RELEASE_OUTPUT_DIR"))
    component_prefix = os.environ.get("WEWORK_COMPONENT_S3_PREFIX", "wework/components")

    if not client.bucket_exists(bucket):
        raise SystemExit(f"S3 bucket does not exist: {bucket}")

    platform_details = {
        "darwin-aarch64": ("macos", "arm64"),
        "darwin-x86_64": ("macos", "x64"),
    }
    component_targets = [platform_details[platform] for platform in expected_platforms]
    component_assets = []
    for platform, arch in component_targets:
        component_assets.extend(
            load_component_assets(output_dir, platform, arch, version)
        )
    publish_component_assets(
        client,
        bucket,
        prefix,
        component_prefix,
        component_assets,
        lambda path, target_prefix: upload_file(
            client,
            bucket,
            target_prefix,
            path,
            "public, max-age=31536000, immutable",
        ),
    )

    def upload_component_channel(
        target_channel: str,
        platform: str,
        arch: str,
        component_only: bool,
        allow_different_app_version: bool,
    ) -> bool:
        return publish_component_manifest(
            client,
            bucket,
            prefix,
            output_dir,
            target_channel,
            platform,
            arch,
            version,
            source_sha,
            component_only,
            allow_different_app_version,
            lambda path, target_prefix: upload_file(
                client, bucket, target_prefix, path, "no-cache, no-store"
            ),
        )

    if release_kind == "component":
        for platform, arch in component_targets:
            upload_component_channel(channel, platform, arch, True, False)
            if channel == "stable":
                upload_component_channel("beta", platform, arch, True, True)
        return

    artifacts = sorted(output_dir.glob(f"WeWork_{version}_*"))
    if not artifacts:
        raise SystemExit(f"No release artifacts found for version {version}")
    for artifact in artifacts:
        publish_immutable_file(
            client,
            bucket,
            prefix,
            artifact,
            lambda path: upload_file(
                client,
                bucket,
                prefix,
                path,
                "public, max-age=31536000, immutable",
            ),
        )
    manifest = output_dir / "latest.json"
    if not manifest.is_file():
        raise SystemExit(f"Updater manifest not found: {manifest}")
    validate_manifest(manifest, version, expected_platforms)

    stable_advanced = False
    for platform in expected_platforms:
        component_platform, component_arch = platform_details[platform]
        advanced = publish_channel(
            client,
            bucket,
            prefix,
            manifest_prefix,
            output_dir,
            channel,
            platform,
            lambda: upload_component_channel(
                channel,
                component_platform,
                component_arch,
                False,
                False,
            ),
        )
        if channel == "stable":
            stable_advanced = stable_advanced or advanced
            beta_advanced = publish_channel(
                client,
                bucket,
                prefix,
                manifest_prefix,
                output_dir,
                "beta",
                platform,
                lambda: upload_component_channel(
                    "beta",
                    component_platform,
                    component_arch,
                    False,
                    False,
                ),
            )

    if channel != "stable" or not stable_advanced:
        return
    publish_latest_dmg(client, bucket, prefix, version, artifacts)
    upload_file(client, bucket, prefix, manifest, "no-cache, no-store")
    print("Published the per-architecture legacy manifest after its release assets.")
    if len(expected_platforms) == 1 and expected_platforms.issubset(
        MACOS_PLATFORM_PREFIXES
    ):
        publish_legacy_manifest(client, bucket, version, manifest_prefix)


if __name__ == "__main__":
    main()
