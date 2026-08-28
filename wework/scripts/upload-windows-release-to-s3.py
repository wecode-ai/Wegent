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
from minio_component_assets import (
    ComponentRelease,
    component_channel_is_complete,
    load_component_release,
    publish_component_archives,
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
    installers = [artifact for artifact in artifacts if artifact.suffix == ".exe"]
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


def read_text_object(
    client: Minio, bucket: str, prefix: str, filename: str
) -> str | None:
    response = None
    try:
        response = client.get_object(bucket, storage_key(prefix, filename))
        return response.read().decode("utf-8")
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
    complete: bool = True,
) -> bool:
    if not path.is_file():
        raise SystemExit(f"Updater channel manifest not found: {path}")
    candidate = json.loads(path.read_text(encoding="utf-8"))
    current = read_manifest(client, bucket, prefix, path.name)
    if current is None:
        return True
    candidate_parts = version_parts(candidate["version"])
    current_parts = version_parts(current["version"])
    comparison = (candidate_parts > current_parts) - (candidate_parts < current_parts)
    if comparison > 0:
        return True
    if comparison == 0 and not complete:
        print(f"Repairing incomplete release channel: {candidate['version']}")
        return True
    if comparison < 0 and not complete:
        raise SystemExit(
            f"Newer release channel {current['version']} is incomplete; "
            f"refusing to replace it with {candidate['version']}"
        )
    print(
        f"Keeping newer or equal release channel: "
        f"s3://{bucket}/{storage_key(prefix, path.name)}"
    )
    return False


def electron_manifest_version(content: str, path: Path | None = None) -> str:
    match = re.search(r"(?m)^version:\s*['\"]?([^'\"\s]+)", content)
    if match is None:
        location = f" {path}" if path is not None else ""
        raise SystemExit(f"Electron updater manifest{location} has no version")
    return match.group(1)


def upload_electron_manifest(
    client: Minio,
    bucket: str,
    prefix: str,
    path: Path,
) -> None:
    if not path.is_file():
        raise SystemExit(f"Electron updater manifest not found: {path}")
    upload_file(client, bucket, prefix, path, "no-cache, no-store")


def release_channel_is_complete(
    client: Minio,
    bucket: str,
    prefix: str,
    version: str,
    channel_manifest: Path,
    electron_manifest: Path,
    component_release: ComponentRelease,
) -> bool:
    legacy = read_manifest(client, bucket, prefix, channel_manifest.name)
    electron = read_text_object(client, bucket, prefix, electron_manifest.name)
    try:
        electron_matches = (
            electron is not None and electron_manifest_version(electron) == version
        )
    except SystemExit:
        electron_matches = False
    return (
        legacy is not None
        and legacy.get("version") == version
        and electron_matches
        and component_channel_is_complete(
            client,
            bucket,
            prefix,
            component_release,
        )
    )


def publish_release_channel(
    client: Minio,
    bucket: str,
    prefix: str,
    version: str,
    channel: str,
    output_dir: Path,
    component_release: ComponentRelease,
) -> bool:
    channel_manifest = output_dir / f"{channel}-windows-x86_64.json"
    electron_channel = "latest" if channel == "stable" else "beta"
    electron_manifest = output_dir / f"{electron_channel}.yml"
    complete = release_channel_is_complete(
        client,
        bucket,
        prefix,
        version,
        channel_manifest,
        electron_manifest,
        component_release,
    )
    if not release_advances_channel(
        client,
        bucket,
        prefix,
        channel_manifest,
        complete,
    ):
        return False
    upload_file(
        client,
        bucket,
        prefix,
        component_release.channel_manifest,
        "no-cache, no-store",
    )
    upload_electron_manifest(client, bucket, prefix, electron_manifest)
    upload_channel_manifest(client, bucket, prefix, channel_manifest)
    return True


def publish_stable_bootstrap_manifest(
    client: Minio, bucket: str, prefix: str, path: Path
) -> None:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    entry = manifest["platforms"]["windows-x86_64"]
    manifest["platforms"]["stable-windows"] = entry
    manifest["platforms"]["beta-windows"] = entry
    content = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    object_name = storage_key(prefix, "latest.json")
    client.put_object(
        bucket,
        object_name,
        BytesIO(content),
        len(content),
        content_type="application/json",
        metadata={"Cache-Control": "no-cache, no-store"},
    )
    print(f"Published stable bootstrap manifest: s3://{bucket}/{object_name}")


def main() -> None:
    client = create_client(require_env("ATTACHMENT_S3_ENDPOINT"))
    bucket = require_env("ATTACHMENT_S3_BUCKET")
    prefix = os.environ.get("WEWORK_RELEASE_S3_PREFIX", "wework/windows")
    version = require_env("RELEASE_VERSION")
    channel = os.environ.get("RELEASE_CHANNEL", "stable")
    if channel not in {"stable", "beta"}:
        raise SystemExit(f"Unsupported Wework update channel: {channel}")
    output_dir = Path(require_env("RELEASE_OUTPUT_DIR"))

    if not client.bucket_exists(bucket):
        raise SystemExit(f"S3 bucket does not exist: {bucket}")

    artifacts = sorted(output_dir.glob(f"WeWork_{version}_*"))
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
    manifest = output_dir / "latest.json"
    if not manifest.is_file():
        raise SystemExit(f"Updater manifest not found: {manifest}")
    component_release = load_component_release(
        output_dir,
        version,
        channel,
        "windows",
        "x64",
    )
    publish_component_archives(
        client,
        bucket,
        prefix,
        component_release,
        lambda path: upload_file(
            client,
            bucket,
            prefix,
            path,
            "public, max-age=31536000, immutable",
        ),
    )
    advanced_channel = publish_release_channel(
        client,
        bucket,
        prefix,
        version,
        channel,
        output_dir,
        component_release,
    )
    if channel == "stable":
        beta_components = load_component_release(
            output_dir,
            version,
            "beta",
            "windows",
            "x64",
        )
        advanced_channel = (
            publish_release_channel(
                client,
                bucket,
                prefix,
                version,
                "beta",
                output_dir,
                beta_components,
            )
            or advanced_channel
        )
    if not advanced_channel:
        return
    if channel == "stable":
        publish_latest_installer(client, bucket, prefix, version, artifacts)
        publish_stable_bootstrap_manifest(client, bucket, prefix, manifest)
        print("Uploaded latest.json last so legacy clients stay on stable releases.")


if __name__ == "__main__":
    main()
