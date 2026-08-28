from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from urllib.parse import unquote, urlparse

from minio.error import S3Error

MANAGED_COMPONENT_IDS = (
    "coreDsh",
    "weworkCorePlugins",
    "bundledPlugins",
    "executor",
    "codex",
    "dws",
)


@dataclass(frozen=True)
class ComponentAsset:
    component_id: str
    path: Path
    archive_bytes: int
    archive_sha256: str


@dataclass(frozen=True)
class ComponentRelease:
    channel_manifest: Path
    channel_payload: dict
    assets: tuple[ComponentAsset, ...]


def load_component_release(
    output_dir: Path,
    version: str,
    channel: str,
    platform: str,
    arch: str,
) -> ComponentRelease:
    source_path = output_dir / f"components-{platform}-{arch}.json"
    channel_path = output_dir / f"components-{channel}-{platform}-{arch}.json"
    source = _read_json(source_path)
    channel_payload = _read_json(channel_path)

    _validate_manifest_identity(source, version, platform, arch)
    _validate_channel_identity(
        channel_payload,
        version,
        channel,
        platform,
        arch,
    )
    source_components = _components(source, source_path)
    channel_components = _components(channel_payload, channel_path)
    assets = []
    for component_id in MANAGED_COMPONENT_IDS:
        source_component = source_components[component_id]
        channel_component = channel_components[component_id]
        archive_sha256 = _sha256_field(
            source_component,
            "archiveSha256",
            source_path,
            component_id,
        )
        asset_name = source_component.get("assetName")
        expected_name = (
            f"WeworkComponent_{component_id}_{archive_sha256}_"
            f"{platform}_{arch}.tar.gz"
        )
        if asset_name != expected_name:
            raise SystemExit(
                f"Component asset name is invalid for {component_id}: {source_path}"
            )
        archive = output_dir / expected_name
        if not archive.is_file():
            raise SystemExit(f"Component archive not found: {archive}")
        archive_bytes = archive.stat().st_size
        if _file_sha256(archive) != archive_sha256:
            raise SystemExit(f"Component archive checksum mismatch: {archive}")

        download_url = channel_component.get("downloadUrl")
        if (
            not isinstance(download_url, str)
            or Path(unquote(urlparse(download_url).path)).name != expected_name
            or channel_component.get("archiveSha256") != archive_sha256
            or channel_component.get("archiveBytes") != archive_bytes
            or channel_component.get("contentSha256")
            != source_component.get("contentSha256")
            or channel_component.get("version") != source_component.get("version")
            or channel_component.get("entryPath") != source_component.get("entryPath")
        ):
            raise SystemExit(
                f"Rolling component manifest does not match {component_id}: "
                f"{channel_path}"
            )
        assets.append(
            ComponentAsset(
                component_id=component_id,
                path=archive,
                archive_bytes=archive_bytes,
                archive_sha256=archive_sha256,
            )
        )
    return ComponentRelease(
        channel_manifest=channel_path,
        channel_payload=channel_payload,
        assets=tuple(assets),
    )


def publish_component_archives(
    client: object,
    bucket: str,
    prefix: str,
    release: ComponentRelease,
    upload: Callable[[Path], None],
) -> None:
    for asset in release.assets:
        publish_immutable_file(
            client,
            bucket,
            prefix,
            asset.path,
            upload,
            asset.archive_bytes,
            asset.archive_sha256,
        )


def publish_immutable_file(
    client: object,
    bucket: str,
    prefix: str,
    path: Path,
    upload: Callable[[Path], None],
    expected_bytes: int | None = None,
    expected_sha256: str | None = None,
) -> None:
    archive_bytes = (
        expected_bytes if expected_bytes is not None else path.stat().st_size
    )
    archive_sha256 = expected_sha256 or _file_sha256(path)
    object_name = _storage_key(prefix, path.name)
    if not _object_exists(client, bucket, object_name):
        upload(path)
        return
    if not _remote_file_matches(
        client,
        bucket,
        object_name,
        archive_bytes,
        archive_sha256,
    ):
        raise SystemExit(
            f"Published immutable asset does not match local content: {path.name}"
        )
    print(f"Reusing immutable asset: {path.name}")


def component_channel_is_complete(
    client: object,
    bucket: str,
    prefix: str,
    release: ComponentRelease,
) -> bool:
    remote = _read_json_object(
        client,
        bucket,
        _storage_key(prefix, release.channel_manifest.name),
    )
    if remote is None or not _same_component_manifest(remote, release.channel_payload):
        return False
    for asset in release.assets:
        try:
            metadata = client.stat_object(
                bucket,
                _storage_key(prefix, asset.path.name),
            )
        except S3Error as error:
            if error.code in {"NoSuchKey", "NoSuchObject"}:
                return False
            raise
        if metadata.size != asset.archive_bytes:
            return False
    return True


def _validate_manifest_identity(
    manifest: dict,
    version: str,
    platform: str,
    arch: str,
) -> None:
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("appVersion") != version
        or manifest.get("platform") != platform
        or manifest.get("arch") != arch
    ):
        raise SystemExit("Component release descriptor has incompatible identity")


def _validate_channel_identity(
    manifest: dict,
    version: str,
    channel: str,
    platform: str,
    arch: str,
) -> None:
    _validate_manifest_identity(manifest, version, platform, arch)
    if manifest.get("channel") != channel:
        raise SystemExit("Rolling component manifest has an incompatible channel")


def _components(manifest: dict, path: Path) -> dict:
    components = manifest.get("components")
    if not isinstance(components, dict) or set(components) != set(
        MANAGED_COMPONENT_IDS
    ):
        raise SystemExit(
            f"Component manifest must contain exactly {', '.join(MANAGED_COMPONENT_IDS)}: "
            f"{path}"
        )
    if not all(isinstance(component, dict) for component in components.values()):
        raise SystemExit(f"Component manifest entries must be objects: {path}")
    return components


def _sha256_field(
    component: dict,
    field: str,
    path: Path,
    component_id: str,
) -> str:
    value = component.get(field)
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise SystemExit(f"Invalid {field} for component {component_id}: {path}")
    return value


def _same_component_manifest(remote: dict, local: dict) -> bool:
    return all(
        remote.get(field) == local.get(field)
        for field in ("schemaVersion", "appVersion", "channel", "platform", "arch")
    ) and remote.get("components") == local.get("components")


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid component manifest {path}: {error}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"Component manifest must be an object: {path}")
    return value


def _read_json_object(
    client: object,
    bucket: str,
    object_name: str,
) -> dict | None:
    response = None
    try:
        response = client.get_object(bucket, object_name)
        value = json.loads(response.read().decode("utf-8"))
        return value if isinstance(value, dict) else None
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject"}:
            return None
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    finally:
        if response is not None:
            response.close()
            response.release_conn()


def _object_exists(client: object, bucket: str, object_name: str) -> bool:
    try:
        client.stat_object(bucket, object_name)
        return True
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject"}:
            return False
        raise


def _remote_file_matches(
    client: object,
    bucket: str,
    object_name: str,
    expected_bytes: int,
    expected_sha256: str,
) -> bool:
    metadata = client.stat_object(bucket, object_name)
    if metadata.size != expected_bytes:
        return False
    response = client.get_object(bucket, object_name)
    digest = sha256()
    try:
        while chunk := response.read(64 * 1024):
            digest.update(chunk)
    finally:
        response.close()
        response.release_conn()
    return digest.hexdigest() == expected_sha256


def _file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as file:
        while chunk := file.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _storage_key(prefix: str, filename: str) -> str:
    return "/".join(part for part in (prefix.strip("/"), filename) if part)
