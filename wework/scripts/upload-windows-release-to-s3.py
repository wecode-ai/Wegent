# /// script
# requires-python = ">=3.13"
# dependencies = ["minio==7.2.20"]
# ///

from __future__ import annotations

import json
import mimetypes
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from minio import Minio
from minio.commonconfig import CopySource
from minio.error import S3Error
from minio_release_assets import (
    load_component_assets,
    load_release_artifacts,
    publish_component_assets,
    publish_component_manifest,
    publish_immutable_file,
)

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


def publish_latest_installer(
    client: Minio,
    bucket: str,
    prefix: str,
    version: str,
    artifacts: list[Path],
) -> None:
    installers = [
        artifact
        for artifact in artifacts
        if artifact.name.startswith(f"WeWork_{version}_") and artifact.suffix == ".exe"
    ]
    if len(installers) != 1:
        raise SystemExit(
            f"Expected exactly one Windows installer for version {version}, "
            f"found {len(installers)}"
        )

    versioned_name = installers[0].name
    installer_suffix = versioned_name.removeprefix(f"WeWork_{version}_")
    latest_name = f"WeWork_latest_{installer_suffix}"
    versioned_key = storage_key(prefix, versioned_name)
    latest_key = storage_key(prefix, latest_name)
    client.copy_object(
        bucket,
        latest_key,
        CopySource(bucket, versioned_key),
        metadata={
            "Content-Type": "application/vnd.microsoft.portable-executable",
            "Cache-Control": "no-cache, no-store",
        },
        metadata_directive="REPLACE",
    )
    print(f"Published latest Windows installer: s3://{bucket}/{latest_key}")


def read_manifest(
    client: Minio, bucket: str, prefix: str, filename: str
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
    candidate_version = candidate["appVersion"]
    current_version = current["appVersion"]
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
    prefix: str,
    output_dir: Path,
    channel: str,
    publish_components,
) -> bool:
    component_manifest = output_dir / f"components-{channel}-windows-x64.json"
    electron_channel = "latest" if channel == "stable" else "beta"
    electron_manifest = output_dir / f"{electron_channel}.yml"
    if not release_advances_channel(
        client,
        bucket,
        prefix,
        component_manifest,
        ((prefix, electron_manifest.name), (prefix, component_manifest.name)),
    ):
        return False
    publish_components()
    upload_electron_manifest(client, bucket, prefix, electron_manifest)
    return True


def main() -> None:
    client = create_client(require_env("ATTACHMENT_S3_ENDPOINT"))
    bucket = require_env("ATTACHMENT_S3_BUCKET")
    prefix = os.environ.get("WEWORK_RELEASE_S3_PREFIX", "wework/windows")
    version = require_env("RELEASE_VERSION")
    source_sha = require_env("RELEASE_SOURCE_SHA")
    release_kind = os.environ.get("RELEASE_KIND", "full")
    if release_kind not in {"full", "component"}:
        raise SystemExit(f"Unsupported Wework release kind: {release_kind}")
    channel = os.environ.get("RELEASE_CHANNEL", "stable")
    if channel not in {"stable", "beta"}:
        raise SystemExit(f"Unsupported Wework update channel: {channel}")
    output_dir = Path(require_env("RELEASE_OUTPUT_DIR"))
    component_prefix = os.environ.get("WEWORK_COMPONENT_S3_PREFIX", "wework/components")

    if not client.bucket_exists(bucket):
        raise SystemExit(f"S3 bucket does not exist: {bucket}")

    component_assets = load_component_assets(output_dir, "windows", "x64", version)
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
        component_only: bool,
        allow_different_app_version: bool,
    ) -> bool:
        return publish_component_manifest(
            client,
            bucket,
            prefix,
            output_dir,
            target_channel,
            "windows",
            "x64",
            version,
            source_sha,
            component_only,
            allow_different_app_version,
            lambda path, target_prefix: upload_file(
                client, bucket, target_prefix, path, "no-cache, no-store"
            ),
        )

    if release_kind == "component":
        upload_component_channel(channel, True, False)
        if channel == "stable":
            upload_component_channel("beta", True, True)
        return

    artifacts = load_release_artifacts(output_dir, version)
    if not artifacts:
        raise SystemExit(f"No Windows release artifacts found for version {version}")
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
    advanced = publish_channel(
        client,
        bucket,
        prefix,
        output_dir,
        channel,
        lambda: upload_component_channel(channel, False, False),
    )
    if channel == "stable":
        publish_channel(
            client,
            bucket,
            prefix,
            output_dir,
            "beta",
            lambda: upload_component_channel("beta", False, False),
        )
    if channel != "stable" or not advanced:
        return
    publish_latest_installer(client, bucket, prefix, version, artifacts)


if __name__ == "__main__":
    main()
