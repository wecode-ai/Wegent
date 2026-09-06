from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

COMPONENT_RELEASE_SCOPES = {
    "coreDsh": "shared",
    "weworkCorePlugins": "version",
    "weworkAppStatic": "version",
    "bundledPlugins": "version",
    "executor": "version",
    "codex": "shared",
    "dws": "shared",
}
MANAGED_COMPONENT_IDS = tuple(COMPONENT_RELEASE_SCOPES)


@dataclass(frozen=True)
class ComponentAsset:
    component_id: str
    archive: Path
    archive_bytes: int
    archive_sha256: str
    release_scope: str


def load_component_assets(
    output_dir: Path,
    platform: str,
    arch: str,
    version: str,
) -> list[ComponentAsset]:
    descriptor_path = output_dir / f"components-{platform}-{arch}.json"
    descriptor = _read_json(descriptor_path, "component descriptor")
    if (
        descriptor.get("schemaVersion") != 1
        or descriptor.get("appVersion") != version
        or descriptor.get("platform") != platform
        or descriptor.get("arch") != arch
    ):
        raise SystemExit(f"Invalid component descriptor metadata: {descriptor_path}")

    components = descriptor.get("components")
    if not isinstance(components, dict) or set(components) != set(
        MANAGED_COMPONENT_IDS
    ):
        raise SystemExit(
            "Component descriptor must contain exactly "
            f"{', '.join(MANAGED_COMPONENT_IDS)}: {descriptor_path}"
        )

    assets = []
    for component_id, component in components.items():
        if not isinstance(component_id, str) or not isinstance(component, dict):
            raise SystemExit(f"Invalid component descriptor entry: {descriptor_path}")
        asset_name = component.get("assetName")
        archive_sha256 = component.get("archiveSha256")
        release_scope = component.get("releaseScope")
        if (
            not isinstance(asset_name, str)
            or Path(asset_name).name != asset_name
            or not asset_name.endswith(".tar.gz")
            or not _is_sha256(archive_sha256)
            or release_scope != COMPONENT_RELEASE_SCOPES[component_id]
        ):
            raise SystemExit(
                f"Invalid component asset metadata for {component_id}: {descriptor_path}"
            )
        archive = output_dir / asset_name
        archive_bytes = archive.stat().st_size if archive.is_file() else 0
        if archive_bytes <= 0 or _file_sha256(archive) != archive_sha256:
            raise SystemExit(
                f"Component archive does not match its descriptor: {archive}"
            )
        assets.append(
            ComponentAsset(
                component_id=component_id,
                archive=archive,
                archive_bytes=archive_bytes,
                archive_sha256=archive_sha256,
                release_scope=release_scope,
            )
        )
    return assets


def publish_component_assets(
    client: object,
    bucket: str,
    release_prefix: str,
    shared_prefix: str,
    assets: list[ComponentAsset],
    upload: Callable[[Path, str], None],
) -> None:
    for asset in assets:
        prefix = shared_prefix if asset.release_scope == "shared" else release_prefix
        object_name = _storage_key(prefix, asset.archive.name)
        if _object_exists(client, bucket, object_name):
            if not _remote_file_matches(
                client,
                bucket,
                object_name,
                asset.archive_bytes,
                asset.archive_sha256,
            ):
                raise SystemExit(
                    f"Published component archive does not match {asset.archive.name}"
                )
            print(f"Reusing published component: {asset.archive.name}")
            continue
        upload(asset.archive, prefix)


def publish_immutable_file(
    client: object,
    bucket: str,
    prefix: str,
    path: Path,
    upload: Callable[[Path], None],
) -> None:
    object_name = _storage_key(prefix, path.name)
    archive_bytes = path.stat().st_size
    archive_sha256 = _file_sha256(path)
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


def load_release_artifacts(output_dir: Path, version: str) -> list[Path]:
    return sorted(
        {
            *output_dir.glob(f"WeWork_{version}_*"),
            *output_dir.glob(f"WeWorkHostUpdate_{version}_*"),
        }
    )


def publish_component_manifest(
    client: object,
    bucket: str,
    prefix: str,
    output_dir: Path,
    channel: str,
    platform: str,
    arch: str,
    version: str,
    source_sha: str,
    component_only: bool,
    allow_different_app_version: bool,
    upload: Callable[[Path, str], None],
) -> bool:
    path = output_dir / f"components-{channel}-{platform}-{arch}.json"
    manifest = _read_json(path, "component manifest")
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("appVersion") != version
        or manifest.get("sourceSha") != source_sha
        or manifest.get("channel") != channel
        or manifest.get("platform") != platform
        or manifest.get("arch") != arch
        or manifest.get("capabilities", {}).get("componentizedHostUpdate") != 1
        or not isinstance(manifest.get("components"), dict)
        or set(manifest["components"]) != set(MANAGED_COMPONENT_IDS)
    ):
        raise SystemExit(f"Invalid component manifest metadata: {path}")

    if component_only:
        current = _read_remote_json(
            client,
            bucket,
            _storage_key(prefix, path.name),
        )
        if current is None:
            raise SystemExit(
                f"Cannot publish components without an existing {channel} app release"
            )
        current_version = current.get("appVersion")
        if current_version != version:
            if allow_different_app_version:
                print(
                    f"Keeping {channel} component manifest at app version "
                    f"{current_version}."
                )
                return False
            raise SystemExit(
                f"The {channel} channel advanced from {version} to "
                f"{current_version} while components were building"
            )

    upload(path, prefix)
    return True


def _object_exists(client: object, bucket: str, object_name: str) -> bool:
    from minio.error import S3Error

    try:
        client.stat_object(bucket, object_name)
        return True
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject"}:
            return False
        raise


def _read_json(path: Path, description: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid {description} {path}: {error}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"Invalid {description}: {path}")
    return value


def _read_remote_json(
    client: object,
    bucket: str,
    object_name: str,
) -> dict | None:
    from minio.error import S3Error

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


def _file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as file:
        while chunk := file.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdefABCDEF" for character in value)
    )


def _storage_key(prefix: str, filename: str) -> str:
    return "/".join(part for part in (prefix.strip("/"), filename) if part)


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
